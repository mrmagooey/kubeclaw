/* eslint-disable */
/**
 * WhatsApp channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: Meta WhatsApp Business Cloud API.
 * Inbound: webhook HTTP server (GET /webhook → verify handshake; POST /webhook →
 *          HMAC-verified event delivery). No npm dependencies — uses native
 *          `fetch`, `node:http`, `node:crypto`.
 *
 * JID format:
 *   whatsapp:<e164>             — 1:1 chat (e.g. whatsapp:+14155238886)
 *   whatsapp:group.<groupId>    — group chat
 *
 * Config (from the channel Secret / env):
 *   WHATSAPP_ACCESS_TOKEN       long-lived access token from Meta (required)
 *   WHATSAPP_PHONE_NUMBER_ID    the numeric phone-number-id from Meta (required)
 *   WHATSAPP_VERIFY_TOKEN       the webhook verify token you set in Meta App dashboard (required)
 *   WHATSAPP_APP_SECRET         the App Secret from Meta App settings (required)
 *
 * Security: every inbound POST is HMAC-SHA256 verified against WHATSAPP_APP_SECRET
 * using constant-time comparison. Reject 403 on mismatch — never process.
 *
 * TLS: Meta requires HTTPS for the webhook endpoint. TLS terminates at the
 * Kubernetes Ingress. Operators MUST configure ingress.tls for this channel.
 *
 * Capabilities: text-first v1.
 *   inboundImages: false  (media messages get an [Attachment: unsupported in v1] marker)
 *   outboundMedia: false
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_MESSAGE_LENGTH = 4096;
const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Returns true if jid is a WhatsApp JID.
 * Rejects undefined / non-strings.
 */
export function ownsJid(jid) {
  return typeof jid === 'string' && jid.startsWith('whatsapp:');
}

/**
 * Verify the X-Hub-Signature-256 header from Meta.
 * headerSig must be in the form "sha256=<hex>".
 * Returns true if signature matches; false on any mismatch or error.
 */
