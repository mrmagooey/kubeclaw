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
 *
 * HOW THIS FILE IS LOADED:
 *   The orchestrator exec-pushes this file to /runtime at commit time (after the
 *   bootstrap skill calls commit_channel_config). The steady-state channel pod runs
 *   container/agent-runner/channel-loader.js, which does only:
 *     await import('/runtime/channel-entry.js')
 *   This file MUST self-execute on import — there is no external caller that
 *   invokes an exported function. The `export default function register(ctx)`
 *   pattern belongs to Path-C plugin loading, NOT this path.
 *
 * TODO: Forwarding inbound Signal messages into KubeClaw's agent loop is
 *   operator-specific (depends on the chosen Signal client's event API) and is
 *   not shown in this skeleton. Wire the client's message event to the harness
 *   IPC channel once you have chosen a concrete library.
 */

// Replace 'signal-client' with your chosen pure-JS Signal library.
import { SignalClient } from 'signal-client';
import http from 'node:http';

const PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER ?? '';
if (!PHONE_NUMBER) {
  console.error('[signal] SIGNAL_PHONE_NUMBER not set — exiting');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? '8080', 10);

// ── Signal client (placeholder — replace with real library API) ───────────────
let _client = null;
let _connected = false;

/** Connect to the Signal network and subscribe to inbound messages. */
async function connect() {
  // TODO: initialise the Signal client with the phone number and any stored
  // registration state, then link or register the device.
  _client = new SignalClient({ phoneNumber: PHONE_NUMBER });

  // TODO: subscribe to inbound messages from the Signal network and forward
  // them into KubeClaw's agent loop via the harness IPC mechanism.
  // Example (library-specific):
  //   _client.on('message', (envelope) => { /* ... */ });

  await _client.connect();
  _connected = true;
  console.error(`[signal] connected as ${PHONE_NUMBER}`);
}

/** Send a text message to a JID of the form 'signal:+61412345678'. */
async function sendMessage(jid, text) {
  // TODO: strip the 'signal:' prefix and call the client's send API.
  const recipient = jid.replace(/^signal:/, '');
  await _client.sendMessage({ recipient, message: text });
}

function isConnected() {
  return _connected;
}

/** Returns true when this channel owns the given JID. */
function ownsJid(jid) {
  return jid.startsWith('signal:');
}

async function disconnect() {
  _connected = false;
  await _client?.disconnect?.();
  console.error('[signal] disconnected');
}

// ── Health endpoints ──────────────────────────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', connected: _connected }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
healthServer.listen(PORT, '0.0.0.0', () =>
  console.error(`[signal] health endpoint on :${PORT}`),
);

// ── Startup ───────────────────────────────────────────────────────────────────
connect().catch((err) => {
  console.error('[signal] connect() failed:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.error('[signal] SIGTERM — disconnecting');
  await disconnect();
  healthServer.close(() => process.exit(0));
});
