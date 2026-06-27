/* eslint-disable */
/**
 * iMessage channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: BlueBubbles REST server (https://bluebubbles.app) — a third-party
 * open-source macOS app that bridges iMessage to a REST API. The operator must
 * run a BlueBubbles server on a Mac and provide its URL and password. This
 * adapter is a REST client of that external server; it uses a POLLING receive
 * model (no webhook/httpPort required).
 *
 * Receive model: poll `POST <url>/api/v1/message/query` on an interval with an
 * `after` filter (Unix ms timestamp cursor), delivering only messages newer than
 * the cursor. A client-side guard additionally skips any message whose
 * dateCreated is at or below the cursor captured at the start of each poll,
 * making dedup server-version-agnostic.
 *
 * Send model: `POST <url>/api/v1/message/text?password=<pw>` with
 * `{ chatGuid, message, tempGuid }`.
 *
 * JID format:
 *   imessage:<handle>          1:1 chat (handle = phone/email address)
 *   imessage:group.<guid>      group chat (guid = chat GUID from BlueBubbles)
 *
 * ⚠️  EXTERNAL PREREQUISITE: The operator MUST run a BlueBubbles server on a
 * Mac with iMessage. This adapter CANNOT work without it — iMessage is Apple-
 * hardware-only and there is no Linux/container solution. See bootstrap-imessage.md.
 *
 * Config (from the channel Secret / env):
 *   IMESSAGE_BRIDGE_URL       base URL of the BlueBubbles server
 *                             (e.g. https://mac.example.com or http://192.168.1.50:1234)
 *   IMESSAGE_BRIDGE_PASSWORD  BlueBubbles server password (set when you configured BlueBubbles)
 *   IMESSAGE_POLL_MS          receive poll interval in ms (default 3000)
 */

const DEFAULT_POLL_MS = 3000;
const MAX_MESSAGE_LENGTH = 10000;

