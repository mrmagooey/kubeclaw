/**
 * Signal channel skeleton for KubeClaw — TEMPLATE, not production-ready.
 *
 * IMPORTANT — choose a pure-JS Signal client:
 *   Native-binding Signal libraries (signal-cli, node-libsignal-client) require
 *   native compilation and fight `npm ci --ignore-scripts`. Use a pure-JS
 *   client that installs cleanly without build tools.
 *   Replace the import below with your chosen library's actual package name and
 *   API before wiring into Helm values.
 *
 *   Candidates (operator must evaluate licensing/maintenance):
 *     - @signalapp/mock-server (for testing only)
 *     - A REST bridge: run signal-cli as a sidecar and call its JSON-RPC HTTP API
 *       from this file using Node's built-in `fetch`.
 *
 * CREDENTIALS:
 *   SIGNAL_PHONE_NUMBER  — the registered Signal phone number, e.g. +61412345678
 *
 * NODE ESM NOTE:
 *   This file uses ES module `import` syntax. Node 22 auto-detects ESM when the
 *   file extension is .js and the nearest package.json has `"type":"module"`.
 *   The bootstrap step writes /runtime/package.json from the channel manifest, so
 *   add `"type":"module"` there to silence the "use --input-type=module" warning.
 */

// Replace 'signal-client' with your chosen pure-JS Signal library.
import { SignalClient } from 'signal-client';
import http from 'node:http';

const PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER ?? '';
if (!PHONE_NUMBER) {
  console.error('[signal] SIGNAL_PHONE_NUMBER not set — exiting');
  process.exit(1);
}

// ── Injected at runtime by the channel harness ───────────────────────────────
// The bootstrap skill runs `commit_channel_config`, which causes the orchestrator
// to exec-push this file to /runtime and then import it. The harness wraps it via
// a thin loader that calls registerChannel() below.
// ─────────────────────────────────────────────────────────────────────────────

let _onMessage = null;
let _onChatMetadata = null;
let _client = null;

/** @param {import('./registry').ChannelPluginContext} ctx */
export default function register(ctx) {
  ctx.registerChannel('signal', (opts) => {
    if (!PHONE_NUMBER) return null;
    _onMessage = opts.onMessage;
    _onChatMetadata = opts.onChatMetadata;
    return new SignalChannel(opts);
  });
}

class SignalChannel {
  name = 'signal';

  /** @type {import('./registry').ChannelOpts} */
  #opts;
  #connected = false;

  /** @type {ReturnType<typeof http.createServer>} */
  #healthServer;

  constructor(opts) {
    this.#opts = opts;
  }

  async connect() {
    // TODO: initialise the Signal client, link or register the device, and
    // subscribe to incoming messages.
    _client = new SignalClient({ phoneNumber: PHONE_NUMBER });

    // Deliver inbound messages to the KubeClaw harness.
    _client.on('message', (envelope) => {
      const sender = envelope.source; // e.g. '+61412345678'
      const jid = `signal:${sender}`;
      const text = envelope.dataMessage?.body ?? '';
      const timestamp = new Date(envelope.timestamp).toISOString();
      this.#opts.onChatMetadata(jid, timestamp);
      this.#opts.onMessage(jid, { text, role: 'user', timestamp });
    });

    await _client.connect();
    this.#connected = true;

    // Health endpoints expected by the liveness probe.
    this.#healthServer = http.createServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/readyz') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', connected: this.#connected }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    const PORT = parseInt(process.env.PORT ?? '8080', 10);
    this.#healthServer.listen(PORT, '0.0.0.0', () =>
      console.error(`[signal] health endpoint on :${PORT}`),
    );
  }

  /** @param {string} jid  @param {string} text */
  async sendMessage(jid, text) {
    // jid is 'signal:+61412345678' — strip the prefix.
    const recipient = jid.replace(/^signal:/, '');
    await _client.sendMessage({ recipient, message: text });
  }

  isConnected() {
    return this.#connected;
  }

  /** @param {string} jid */
  ownsJid(jid) {
    return jid.startsWith('signal:');
  }

  async disconnect() {
    this.#connected = false;
    this.#healthServer?.close();
    await _client?.disconnect?.();
  }
}

process.on('SIGTERM', async () => {
  console.error('[signal] SIGTERM — disconnecting');
  // The channel instance is owned by the harness; SIGTERM handling is shown here
  // for completeness. The harness calls disconnect() before exit.
  process.exit(0);
});
