/* eslint-disable */
/**
 * Signal channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: bbernhard/signal-cli-rest-api (a Dockerized REST wrapper around
 * AsamK/signal-cli). A long-lived `kubeclaw-signal-cli` StatefulSet holds the
 * linked Signal account session on a PVC and exposes an HTTP API on :8080. This
 * adapter talks to it over plain HTTP using Node's built-in global `fetch` —
 * so it needs NO npm dependencies (no native libsignal compile, nothing that
 * fights `npm ci --ignore-scripts`).
 *
 * Receive model: poll `GET /v1/receive/{number}` on an interval. That endpoint
 * works in every signal-cli-rest-api MODE (normal/native/json-rpc) and drains
 * the queue of envelopes received since the last call, returning a JSON array.
 * (json-rpc mode also offers a WebSocket, but polling keeps this adapter
 * dependency-free and mode-agnostic.)
 *
 * Send model: `POST /v2/send` with { message, number, recipients:[...] }.
 *
 * JID format:
 *   signal:+61412345678      1:1 chat (recipient is the E.164 number)
 *   signal:group.<base64Id>  group chat (recipient is the signal-cli group id)
 *
 * Account setup is a manual operator step (link the bot as a secondary device,
 * or register a dedicated number). See bootstrap-signal.md. It CANNOT be done
 * in CI — it requires a real phone/account.
 *
 * Config (from the channel Secret / env):
 *   SIGNAL_PHONE_NUMBER  the bot's own E.164 number (the linked/registered number)
 *   SIGNAL_API_URL       base URL of the signal-cli-rest-api service
 *                        (default http://kubeclaw-signal-cli:8080)
 *   SIGNAL_POLL_MS       receive poll interval in ms (default 2000)
 */

const DEFAULT_API_URL = 'http://kubeclaw-signal-cli:8080';
const DEFAULT_POLL_MS = 2000;
// signal-cli-rest-api default; Signal's hard limit is higher but chunk to be safe.
const MAX_MESSAGE_LENGTH = 4000;