class IMessageChannel {
  name = 'imessage';
  capabilities = { markdownOutput: false };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.connected = false;
    this.pollTimer = null;
    this.messageId = 0;
    this.stopped = false;
    // lastSeen is a Unix millisecond timestamp; messages strictly newer than
    // this are fetched on each poll. Initialized to now so we don't replay
    // old history on first connect.
    this.lastSeen = Date.now();
  }

  // ── JID helpers ──────────────────────────────────────────────────────────

  /**
   * Build the JID for a received BlueBubbles message object.
   * Group chats have a chatGuid that starts with 'iMessage;+;' (multi-party).
   * 1:1 chats have a chatGuid like 'iMessage;-;<handle>'.
   */
  jidForMessage(msg) {
    const chatGuid = msg?.chats?.[0]?.guid ?? msg?.chat?.guid ?? '';
    // BlueBubbles group chat GUIDs start with 'iMessage;+;'
    if (chatGuid.includes(';+;')) {
      return `imessage:group.${chatGuid}`;
    }
    // 1:1: use the handle (stripped from chatGuid or from msg.handle)
    const handle =
      msg?.handle?.address ??
      msg?.sender?.address ??
      chatGuid.replace(/^iMessage;-;/, '') ??
      'unknown';
    return `imessage:${handle}`;
  }

  ownsJid(jid) {
    return typeof jid === 'string' && jid.startsWith('imessage:');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect() {
    // Probe the BlueBubbles ping endpoint. Don't hard-fail if not ready yet —
    // the poll loop retries and the server may still be starting.
    try {
      const url = `${this.config.bridgeUrl}/api/v1/ping?password=${encodeURIComponent(this.config.bridgePassword)}`;
      const res = await fetch(url);
      if (res.ok) {
        this.connected = true;
      } else {
        this.sdk.logger.warn(
          { status: res.status },
          'imessage: BlueBubbles ping returned non-200; will keep polling',
        );
      }
    } catch (err) {
      this.sdk.logger.warn(
        { err: String(err) },
        'imessage: BlueBubbles server not reachable yet; will keep polling',
      );
    }

    this.sdk.logger.info(
      { bridgeUrl: this.config.bridgeUrl, connected: this.connected },
      'imessage: channel starting; beginning receive loop',
    );
    this.scheduleReceive();
  }

  scheduleReceive() {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        this.sdk.logger.warn(
          { err: String(err) },
          'imessage: receive poll failed',
        );
      }
      this.scheduleReceive();
    }, this.config.pollMs);
    // Don't keep the event loop alive solely for the poll timer.
    if (this.pollTimer && typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  /**
   * Fetch messages from BlueBubbles that are newer than lastSeen.
   * Uses POST /api/v1/message/query with a `after` filter.
   */
  async pollOnce() {
    const pw = encodeURIComponent(this.config.bridgePassword);
    const url = `${this.config.bridgeUrl}/api/v1/message/query?password=${pw}`;

    // BlueBubbles message/query endpoint accepts a POST body with filters.
    // We filter by messages after lastSeen. The `after` param is a Unix ms timestamp.
    const body = JSON.stringify({
      limit: 100,
      offset: 0,
      with: ['chats', 'chat.participants', 'handle'],
      sort: 'ASC',
      after: this.lastSeen,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      this.sdk.logger.debug(
        { status: res.status },
        'imessage: message query non-200',
      );
      return;
    }

    const data = await res.json();
    // BlueBubbles returns { status: 200, message: 'Success', data: [...] }
    const messages = Array.isArray(data?.data) ? data.data : [];

    // Capture the cursor value at the start of this batch. We use this for the
    // per-message skip test so that intra-batch cursor updates don't suppress
    // later messages in the same batch that share the same timestamp.
    const cursorAtStart = this.lastSeen;

    let maxSeen = this.lastSeen;
    for (const msg of messages) {
      // Client-side dedup guard: skip messages at or below the cursor value
      // captured at the start of this poll. This makes dedup server-version-
      // agnostic — if the server treats `after` as inclusive (or ignores it),
      // we still won't re-deliver already-seen messages.
      const ts = Number(msg?.dateCreated ?? msg?.date_created ?? 0);
      if (ts <= cursorAtStart) continue;

      await this.handleMessage(msg);
      // Advance cursor to the newest dateCreated we've seen.
      if (ts > maxSeen) maxSeen = ts;
    }
    // Update cursor even if no messages (idempotent).
    if (maxSeen > this.lastSeen) {
      this.lastSeen = maxSeen;
    }
  }

  /** Turn one BlueBubbles message into an inbound KubeClaw message. */
  async handleMessage(msg) {
    if (!msg) return;

    // isFromMe: ignore echoes (messages we sent).
    if (msg.isFromMe === true || msg.is_from_me === true) return;

    // Must have some content (text or attachment marker).
    const hasText = typeof msg.text === 'string' && msg.text.length > 0;
    const hasAttachments =
      Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!hasText && !hasAttachments) return;

    const jid = this.jidForMessage(msg);
    const chatGuid = msg?.chats?.[0]?.guid ?? msg?.chat?.guid ?? '';
    const isGroup = chatGuid.includes(';+;');

    // Only handle messages for registered groups/chats.
    const registered = this.opts.registeredGroups()[jid];
    if (!registered) {
      this.sdk.logger.debug(
        { jid },
        'imessage: message from unregistered chat',
      );
      return;
    }

    const sender = msg?.handle?.address ?? msg?.sender?.address ?? 'unknown';
    const senderName =
      msg?.handle?.displayName ??
      msg?.sender?.displayName ??
      msg?.chats?.[0]?.participants?.[0]?.address ??
      sender;
    const ts = Number(msg?.dateCreated ?? msg?.date_created ?? Date.now());
    const timestamp = new Date(ts).toISOString();
    const msgId = `${ts}-${++this.messageId}`;

    let content = hasText ? msg.text : '';

    // Attachment handling (v1: text-only; mark unsupported)
    if (hasAttachments) {
      const marker = '[Attachment: unsupported in v1]';
      content = content ? `${marker}\n${content}` : marker;
    }

    // Group mention rewrite: if the assistant is mentioned but not at the
    // start, prepend `@<name> ` to trigger the bot.
    if (isGroup && this.sdk.assistantName && content) {
      const esc = this.sdk.assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const triggerRegex = new RegExp(`^@${esc}\\b`, 'i');
      const mentionRegex = new RegExp(`@${esc}\\b`, 'i');
      if (mentionRegex.test(content) && !triggerRegex.test(content)) {
        content = `@${this.sdk.assistantName} ${content}`;
      }
    }

    this.opts.onChatMetadata(jid, timestamp, senderName, 'imessage', isGroup);
    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
    this.sdk.logger.info(
      { jid, sender, isGroup },
      'imessage: inbound message stored',
    );
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendMessage(jid, text) {
    if (!this.ownsJid(jid)) {
      this.sdk.logger.warn(
        { jid },
        'imessage: sendMessage called with non-imessage JID',
      );
      return;
    }

    // Derive the chatGuid from the JID.
    // imessage:group.<chatGuid> → chatGuid is everything after "imessage:group."
    // imessage:<handle> → chatGuid is "iMessage;-;<handle>"
    let chatGuid;
    if (jid.startsWith('imessage:group.')) {
      chatGuid = jid.slice('imessage:group.'.length);
    } else {
      const handle = jid.slice('imessage:'.length);
      if (!handle) {
        this.sdk.logger.warn({ jid }, 'imessage: empty handle after JID parse');
        return;
      }
      chatGuid = `iMessage;-;${handle}`;
    }

    const chunks = this.chunk(text, MAX_MESSAGE_LENGTH);
    const pw = encodeURIComponent(this.config.bridgePassword);
    const url = `${this.config.bridgeUrl}/api/v1/message/text?password=${pw}`;

    let successCount = 0;
    for (const chunk of chunks) {
      const payload = {
        chatGuid,
        message: chunk,
        tempGuid: `kubeclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          successCount++;
        } else {
          const errText = await res.text().catch(() => '');
          this.sdk.logger.error(
            { jid, status: res.status, errText },
            'imessage: send failed',
          );
        }
      } catch (err) {
        this.sdk.logger.error(
          { jid, err: String(err) },
          'imessage: send threw',
        );
      }
    }
    if (successCount > 0) {
      this.sdk.logger.info(
        { jid, length: text.length, chunks: chunks.length, successCount },
        'imessage: message sent',
      );
    }
  }

  /** Split text into <= max-length chunks. */
  chunk(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.stopped = true;
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.sdk.logger.info('imessage: disconnected');
  }
}

function parseConfig(sdk) {
  const envVars = sdk.readEnvFile([
    'IMESSAGE_BRIDGE_URL',
    'IMESSAGE_BRIDGE_PASSWORD',
    'IMESSAGE_POLL_MS',
  ]);

  const bridgeUrl = (
    process.env.IMESSAGE_BRIDGE_URL ||
    envVars.IMESSAGE_BRIDGE_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  const bridgePassword = (
    process.env.IMESSAGE_BRIDGE_PASSWORD ||
    envVars.IMESSAGE_BRIDGE_PASSWORD ||
    ''
  ).trim();

  const pollRaw = process.env.IMESSAGE_POLL_MS || envVars.IMESSAGE_POLL_MS;
  const pollMs = pollRaw ? parseInt(pollRaw, 10) : DEFAULT_POLL_MS;

  if (!bridgeUrl) {
    sdk.logger.warn(
      'imessage: IMESSAGE_BRIDGE_URL is required (the BlueBubbles server URL)',
    );
    return null;
  }

  if (!bridgePassword) {
    sdk.logger.warn('imessage: IMESSAGE_BRIDGE_PASSWORD is required');
    return null;
  }

  return {
    bridgeUrl,
    bridgePassword,
    pollMs: Number.isInteger(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS,
  };
}

export default function register(sdk) {
  sdk.registerChannel('imessage', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new IMessageChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { IMessageChannel, parseConfig };
