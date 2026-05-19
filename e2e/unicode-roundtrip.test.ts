/**
 * Unicode/emoji round-trip end-to-end tests (Story 28).
 *
 * Deploys kubeclaw into the isolated namespace `kubeclaw-e2e-unicode` with a
 * single HTTP-channel user (alice). POSTs Unicode payloads to the channel's
 * POST /message endpoint, then probes the SQLite `messages` table inside the
 * channel pod to verify byte-for-byte content preservation.
 *
 * The suite is LLM-independent: it never waits for an LLM reply. All five ACs
 * rely on the inbound-message path (POST → storeMessage → messages table) which
 * runs synchronously within the HTTP handler before any async LLM work begins.
 *
 * ACs:
 *   1. POST emoji+CJK ("Hello 🌍 こんにちは") → 200 + content preserved in DB
 *   2. POST Arabic RTL ("مرحبا بالعالم") → 200 + content preserved in DB
 *   3. UTF-8 round-trip via POST → DB (same path SSE inbound and DB use)
 *   4. 10 KB multi-byte payload (2500 × 🔥) → 200 + byte length preserved in DB
 *   5. Unauthenticated Unicode POST → 401
 *
 * Port: 14113 — unique, does not clash with any other e2e suite.
 * Run with: KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts unicode-roundtrip
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-unicode';
const RELEASE = 'ke2e-unicode';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14113;
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepass';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Run kubectl in the test namespace; returns { ok, stdout, stderr }. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Run kubectl at cluster scope (no namespace flag). */
function kcCluster(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Poll until fn() returns truthy or timeoutMs elapses. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Wait for the HTTP channel pod to be Ready. */
async function waitForChannelPod(timeoutMs = 180_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get', 'pods',
        '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

/** Start a port-forward to the HTTP channel service. */
async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover kubectl from a previous run.
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], { stdio: 'pipe' });
  await sleep(1000);

  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT)], { stdio: 'pipe' });
    if (nc.status === 0) return;
  }
  throw new Error(`Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 20s`);
}

/**
 * Run a Node.js script inside the channel pod to query the SQLite messages DB.
 *
 * The channel DB is at /app/store/messages-http.db (KUBECLAW_CHANNEL=http).
 * We use sql.js (already bundled in /app/node_modules/sql.js) to read it in
 * the channel container — no sqlite3 binary required.
 *
 * Returns trimmed stdout from the script.
 */
