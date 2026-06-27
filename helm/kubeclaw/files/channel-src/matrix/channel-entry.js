/* eslint-disable */
/**
 * Matrix channel adapter for KubeClaw — channel-runner mode.
 *
 * Backend: matrix-js-sdk@41 (/sync long-poll transport).
 * The adapter performs lazy import inside connect() so unit tests never load matrix-js-sdk.
 *
 * JID format:
 *   matrix:<roomId>   — full room id including its internal colon, e.g.
 *                       matrix:!abc:home.server
 *
 * Ownership uses a prefix match (jid.startsWith('matrix:')) so the extra
 * colon in the room id is handled safely.
 *
 * Config (from the channel Secret / env):
 *   MATRIX_HOMESERVER_URL   base URL of the homeserver (e.g. https://matrix.org)
 *   MATRIX_USER_ID          fully-qualified user id (e.g. @mybot:matrix.org)
 *   MATRIX_ACCESS_TOKEN     access token obtained from the homeserver
 *
 * Inbound: /sync long-poll via client.startClient().
 *   Only processes Room.timeline events after the client reaches PREPARED state.
 *   Deduplicates events by event id (bounded Set).
 *   Echo guard: ignores events from our own MATRIX_USER_ID.
 *   Only handles m.room.message / m.text (skips other event types in v1).
 *
 * Outbound: client.sendTextMessage(); chunks at 32000 chars.
 *   setTyping: client.sendTyping(roomId, isTyping, 20000).
 *   No markdown output in v1 — plain m.text body only.
 *
 * CRYPTO OFF — CRITICAL:
 *   Do NOT add initRustCrypto() here. The @matrix-org/matrix-sdk-crypto-wasm
 *   binary ships in the package but is never loaded as long as initRustCrypto()
 *   is never called. /sync and plain text send/receive work fully without it.
 *   The client is created with store: new MemoryStore() and nothing else.
 *   If you are tempted to add E2EE in the future: create a separate v2 adapter
 *   rather than adding initRustCrypto() here — it changes the startup contract.
 *
 * isGroup: Matrix rooms are inherently multi-party so always set to true.
 * This simplifies implementation and matches real-world usage where even
 * 1:1 rooms could become group rooms.
 */

const MAX_MESSAGE_LENGTH = 32000;

// Bounded set for event-id deduplication (cap at 10000 to bound memory).
const EVENT_ID_CAP = 10000;