class SignalChannel {
  name = 'signal';
  // Signal does NOT render markdown — replies are plain text. It DOES support
  // inbound image/voice attachments, but this adapter does not download them
  // yet (text-only path), so we declare no inbound-attachment capabilities.
  capabilities = { markdownOutput: false };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.connected = false;
    this.pollTimer = null;
    this.messageId = 0;
    this.stopped = false;
  }

  // ── JID helpers ──────────────────────────────────────────────────────────
  /** Build the JID for a received envelope (group id wins over the sender). */
  jidForEnvelope(env) {
    const groupId = env?.dataMessage?.groupInfo?.groupId;
    if (groupId) return `signal:group.${groupId}`;
    const src = env?.sourceNumber || env?.source;
    return `signal:${src}`;
  }

  /** Strip the JID prefix to the signal-cli recipient (number or group.<id>). */
  recipientForJid(jid) {
    return jid.replace(/^signal:/, '');
  }

  ownsJid(jid) {
    return typeof jid === 'string' && jid.startsWith('signal:');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async connect() {
    // Probe the signal-cli-rest-api health endpoint. Don't hard-fail if it is
    // not ready yet — the poll loop retries and the daemon may still be linking.
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/health`);
      if (res.ok) {
        this.connected = true;
      } else {
        this.sdk.logger.warn(
          { status: res.status },
          'signal: signal-cli health check returned non-200; will keep polling',
        );
      }
    } catch (err) {
      this.sdk.logger.warn(
        { err: String(err) },
        'signal: signal-cli not reachable yet; will keep polling',
      );
    }

    this.sdk.logger.info(
      { number: this.config.phoneNumber, apiUrl: this.config.apiUrl, connected: this.connected },
      'signal: channel starting; beginning receive loop',
    );
    this.scheduleReceive();
  }

  scheduleReceive() {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.receiveOnce();
      } catch (err) {
        this.sdk.logger.warn({ err: String(err) }, 'signal: receive poll failed');
      }
      this.scheduleReceive();
    }, this.config.pollMs);
    // Don't keep the event loop alive solely for the poll timer.
    if (this.pollTimer && typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  /** Drain one batch of envelopes from the signal-cli receive queue. */
  async receiveOnce() {
    // encodeURIComponent turns '+' → '%2B' so the E.164 number survives the path.
    // signal-cli-rest-api decodes path params correctly; a naive proxy that
    // double-decodes will serve a 404 — encode the number in the proxy config too.
    const url = `${this.config.apiUrl}/v1/receive/${encodeURIComponent(this.config.phoneNumber)}`;
    const res = await fetch(url);
    if (!res.ok) {
      this.sdk.logger.debug(
        { status: res.status },
        'signal: receive endpoint non-200',
      );
      return;
    }
    const body = await res.json();
    // signal-cli-rest-api returns an array of { envelope: {...}, account } objects.
    const items = Array.isArray(body) ? body : [];
    for (const item of items) {
      const env = item?.envelope ?? item;
      this.handleEnvelope(env);
    }
  }

  /** Turn one received envelope into an inbound KubeClaw message. */
  handleEnvelope(env) {
    if (!env) return;
    const data = env.dataMessage;
    // Only data messages with text are conversational. Skip receipts, typing,
    // sync, reactions, and empty (attachment-only) messages.
    if (!data || typeof data.message !== 'string' || data.message.length === 0) {
      return;
    }
    // Ignore anything we sent ourselves (echoed sync messages).
    if (env.source === this.config.phoneNumber || env.sourceNumber === this.config.phoneNumber) {
      return;
    }

    const jid = this.jidForEnvelope(env);
    const isGroup = Boolean(data.groupInfo?.groupId);

    // Only handle messages for registered groups/chats (mirrors the irc adapter).
    const registered = this.opts.registeredGroups()[jid];
    if (!registered) {
      this.sdk.logger.debug({ jid }, 'signal: message from unregistered chat');
      return;
    }

    const sender = env.sourceNumber || env.source || 'unknown';
    const senderName = env.sourceName || sender;
    const ts = env.timestamp ? Number(env.timestamp) : Date.now();
    const timestamp = new Date(ts).toISOString();
    const msgId = `${ts}-${++this.messageId}`;

    // For groups Signal requires an explicit trigger; rewrite a bare mention of
    // the assistant name into the canonical trigger prefix so the agent runs.
    let content = data.message;
    if (isGroup && this.sdk.assistantName) {
      const triggerRegex = new RegExp(`^@${this.sdk.assistantName}\\b`, 'i');
      const mentionRegex = new RegExp(`@${this.sdk.assistantName}\\b`, 'i');
      if (mentionRegex.test(content) && !triggerRegex.test(content)) {
        content = `@${this.sdk.assistantName} ${content}`;
      }
    }

    this.opts.onChatMetadata(jid, timestamp, senderName, 'signal', isGroup);
    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
    this.sdk.logger.info({ jid, sender, isGroup }, 'signal: inbound message stored');
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  async sendMessage(jid, text) {
    if (!this.ownsJid(jid)) {
      this.sdk.logger.warn({ jid }, 'signal: sendMessage called with non-signal JID');
      return;
    }
    const recipient = this.recipientForJid(jid);
    if (!recipient) {
      this.sdk.logger.warn({ jid }, 'signal: empty recipient after JID parse');
      return;
    }

    const chunks = this.chunk(text, MAX_MESSAGE_LENGTH);
    let successCount = 0;
    for (const chunk of chunks) {
      const payload = {
        message: chunk,
        number: this.config.phoneNumber,
        recipients: [recipient],
      };
      try {
        const res = await fetch(`${this.config.apiUrl}/v2/send`, {
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
            'signal: send failed',
          );
        }
      } catch (err) {
        this.sdk.logger.error({ jid, err: String(err) }, 'signal: send threw');
      }
    }
    if (successCount > 0) {
      this.sdk.logger.info(
        { jid, length: text.length, chunks: chunks.length, successCount },
        'signal: message sent',
      );
    }
  }

  /** Split text into <= max-length chunks (Signal has a message size limit). */
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
    this.sdk.logger.info('signal: disconnected');
  }
}

function parseConfig(sdk) {
  const envVars = sdk.readEnvFile(['SIGNAL_PHONE_NUMBER', 'SIGNAL_API_URL', 'SIGNAL_POLL_MS']);

  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';
  const apiUrl = (
    process.env.SIGNAL_API_URL ||
    envVars.SIGNAL_API_URL ||
    DEFAULT_API_URL
  ).replace(/\/+$/, '');
  const pollRaw = process.env.SIGNAL_POLL_MS || envVars.SIGNAL_POLL_MS;
  const pollMs = pollRaw ? parseInt(pollRaw, 10) : DEFAULT_POLL_MS;

  if (!phoneNumber || !/^\+\d{7,15}$/.test(phoneNumber)) {
    sdk.logger.warn(
      'signal: SIGNAL_PHONE_NUMBER must be set to an E.164 number (e.g. +61412345678)',
    );
    return null;
  }

  return {
    phoneNumber,
    apiUrl,
    pollMs: Number.isInteger(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS,
  };
}

export default function register(sdk) {
  sdk.registerChannel('signal', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new SignalChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { SignalChannel, parseConfig };