function queryChannelDb(script: string, opts: { timeout?: number } = {}): string {
  // Locate the channel pod name.
  const pods = kc([
    'get', 'pods', '-l', 'app=kubeclaw-channel-http',
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  if (!pods.ok || !pods.stdout.trim()) {
    throw new Error(`Could not find channel pod: ${pods.stderr}`);
  }
  const podName = pods.stdout.trim();

  const r = spawnSync(
    'kubectl',
    ['-n', NAMESPACE, 'exec', podName, '-c', 'channel', '--', 'node', '-e', script],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30_000 },
  );
  if (r.status !== 0) {
    throw new Error(`kubectl exec script failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * Build a Node.js script that queries the messages table for a given chat_jid
 * and returns all contents as a JSON array string.
 *
 * chat_jid for the HTTP channel alice user is 'http:alice'.
 */
function buildMessagesQueryScript(chatJid: string): string {
  return `
const fs = require('node:fs');
const initSqlJs = require('/app/node_modules/sql.js');
(async () => {
  const SQL = await initSqlJs();
  // Try canonical channel DB path first; fall back to generic path.
  const candidates = [
    '/app/store/messages-http.db',
    '/app/store/messages.db',
  ];
  let dbPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { dbPath = p; break; }
  }
  if (!dbPath) {
    const { execSync } = require('node:child_process');
    const found = execSync('find /app/store /app/groups /data -name "*.db" 2>/dev/null || true')
      .toString().trim().split('\\n').filter(Boolean);
    if (found.length === 0) {
      console.log(JSON.stringify([]));
      return;
    }
    dbPath = found[0];
  }
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(data));
  const rows = db.exec(
    "SELECT content FROM messages WHERE chat_jid = '${chatJid}' ORDER BY timestamp DESC LIMIT 20"
  );
  const values = (rows[0] && rows[0].values) ? rows[0].values.map(r => r[0]) : [];
  console.log(JSON.stringify(values));
})().catch(e => { console.error('SCRIPT_ERROR:' + e.message); process.exit(1); });
`;
}

/**
 * POST a text message to the HTTP channel and return the HTTP status code.
 * Retries up to 5 times if the port-forward is not yet ready.
 */
async function postMessage(text: string, user = HTTP_USER, pass = HTTP_PASS): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(user, pass),
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    } catch {
      if (attempt < 4) await sleep(1000);
    }
  }
  throw new Error(`POST /message failed after 5 attempts`);
}

/**
 * POST a text message and poll the messages DB until a row with the expected
 * content appears (up to 15s). Returns the matching content string or throws.
 */
async function postAndVerifyDb(text: string): Promise<string> {
  const chatJid = `http:${HTTP_USER}`;
  const script = buildMessagesQueryScript(chatJid);

  const status = await postMessage(text);
  if (status !== 200) {
    throw new Error(`POST /message returned HTTP ${status}, expected 200`);
  }

  // Poll DB for up to 15s — the HTTP handler stores synchronously but the pod
  // may need a moment to flush the WAL to disk (saveDatabase calls fs.writeSync).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    let rows: string[] = [];
    try {
      const out = queryChannelDb(script, { timeout: 20_000 });
      rows = JSON.parse(out) as string[];
    } catch {
      // Retry on script errors (e.g. DB not yet written).
      continue;
    }
    const match = rows.find((r) => r === text);
    if (match !== undefined) return match;
  }
  throw new Error(`Content not found in DB within 15s for text: ${text.slice(0, 60)}`);
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

beforeAll(async () => {
  // Tear down any leftover release and namespace from a prior run.
  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8', stdio: 'pipe',
  });
  spawnSync('kubectl', [
    'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true', '--timeout=60s',
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 });

  // Pre-create the namespace with Helm ownership metadata.
  spawnSync('kubectl', ['create', 'namespace', NAMESPACE], { encoding: 'utf8' });
  spawnSync('kubectl', [
    'label', 'namespace', NAMESPACE, 'app.kubernetes.io/managed-by=Helm',
  ], { encoding: 'utf8' });
  spawnSync('kubectl', [
    'annotate', 'namespace', NAMESPACE,
    `meta.helm.sh/release-name=${RELEASE}`,
    `meta.helm.sh/release-namespace=${NAMESPACE}`,
  ], { encoding: 'utf8' });

  // Install kubeclaw with the HTTP channel enabled. We use stub LLM credentials
  // (test-key / no-key) — LLM responses are never needed for this suite.
  const helmResult = spawnSync(
    'helm',
    [
      'upgrade', '--install', RELEASE, CHART_DIR,
      '--namespace', NAMESPACE,
      '--timeout', '180s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', 'secrets.claudeCodeOauthToken=test-token',
      '--set', 'secrets.openaiApiKey=no-key',
      '--set-string', 'secrets.openaiBaseUrl=http://127.0.0.1:19999/v1',
      '--set-string', 'secrets.directLlmModel=test-model',
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=4080',
      '--set-string', `secrets.httpChannelUsers=${HTTP_USER}:${HTTP_PASS}`,
      '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set', 'channels.http.envVars[0].key=users',
      '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set', 'channels.http.envVars[1].key=port',
      '--set', 'channels.http.envVars[1].optional=true',
      '--set', 'credentialInjection.mode=off',
      '--set', 'redis.password=e2e-unicode-redis-pass',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );
  if (helmResult.status !== 0) {
    throw new Error(
      `helm install failed (exit ${helmResult.status}):\nstderr: ${helmResult.stderr}\nstdout: ${helmResult.stdout}`,
    );
  }

  await waitForChannelPod(240_000);
  await startPortForward();

  // Warm up: send a primer message so the channel auto-registers alice's group
  // (jid=http:alice). The DB write happens synchronously on POST but group
  // registration happens via onChatMetadata which also needs a moment.
  // We send the primer and allow up to 5s for the pod to process it.
  for (let i = 0; i < 5; i++) {
    try {
      const status = await postMessage('primer');
      if (status === 200) break;
    } catch {
      // port-forward not ready yet
    }
    await sleep(1000);
  }
  await sleep(2000);
}, 360_000);

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], { stdio: 'pipe' });

  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8', stdio: 'pipe',
  });
  spawnSync('kubectl', [
    'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s',
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 });
}, 120_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Unicode/emoji round-trip (Story 28)', () => {
  /**
   * AC1: Emoji + CJK round-trip.
   *
   * POST "Hello 🌍 こんにちは" → expect HTTP 200 and the messages table to
   * contain the exact byte sequence (verified via sql.js inside the pod).
   *
   * "Hello 🌍 こんにちは" encodes to 25 bytes in UTF-8:
   *   "Hello " (6) + "🌍" (4) + " " (1) + "こんにちは" (15) = 26 bytes.
   * The DB column is TEXT (SQLite stores UTF-8); content must equal the
   * original string character-for-character.
   */
  it('AC1: emoji+CJK POST returns 200 and content matches byte-for-byte in DB', async () => {
    const text = 'Hello 🌍 こんにちは';
    const stored = await postAndVerifyDb(text);
    expect(stored).toBe(text);
  }, 60_000);

  /**
   * AC2: Arabic RTL round-trip.
   *
   * POST "مرحبا بالعالم" (Arabic: "Hello World") → expect HTTP 200 and the
   * messages table to contain the exact content. Arabic is stored as UTF-8
   * regardless of visual directionality — the DB must preserve the raw code
   * points unchanged.
   */
  it('AC2: Arabic RTL POST returns 200 and content matches byte-for-byte in DB', async () => {
    const text = 'مرحبا بالعالم';
    const stored = await postAndVerifyDb(text);
    expect(stored).toBe(text);
  }, 60_000);

  /**
   * AC3: UTF-8 round-trip via POST → DB.
   *
   * Verifies that the inbound-message path — POST /message → storeMessage →
   * messages table — preserves a mixed Unicode payload (Latin + emoji + CJK +
   * Arabic). This is the same storage path that SSE inbound uses, confirming
   * UTF-8 is carried intact through the full inbound pipeline.
   */
  it('AC3: mixed Unicode round-trip via POST → DB preserves all code points', async () => {
    const text = 'Mixed: café ☕ 日本語 мир مرحبا';
    const stored = await postAndVerifyDb(text);
    expect(stored).toBe(text);
    // Sanity: the stored string's codepoint count matches the original.
    expect([...stored].length).toBe([...text].length);
  }, 60_000);

  /**
   * AC4: 10 KB multi-byte payload (2500 × 🔥).
   *
   * Each 🔥 is 4 bytes in UTF-8, so 2500 × 🔥 = 10 000 bytes.
   * POST the large payload → expect HTTP 200, and the stored content in the
   * DB must have exactly 2500 Unicode code points, each being 🔥 (U+1F525).
   * This verifies no truncation, mojibake, or surrogate mishandling occurred.
   */
  it('AC4: 10 KB multi-byte payload (2500 × fire emoji) returns 200 and length preserved', async () => {
    const text = '🔥'.repeat(2500); // 10 000 UTF-8 bytes
    // JS string length counts UTF-16 code units (surrogates): 2 per emoji.
    expect(text.length).toBe(2500 * 2);
    // Unicode code points: [...]  iterates over code points, so 2500 total.
    expect([...text].length).toBe(2500);
    expect(Buffer.byteLength(text, 'utf8')).toBe(10_000);

    const status = await postMessage(text);
    expect(status, `POST /message returned HTTP ${status}, expected 200`).toBe(200);

    // Poll DB for up to 20s — large content may take slightly longer to flush.
    const chatJid = `http:${HTTP_USER}`;
    const script = buildMessagesQueryScript(chatJid);
    let found = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(500);
      let rows: string[] = [];
      try {
        const out = queryChannelDb(script, { timeout: 25_000 });
        rows = JSON.parse(out) as string[];
      } catch {
        continue;
      }
      // [...r] iterates Unicode code points; 2500 × 🔥 = 2500 code points.
      const match = rows.find((r) => [...r].length === 2500);
      if (match !== undefined) {
        // Verify every code point is 🔥 (U+1F525).
        const cps = [...match];
        expect(cps.length).toBe(2500);
        for (let i = 0; i < cps.length; i++) {
          expect(cps[i], `Code point at index ${i} is not 🔥`).toBe('🔥');
        }
        found = true;
        break;
      }
    }
    expect(found, '10 KB fire emoji payload not found in DB within 20s').toBe(true);
  }, 90_000);

  /**
   * AC5: Unauthenticated Unicode POST → 401.
   *
   * An unauthenticated POST carrying a Unicode body must be rejected with
   * HTTP 401 — authentication is checked before any message processing.
   * The Unicode content does not affect the authentication gate.
   */
  it('AC5: unauthenticated Unicode POST returns 401', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'مرحبا 🌍 こんにちは' }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status, `expected 401 from unauthenticated POST, got ${res.status}`).toBe(401);
  }, 30_000);
});
