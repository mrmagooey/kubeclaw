/* eslint-disable */
/**
 * Discord channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: discord.js@14 (Gateway WebSocket transport).
 * The adapter performs lazy import inside connect() so unit tests never load discord.js.
 *
 * JID format:
 *   discord:<channelId>   — guild text channel (positive snowflake string)
 *   discord:<channelId>   — DM channel (snowflake string for the DM channel)
 *
 * Config (from the channel Secret / env):
 *   DISCORD_BOT_TOKEN   the bot token from the Discord Developer Portal (required)
 *
 * Inbound: Gateway WebSocket via discord.js Client.login().
 *   Intents: Guilds, GuildMessages, MessageContent, DirectMessages
 *   Partials: Channel (required for DMs)
 *
 * IMPORTANT — MessageContent is a PRIVILEGED intent. You must enable it in the
 * Discord Developer Portal under your application → Bot → Privileged Gateway Intents.
 * If it is not enabled, guild messages will arrive with empty content — the adapter
 * logs a warning with instructions in that case.
 *
 * Outbound: channel.send(); chunks at 2000 chars (Discord's limit).
 *
 * The discord.js import is lazy (inside connect()) so that unit tests can inject
 * a fake client via this._makeClient without ever loading the discord.js package.
 */

const MAX_MESSAGE_LENGTH = 2000;

class DiscordChannel {
  name = 'discord';
  capabilities = {
    typing: true,
    inboundImages: true,
    inboundPdfs: true,
    markdownOutput: true,
    outboundMedia: false,
  };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.client = null;
    this.connected = false;
    this.messageId = 0;
    // Injectable in tests: (token) => client instance. Set in connect() when null.
    this._makeClient = null;
  }

  // ── JID helpers ──────────────────────────────────────────────────────────
  ownsJid(jid) {
    return typeof jid === 'string' && jid.startsWith('discord:');
  }

  /**
   * Map a discord.js Message to a normalized inbound descriptor,
   * or return null to skip the message.
   */
  buildInbound(message) {
    if (!message) return null;
    // Echo guard — ignore bot messages (including our own)
    if (message.author && message.author.bot) return null;

    const channelId = message.channelId ?? message.channel?.id;
    if (!channelId) return null;

    const jid = `discord:${channelId}`;
    const isGroup = !!message.guild;

    const sender = message.author?.id ? String(message.author.id) : 'unknown';
    const senderName =
      message.author?.username || message.author?.tag || sender;
    const chatName = isGroup
      ? message.channel?.name || message.guild?.name || senderName
      : senderName;

    return {
      jid,
      isGroup,
      senderName,
      chatName,
      sender,
      content: message.content ?? '',
    };
  }

  // ── Inbound handling ──────────────────────────────────────────────────────
  handleMessage(message) {
    // Echo guard first — ignore bot messages (including our own) before any
    // other checks, so embed/sticker messages from other bots never trigger
    // the empty-content warning below.
    if (message.author?.bot) return;

    // Empty content in a guild message from a human: likely the MessageContent
    // intent is not enabled. This signals an operator misconfiguration.
    if (message.guild && !message.content) {
      this.sdk.logger.warn(
        { channelId: message.channelId ?? message.channel?.id },
        'discord: empty message content in guild — ensure the MessageContent privileged intent is enabled in the Discord Developer Portal',
      );
      return;
    }

    const inb = this.buildInbound(message);
    if (!inb) return;

    // Only handle messages for registered groups/chats.
    const registered = this.opts.registeredGroups()[inb.jid];
    if (!registered) {
      this.sdk.logger.debug({ jid: inb.jid }, 'discord: unregistered channel');
      return;
    }

    let content = inb.content;

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

    // v1: empty content messages — nothing to deliver.
    if (!content) return;

    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();

    this.opts.onChatMetadata(
      inb.jid,
      timestamp,
      inb.chatName,
      'discord',
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
    // Lazy discord.js import — only loaded here so unit tests never need the dep.
    const makeClient =
      this._makeClient ??
      (async (token) => {
        const { Client, GatewayIntentBits, Partials } =
          await import('discord.js');
        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel],
        });
        await client.login(token);
        return client;
      });

    this.client = await makeClient(this.config.token);

    this.client.on('messageCreate', (message) => {
      try {
        this.handleMessage(message);
      } catch (err) {
        this.sdk.logger.warn(
          { err: String(err) },
          'discord: handleMessage failed',
        );
      }
    });

    this.connected = true;
    this.sdk.logger.info('discord: connected (Gateway WebSocket)');
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
    if (!this.client) {
      this.sdk.logger.warn(
        { jid },
        'discord: sendMessage called but client not connected',
      );
      return;
    }
    const channelId = jid.slice('discord:'.length);
    let discordChannel;
    try {
      discordChannel = await this.client.channels.fetch(channelId);
    } catch (err) {
      this.sdk.logger.error(
        { jid, err: String(err) },
        'discord: failed to fetch channel',
      );
      return;
    }
    if (!discordChannel) {
      this.sdk.logger.warn({ jid }, 'discord: channel not found');
      return;
    }
    for (const c of this.chunk(text, MAX_MESSAGE_LENGTH)) {
      try {
        await discordChannel.send(c);
      } catch (err) {
        this.sdk.logger.error(
          { jid, err: String(err) },
          'discord: send failed',
        );
      }
    }
  }

  async setTyping(jid, isTyping) {
    if (!this.ownsJid(jid) || !this.client || !isTyping) return;
    const channelId = jid.slice('discord:'.length);
    try {
      const discordChannel = await this.client.channels.fetch(channelId);
      if (discordChannel && discordChannel.sendTyping) {
        await discordChannel.sendTyping();
      }
    } catch (err) {
      this.sdk.logger.debug({ err: String(err) }, 'discord: typing failed');
    }
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // ignore destroy errors
      }
      this.client = null;
    }
  }
}

// ── Config parser ─────────────────────────────────────────────────────────────
function parseConfig(sdk) {
  const env = sdk.readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = (
    process.env.DISCORD_BOT_TOKEN ||
    env.DISCORD_BOT_TOKEN ||
    ''
  ).trim();
  if (!token) {
    sdk.logger.warn('discord: DISCORD_BOT_TOKEN is required');
    return null;
  }
  return { token };
}

// ── Registration ──────────────────────────────────────────────────────────────
export default function register(sdk) {
  sdk.registerChannel('discord', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new DiscordChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { DiscordChannel, parseConfig };