class MatrixChannel {
  name = 'matrix';
  capabilities = {
    typing: true,
    inboundImages: true,
    outboundMedia: false,
  };

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.client = null;
    this.connected = false;
    this.messageId = 0;
    this.syncReady = false;
    this._seenEventIds = new Set();
    // Injectable in tests: (opts) => client instance. Set in connect() when null.
    this._makeClient = null;
  }

  // ── JID helpers ──────────────────────────────────────────────────────────
  ownsJid(jid) {
    return typeof jid === 'string' && jid.startsWith('matrix:');
  }

  /**
   * Extract the Matrix room id from a JID.
   * JID = "matrix:!abc:home.server" → roomId = "!abc:home.server"
   */
  _roomIdFromJid(jid) {
    return jid.slice('matrix:'.length);
  }

  /**
   * Build the JID for a Matrix room id.
   */
  _jidFromRoomId(roomId) {
    return `matrix:${roomId}`;
  }

  // ── Inbound handling ──────────────────────────────────────────────────────
  _handleTimelineEvent(event, room) {
    // Only process events after initial sync completes.
    if (!this.syncReady) return;

    // Only handle m.room.message events.
    if (event.getType() !== 'm.room.message') return;

    const content = event.getContent();
    // Only handle plain text messages in v1.
    if (!content || content.msgtype !== 'm.text') return;

    const eventId = event.getId();
    if (!eventId) return;

    // Deduplicate by event id (bounded).
    if (this._seenEventIds.has(eventId)) return;
    if (this._seenEventIds.size >= EVENT_ID_CAP) {
      // Evict oldest by clearing — simple approximation sufficient here.
      this._seenEventIds.clear();
    }
    this._seenEventIds.add(eventId);

    const sender = event.getSender();

    // Echo guard: ignore messages from our own user.
    if (sender === this.config.userId) return;

    const roomId = room.roomId;
    const jid = this._jidFromRoomId(roomId);

    // Only handle messages for registered groups/chats.
    const registered = this.opts.registeredGroups()[jid];
    if (!registered) {
      this.sdk.logger.debug({ jid }, 'matrix: unregistered room');
      return;
    }

    const roomName = room.name || roomId;
    const senderName = sender || 'unknown';
    // isGroup: rooms are inherently multi-party — always true.
    const isGroup = true;

    let text = content.body || '';

    // Group trigger rewrite: if message contains @AssistantName but doesn't
    // start with it, prepend "@AssistantName " so the runtime trigger fires.
    if (isGroup && this.sdk.assistantName && text) {
      const esc = this.sdk.assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const triggerRegex = new RegExp(`^@${esc}\\b`, 'i');
      const mentionRegex = new RegExp(`@${esc}\\b`, 'i');
      if (mentionRegex.test(text) && !triggerRegex.test(text)) {
        text = `@${this.sdk.assistantName} ${text}`;
      }
    }

    if (!text) return;

    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();

    this.opts.onChatMetadata(jid, timestamp, roomName, 'matrix', isGroup);
    this.opts.onMessage(jid, {
      id: `${ts}-${++this.messageId}`,
      chat_jid: jid,
      sender: senderName,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async connect() {
    // CRYPTO OFF: Do NOT call initRustCrypto() here (see module-level comment).
    // The client is created with only a MemoryStore — no crypto initialisation.
    // /sync and plain text messaging work fully unencrypted without it.

    // Lazy matrix-js-sdk import — only loaded here so unit tests never need the dep.
    const makeClient =
      this._makeClient ??
      (async (opts) => {
        const sdk = await import('matrix-js-sdk');
        const store = new sdk.MemoryStore();
        return sdk.createClient({
          baseUrl: opts.baseUrl,
          userId: opts.userId,
          accessToken: opts.accessToken,
          store,
        });
      });

    this.client = await makeClient({
      baseUrl: this.config.homeserverUrl,
      userId: this.config.userId,
      accessToken: this.config.accessToken,
    });

    // Initial-sync guard: only start processing timeline events after PREPARED.
    this.client.on('sync', (state) => {
      if (state === 'PREPARED') {
        this.syncReady = true;
        this.sdk.logger.info(
          'matrix: sync reached PREPARED — processing live events',
        );
      }
    });

    // Register the Room.timeline listener.
    this.client.on('Room.timeline', (event, room) => {
      try {
        this._handleTimelineEvent(event, room);
      } catch (err) {
        this.sdk.logger.warn(
          { err: String(err) },
          'matrix: _handleTimelineEvent failed',
        );
      }
    });

    await this.client.startClient();
    this.connected = true;
    this.sdk.logger.info('matrix: connected (/sync long-poll)');
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
        'matrix: sendMessage called but client not connected',
      );
      return;
    }
    const roomId = this._roomIdFromJid(jid);
    for (const c of this.chunk(text, MAX_MESSAGE_LENGTH)) {
      try {
        await this.client.sendTextMessage(roomId, c);
      } catch (err) {
        this.sdk.logger.error({ jid, err: String(err) }, 'matrix: send failed');
      }
    }
  }

  async setTyping(jid, isTyping) {
    if (!this.ownsJid(jid) || !this.client) return;
    const roomId = this._roomIdFromJid(jid);
    try {
      await this.client.sendTyping(roomId, isTyping, 20000);
    } catch (err) {
      this.sdk.logger.debug({ err: String(err) }, 'matrix: typing failed');
    }
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    this.connected = false;
    if (this.client) {
      try {
        this.client.stopClient();
      } catch {
        // ignore stop errors
      }
      this.client = null;
    }
  }
}

// ── Config parser ─────────────────────────────────────────────────────────────
function parseConfig(sdk) {
  const env = sdk.readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_USER_ID',
    'MATRIX_ACCESS_TOKEN',
  ]);

  const homeserverUrl = (
    process.env.MATRIX_HOMESERVER_URL ||
    env.MATRIX_HOMESERVER_URL ||
    ''
  ).trim();
  const userId = (
    process.env.MATRIX_USER_ID ||
    env.MATRIX_USER_ID ||
    ''
  ).trim();
  const accessToken = (
    process.env.MATRIX_ACCESS_TOKEN ||
    env.MATRIX_ACCESS_TOKEN ||
    ''
  ).trim();

  if (!homeserverUrl || !userId || !accessToken) {
    sdk.logger.warn(
      'matrix: MATRIX_HOMESERVER_URL, MATRIX_USER_ID, and MATRIX_ACCESS_TOKEN are all required',
    );
    return null;
  }

  // Validate MATRIX_USER_ID looks like @user:server
  if (!/^@[^:]+:.+$/.test(userId)) {
    sdk.logger.warn(
      { userId },
      'matrix: MATRIX_USER_ID must be in the form @user:server',
    );
    return null;
  }

  // Validate homeserver looks like a URL
  try {
    new URL(homeserverUrl);
  } catch {
    sdk.logger.warn(
      { homeserverUrl },
      'matrix: MATRIX_HOMESERVER_URL must be a valid URL (e.g. https://matrix.org)',
    );
    return null;
  }

  return { homeserverUrl, userId, accessToken };
}

// ── Registration ──────────────────────────────────────────────────────────────
export default function register(sdk) {
  sdk.registerChannel('matrix', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new MatrixChannel(cfg, opts, sdk);
  });
}

// Exported for unit testing of pure helpers (ignored by the runtime loader,
// which only calls the default export).
export { MatrixChannel, parseConfig };
