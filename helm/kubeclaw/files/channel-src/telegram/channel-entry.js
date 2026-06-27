/* eslint-disable */
/**
 * Telegram channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: Telegram Bot API via telegraf@4 (long-poll transport).
 * The adapter performs no native compilation (telegraf is pure JS).
 *
 * JID format:
 *   telegram:<chatId>                 — private chat (positive integer)
 *   telegram:<chatId>                 — group/supergroup (negative integer)
 *
 * Config (from the channel Secret / env):
 *   TELEGRAM_BOT_TOKEN      the bot token from @BotFather (required)
 *   TELEGRAM_BOT_USERNAME   optional — the bot's @handle (not used at runtime
 *                           but stored so bootstrap skills can reference it)
 *
 * Inbound: long-poll via bot.launch(). Handles text messages only in v1;
 * media-only messages with no caption are silently dropped.
 *
 * Outbound: bot.telegram.sendMessage(); chunks at 4096 chars (Telegram's limit).
 *
 * The telegraf import is lazy (inside connect()) so that unit tests can inject
 * a fake bot via this._makeBot without ever loading the telegraf package.
 */

const MAX_MESSAGE_LENGTH = 4096;

class TelegramChannel {
  name = 'telegram';
  capabilities = {
    typing: true,
    inboundImages: true,
    inboundPdfs: true,
    inboundVoice: true,
    outboundMedia: false,
  };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.bot = null;
    this.connected = false;
    this.messageId = 0;
    // Injectable in tests: (token) => bot instance. Set in connect() when null.
    this._makeBot = null;
  }

  // ── JID helpers ──────────────────────────────────────────────────────────
  ownsJid(jid) {
    return typeof jid === 'string' && jid.startsWith('telegram:');
  }

  /**
   * Map a Telegraf message context to a normalized inbound descriptor,
   * or return null to skip the message.
   */
  buildInbound(ctx) {
    const chat = ctx.chat;
    const from = ctx.from;
    if (!chat || !from) return null;
    if (from.is_bot) return null; // echo guard — ignore own bot and other bots

    const jid = `telegram:${chat.id}`;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const senderName =
      from.username ||
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      String(from.id);
    const chatName = chat.title || senderName;
    const text = ctx.message?.text ?? ctx.message?.caption ?? '';

    return {
      jid,
      isGroup,
      senderName,
      chatName,
      sender: String(from.id),
      text,
    };
  }

  // ── Inbound handling ──────────────────────────────────────────────────────
  handleCtx(ctx) {
    const inb = this.buildInbound(ctx);
    if (!inb) return;

    // Only handle messages for registered groups/chats.
    const registered = this.opts.registeredGroups()[inb.jid];
    if (!registered) {
      this.sdk.logger.debug({ jid: inb.jid }, 'telegram: unregistered chat');
      return;
    }

    let content = inb.text;

    // Group trigger rewrite: if message contains @AssistantName but doesn't
    // start with it, prepend "@AssistantName " so the runtime trigger fires.
    if (inb.isGroup && this.sdk.assistantName && content) {
      const esc = this.sdk.assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const triggerRegex = new RegExp(`^@${esc}\\b`, 'i');
      const mentionRegex = new RegExp(`@${esc}\\b`, 'i');
      if (mentionRegex.test(content) && !triggerRegex.test(content)) {
        content = `@${this.sdk.assistantName} ${content}`;
      }
    }

    // v1: media-only messages with no text/caption → surface nothing.
    if (!content) return;

    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();

    this.opts.onChatMetadata(
      inb.jid,
      timestamp,
      inb.chatName,
      'telegram',
      inb.isGroup,
    );
    this.opts.onMessage(inb.jid, {
      id: `${ts}-${++this.messageId}`,
      chat_jid: inb.jid,
      sender: inb.sender,
      sender_name: inb.senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async connect() {
    // Lazy telegraf import — only loaded here so unit tests never need the dep.
    const makeBot =
      this._makeBot ??
      (async (token) => {
        const { Telegraf } = await import('telegraf');
        return new Telegraf(token);
      });

    this.bot = await makeBot(this.config.token);

    this.bot.on('message', (ctx) => {
      try {
        this.handleCtx(ctx);
      } catch (err) {
        this.sdk.logger.warn(
          { err: String(err) },
          'telegram: handleCtx failed',
        );
      }
    });

    await this.bot.launch(); // long-poll; resolves once polling starts
    this.connected = true;
    this.sdk.logger.info('telegram: connected (long-poll)');
  }

  // ── Chunking helper ───────────────────────────────────────────────────────
  chunk(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    for (let i = 0; i < text.length; i += max) {
      out.push(text.slice(i, i + max));
    }
    return out;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async sendMessage(jid, text) {
    if (!this.ownsJid(jid)) return;
    if (!this.bot) {
      this.sdk.logger.warn(
        { jid },
        'telegram: sendMessage called but bot not connected',
      );
      return;
    }
    const chatId = jid.slice('telegram:'.length);
    for (const c of this.chunk(text, MAX_MESSAGE_LENGTH)) {
      try {
        await this.bot.telegram.sendMessage(chatId, c);
      } catch (err) {
        this.sdk.logger.error(
          { jid, err: String(err) },
          'telegram: send failed',
        );
      }
    }
  }

  async setTyping(jid, isTyping) {
    if (!this.ownsJid(jid) || !this.bot || !isTyping) return;
    try {
      await this.bot.telegram.sendChatAction(
        jid.slice('telegram:'.length),
        'typing',
      );
    } catch (err) {
      this.sdk.logger.debug({ err: String(err) }, 'telegram: typing failed');
    }
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // ignore stop errors
      }
      this.bot = null;
    }
  }
}

// ── Config parser ─────────────────────────────────────────────────────────────
function parseConfig(sdk) {
  const env = sdk.readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']);
  const token = (
    process.env.TELEGRAM_BOT_TOKEN ||
    env.TELEGRAM_BOT_TOKEN ||
    ''
  ).trim();
  if (!token) {
    sdk.logger.warn('telegram: TELEGRAM_BOT_TOKEN is required');
    return null;
  }
  return {
    token,
    botUsername:
      process.env.TELEGRAM_BOT_USERNAME || env.TELEGRAM_BOT_USERNAME || '',
  };
}

// ── Registration ──────────────────────────────────────────────────────────────
export default function register(sdk) {
  sdk.registerChannel('telegram', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new TelegramChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { TelegramChannel, parseConfig };