export function verifySignature(rawBody, appSecret, headerSig) {
  if (typeof headerSig !== 'string' || !headerSig.startsWith('sha256=')) {
    return false;
  }
  try {
    const expected = createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(headerSig.slice('sha256='.length), 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Handle the GET /webhook verification handshake from Meta.
 * query: object from URLSearchParams
 * Returns the challenge string if valid, null otherwise.
 */
export function handleVerify(query, verifyToken) {
  if (
    query['hub.mode'] === 'subscribe' &&
    query['hub.verify_token'] === verifyToken
  ) {
    return query['hub.challenge'] ?? null;
  }
  return null;
}

/**
 * Parse a Meta webhook POST body (already parsed JSON object).
 * Returns an array of normalized inbound message descriptors:
 *   { jid, sender, senderName, text, isGroup, messageId }
 * Skips status updates and own (outbound) messages.
 */
export function parseWebhook(body) {
  const results = [];
  try {
    const entries = body?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        // Skip statuses payloads (delivery receipts, read receipts)
        if (value.statuses) continue;

        const messages = value.messages ?? [];
        for (const msg of messages) {
          // Skip outbound/echo messages
          if (msg.from_me) continue;

          const sender = msg.from;
          const phone = value.metadata?.phone_number_id;

          // Determine JID: group or 1:1
          let jid;
          let isGroup = false;
          const groupId = msg.context?.group_id ?? msg.group_id ?? null;
          if (groupId) {
            jid = `whatsapp:group.${groupId}`;
            isGroup = true;
          } else {
            jid = `whatsapp:${sender}`;
          }

          // Get sender name from contacts array
          const contacts = value.contacts ?? [];
          const contact = contacts.find((c) => c.wa_id === sender);
          const senderName = contact?.profile?.name ?? sender;

          // Extract text content; for media-only messages, add marker
          let text = msg.text?.body ?? '';
          if (!text) {
            // Media message (image, audio, video, document, etc.)
            const mediaType = msg.type ?? 'unknown';
            if (
              mediaType !== 'text' &&
              mediaType !== 'interactive' &&
              mediaType !== 'template'
            ) {
              text = `[Attachment: unsupported in v1]`;
            }
          }

          if (!text) continue;

          results.push({
            jid,
            sender,
            senderName,
            text,
            isGroup,
            messageId: msg.id,
          });
        }
      }
    }
  } catch {
    // malformed body → return empty
  }
  return results;
}

// ── WhatsApp Channel class ─────────────────────────────────────────────────────

class WhatsAppChannel {
  name = 'whatsapp';
  capabilities = {
    inboundImages: false,
    outboundMedia: false,
  };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.server = null;
    this.connected = false;
    this.messageId = 0;
  }

  // ── JID helpers ──────────────────────────────────────────────────────────
  ownsJid(jid) {
    return ownsJid(jid);
  }

  // ── Inbound handling ──────────────────────────────────────────────────────

  /** Read the full request body as a Buffer. */
  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async _handleWebhookRequest(req, res) {
    const rawUrl = req.url ?? '/';
    let pathname;
    let searchParams;
    try {
      const parsed = new URL(
        rawUrl,
        `http://localhost:${this.config.httpPort}`,
      );
      pathname = parsed.pathname;
      searchParams = Object.fromEntries(parsed.searchParams.entries());
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    // GET /healthz
    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // GET /webhook → Meta verification handshake
    if (req.method === 'GET' && pathname === '/webhook') {
      const challenge = handleVerify(searchParams, this.config.verifyToken);
      if (challenge !== null) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(String(challenge));
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // POST /webhook → inbound events
    if (req.method === 'POST' && pathname === '/webhook') {
      let rawBody;
      try {
        rawBody = await this._readBody(req);
      } catch (err) {
        this.sdk.logger.warn(
          { err: String(err) },
          'whatsapp: failed to read webhook body',
        );
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      // HMAC verification — CRITICAL security step
      const sig = req.headers['x-hub-signature-256'] ?? '';
      if (!verifySignature(rawBody, this.config.appSecret, sig)) {
        this.sdk.logger.warn(
          { sig },
          'whatsapp: HMAC verification failed — rejecting POST',
        );
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Respond 200 immediately so Meta doesn't retry
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');

      // Process asynchronously after response sent
      try {
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          this.sdk.logger.warn('whatsapp: webhook body is not valid JSON');
          return;
        }

        const messages = parseWebhook(parsed);
        const registeredGroups = this.opts.registeredGroups();

        for (const inb of messages) {
          // Drop messages for unregistered JIDs
          if (!registeredGroups[inb.jid]) {
            this.sdk.logger.debug(
              { jid: inb.jid },
              'whatsapp: unregistered JID, dropping',
            );
            continue;
          }

          let content = inb.text;

          // Mention rewrite for group messages
          if (inb.isGroup && this.sdk.assistantName && content) {
            const esc = this.sdk.assistantName.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&',
            );
            const triggerRegex = new RegExp(`^@${esc}\\b`, 'i');
            const mentionRegex = new RegExp(`@${esc}\\b`, 'i');
            if (mentionRegex.test(content) && !triggerRegex.test(content)) {
              content = `@${this.sdk.assistantName} ${content}`;
            }
          }

          const ts = Date.now();
          const timestamp = new Date(ts).toISOString();

          this.opts.onChatMetadata(
            inb.jid,
            timestamp,
            inb.senderName,
            'whatsapp',
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
      } catch (err) {
        this.sdk.logger.error(
          { err: String(err) },
          'whatsapp: error processing webhook payload',
        );
      }

      return;
    }

    // All other paths → 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    this.server = createServer((req, res) => {
      this._handleWebhookRequest(req, res).catch((err) => {
        this.sdk.logger.error(
          { err: String(err) },
          'whatsapp: unhandled error in webhook handler',
        );
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.httpPort, () => {
        this.connected = true;
        this.sdk.logger.info(
          { port: this.config.httpPort },
          'whatsapp: webhook server listening',
        );
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /** Chunk text at 4096 characters. */
  _chunk(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  /** Extract the phone number or group id from a whatsapp: JID. */
  _recipientForJid(jid) {
    // whatsapp:+14155238886 → +14155238886
    // whatsapp:group.<id>  → group.<id>
    return jid.slice('whatsapp:'.length);
  }

  async sendMessage(jid, text) {
    if (!this.ownsJid(jid)) return;

    const recipient = this._recipientForJid(jid);
    const url = `${GRAPH_API_BASE}/${this.config.phoneNumberId}/messages`;

    for (const chunk of this._chunk(text)) {
      const body = JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { body: chunk },
      });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body,
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          this.sdk.logger.error(
            { jid, status: resp.status, body: errText },
            'whatsapp: send failed',
          );
        }
      } catch (err) {
        this.sdk.logger.error(
          { jid, err: String(err) },
          'whatsapp: send network error',
        );
      }
    }
  }
}

// ── Config parser ─────────────────────────────────────────────────────────────

function parseConfig(sdk) {
  const env = sdk.readEnvFile([
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
  ]);

  const accessToken = (
    process.env.WHATSAPP_ACCESS_TOKEN ||
    env.WHATSAPP_ACCESS_TOKEN ||
    ''
  ).trim();
  const phoneNumberId = (
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    env.WHATSAPP_PHONE_NUMBER_ID ||
    ''
  ).trim();
  const verifyToken = (
    process.env.WHATSAPP_VERIFY_TOKEN ||
    env.WHATSAPP_VERIFY_TOKEN ||
    ''
  ).trim();
  const appSecret = (
    process.env.WHATSAPP_APP_SECRET ||
    env.WHATSAPP_APP_SECRET ||
    ''
  ).trim();

  if (!accessToken || !phoneNumberId || !verifyToken || !appSecret) {
    sdk.logger.warn(
      'whatsapp: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_APP_SECRET are all required',
    );
    return null;
  }

  const httpPort = Number(
    process.env.KUBECLAW_CHANNEL_HTTP_PORT ||
      env.KUBECLAW_CHANNEL_HTTP_PORT ||
      4080,
  );

  return {
    accessToken,
    phoneNumberId,
    verifyToken,
    appSecret,
    httpPort,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

export default function register(sdk) {
  sdk.registerChannel('whatsapp', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new WhatsAppChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { WhatsAppChannel, parseConfig };
