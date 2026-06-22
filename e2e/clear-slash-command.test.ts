/**
 * e2e tests for Story 14: User clears conversation history via the /clear chat command.
 *
 * Acceptance criteria:
 *  AC1. POST /message containing `/clear` returns an SSE reply containing "cleared" within 5 s,
 *       with no LLM call required.
 *  AC2. After a /clear, prior content is not re-surfaced in a follow-up reply.
 *       (LLM-dependent — skipped when no live LLM provider is reachable at LIVE_LLM_BASE_URL.)
 *  AC3. /clear on an already-empty history still replies gracefully (no error, contains "cleared").
 *  AC4. alice's /clear does not affect bob's history (verified via /search after clear).
 *  AC5. After /clear, the SQLite conversation_history row count for alice's group folder is 0
 *       (verified by running a Node.js snippet inside the channel pod).
 *
 * Implementation note:
 *  At the time of writing, `isCompactCommand` / `handleCompactCommand` exist in
 *  `src/runtime/compression-commands.ts` but are NOT imported or wired into the
 *  channel-runner dispatch loop (`src/channel-runner.ts`). This is a product gap.
 *  These tests will fail on AC1/AC3/AC4/AC5 until that wire-up is added.
 *
 * Prerequisites:
 *  - minikube cluster (context: minikube)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup from racing this install)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { LIVE_BASE_URL, LIVE_MODEL, LIVE_API_KEY, probeLiveLlm }
  from './lib/live-llm.js';

const NS = 'kubeclaw-e2e-clear';
const RELEASE = 'ke2e-clear';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14097;
const HTTP_PORT = 4080; // channel pod's httpPort (default)

// Users
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpw';

// Comma-separated user list ("user:pass,user:pass") as parsed by http channel
const HTTP_USERS = `${ALICE_USER}:${ALICE_PASS},${BOB_USER}:${BOB_PASS}`;

// The group folder for each user via HTTP channel:
//   jidToFolder("http", "http:alice") → prefix "http", sanitize "http:alice" → "http-alice" → "http-http-alice"
const ALICE_GROUP_FOLDER = 'http-http-alice';
const BOB_GROUP_FOLDER = 'http-http-bob';

// DB path inside channel pod (channel type = "http")
const DB_PATH = '/app/store/messages-http.db';

// LIVE LLM probe (for AC2 skip guard) — configured via LIVE_LLM_BASE_URL env var.

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const SSE_REPLY_TIMEOUT_MS = 20_000;
const CLEAR_REPLY_TIMEOUT_MS = 5_000; // AC1 requires reply within 5 s

let portForwardProc: ChildProcess | null = null;

// ── Skip flags (module-level, evaluated before describe/it body) ──────────────

const clusterReachable = (() => {
  try {
    execSync(`kubectl --context ${CONTEXT} cluster-info`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
})();

// Probe live LLM provider synchronously via top-level await (Vitest ESM).
let liveLlmAvailable = false;
let liveLlmSkipReason = '';

async function runLlmProbe(): Promise<void> {
  if (!clusterReachable) {
    liveLlmSkipReason = 'no Kubernetes cluster';
    return;
  }
  const result = await probeLiveLlm();
  liveLlmAvailable = result.ok;
  liveLlmSkipReason = result.reason;
}

await runLlmProbe();

const skipAc2 = !clusterReachable || !liveLlmAvailable;

// ── Helpers ───────────────────────────────────────────────────────────────────

function kube(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(
      `kubectl --context ${CONTEXT} --namespace ${NS} ${args}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * POST a message to the channel via the forwarded port and return the HTTP status.
 */
async function postMessage(
  user: string,
  pass: string,
  text: string,
): Promise<number> {
  const res = await fetch(`http://localhost:${LOCAL_PORT}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/**
 * Start an SSE listener, then POST a message, wait for matching reply, stop.
 * Returns { status, replyLines }.
 */
async function sendAndCollect(
  user: string,
  pass: string,
  text: string,
  matcher: (lines: string[]) => boolean,
  timeoutMs = SSE_REPLY_TIMEOUT_MS,
): Promise<{ status: number; replyLines: string[] }> {
  const controller = new AbortController();
  const sseLines: string[] = [];
  let done = false;

  // Start SSE listener BEFORE POST so we do not miss the reply
  const ssePromise = fetch(`http://localhost:${LOCAL_PORT}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200) return;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            sseLines.push(line.slice(6));
          }
        }
      }
    } catch {
      // AbortError expected on cleanup
    }
  });

  // Give SSE time to connect before sending POST
  await sleep(500);

  const status = await postMessage(user, pass, text);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher(sseLines)) break;
    await sleep(300);
  }

  done = true;
  controller.abort();
  await ssePromise.catch(() => {});

  return { status, replyLines: sseLines };
}

/**
 * Wait until the port-forward is accepting connections.
 */
async function waitForPortForward(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LOCAL_PORT}/`, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: basicAuth('probe', 'x') },
      });
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new Error(
    `Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`,
  );
}

/**
 * Kill any stale process on LOCAL_PORT, then start a fresh port-forward to the channel pod.
 */
async function startPortForward(): Promise<ChildProcess> {
  execSync(`fuser -k ${LOCAL_PORT}/tcp 2>/dev/null || true`, { shell: true });
  await sleep(1000);

  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const pf = spawn(
    'kubectl',
    [
      '--context', CONTEXT,
      '--namespace', NS,
      'port-forward',
      `pod/${channelPodName}`,
      `${LOCAL_PORT}:${HTTP_PORT}`,
    ],
    { stdio: 'ignore', detached: false },
  );

  await waitForPortForward(30_000);
  return pf;
}

/**
 * Seed rows into conversation_history inside the channel pod by running a
 * Node.js snippet with sql.js. Rows are written to the on-disk DB file.
 * The channel pod is then restarted so its in-memory sql.js instance reloads
 * from disk.
 */
async function seedConversationHistory(
  rows: Array<{ groupFolder: string; role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const rowsJson = JSON.stringify(
    rows.map((r) => ({
      ...r,
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })),
  );

  const script = `
(async () => {
  const fs = require('node:fs');
  const { randomUUID } = require('node:crypto');
  const initSqlJs = require('/app/node_modules/sql.js');
  const SQL = await initSqlJs({
    locateFile: () => '/app/node_modules/sql.js/dist/sql-wasm.wasm',
  });
  const dbPath = '${DB_PATH}';
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found at ' + dbPath);
    process.exit(1);
  }
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(data));
  const rows = ${rowsJson};
  const now = new Date().toISOString();
  for (const row of rows) {
    const id = row.id || randomUUID();
    db.run(
      'INSERT OR IGNORE INTO conversation_history (id, group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, row.groupFolder, row.groupFolder, row.role, row.content, now]
    );
    db.run(
      'INSERT OR IGNORE INTO conversation_history_fts (id, group_folder, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, row.groupFolder, row.role, row.content, now]
    );
  }
  const buffer = Buffer.from(db.export());
  fs.writeFileSync(dbPath, buffer);
  db.close();
  console.log('seeded ' + rows.length + ' rows');
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

  const result = spawnSync(
    'kubectl',
    [
      '--context', CONTEXT,
      '-n', NS,
      'exec',
      `pod/${channelPodName}`,
      '--',
      'node', '-e', script,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `seedConversationHistory failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.includes('seeded')) {
    throw new Error(
      `seedConversationHistory unexpected output: ${result.stdout}`,
    );
  }

  // Restart the channel pod so its in-memory sql.js instance reloads from disk
  if (portForwardProc) {
    portForwardProc.kill();
    portForwardProc = null;
  }

  execSync(
    `kubectl --context ${CONTEXT} rollout restart deployment/kubeclaw-channel-http -n ${NS}`,
    { stdio: 'pipe' },
  );
  execSync(
    `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=120s`,
    { stdio: 'inherit' },
  );

  // Restart port-forward against the new pod
  portForwardProc = await startPortForward();
  await sleep(2000);
}

/**
 * Count conversation_history rows for a given group folder by running a Node.js
 * snippet inside the channel pod.
 */
function countConversationRows(groupFolder: string): number {
  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const script = `
(async () => {
  const fs = require('node:fs');
  const initSqlJs = require('/app/node_modules/sql.js');
  const SQL = await initSqlJs({
    locateFile: () => '/app/node_modules/sql.js/dist/sql-wasm.wasm',
  });
  const dbPath = '${DB_PATH}';
  if (!fs.existsSync(dbPath)) {
    console.log('0');
    return;
  }
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(data));
  const res = db.exec(
    'SELECT COUNT(*) FROM conversation_history WHERE group_folder = ?',
    ['${groupFolder}']
  );
  const count = res[0]?.values[0]?.[0] ?? 0;
  db.close();
  console.log(String(count));
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

  const result = spawnSync(
    'kubectl',
    [
      '--context', CONTEXT,
      '-n', NS,
      'exec',
      `pod/${channelPodName}`,
      '--',
      'node', '-e', script,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `countConversationRows failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return parseInt(result.stdout.trim(), 10);
}

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  '/clear slash command end-to-end (Story 14)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    // Unique tokens to seed — and then verify don't resurface after /clear (AC2/AC4)
    const aliceSecretToken = `story14-alice-secret-${Date.now()}`;
    const bobSecretToken = `story14-bob-secret-${Date.now()}`;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for namespace termination
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, {
            stdio: 'pipe',
          });
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write a values file so that the multi-user string (containing commas)
      // does not hit helm's --set comma-as-array-separator parsing.
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-clear-'));
      const valuesFile = path.join(valuesDir, 'values.yaml');
      writeFileSync(
        valuesFile,
        [
          `namespace: ${NS}`,
          `image:`,
          `  tag: e2e-test`,
          `  pullPolicy: IfNotPresent`,
          `credentialInjection:`,
          `  mode: "off"`,
          `  broker:`,
          `    image: kubeclaw-orchestrator:e2e-test`,
          `orchestrator:`,
          `  replicas: 1`,
          `channels:`,
          `  http:`,
          `    enabled: true`,
          `    type: http`,
          `    httpPort: ${HTTP_PORT}`,
          `    envVars:`,
          `      - name: HTTP_CHANNEL_USERS`,
          `        key: users`,
          `secrets:`,
          `  httpChannelUsers: "${HTTP_USERS}"`,
          `networkPolicy:`,
          `  enabled: false`,
        ].join('\n'),
      );

      try {
        execSync(
          [
            `helm --kube-context ${CONTEXT} upgrade --install ${RELEASE} ./helm/kubeclaw`,
            `--namespace ${NS} --create-namespace`,
            `-f ${valuesFile}`,
          ].join(' '),
          { stdio: 'inherit', timeout: 120_000 },
        );
      } finally {
        rmSync(valuesDir, { recursive: true, force: true });
      }
      installed = true;

      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      portForwardProc = await startPortForward();

      // Give services a moment to be fully ready
      await sleep(3000);

      // Seed conversation history rows for alice (AC2/AC4/AC5) and bob (AC4):
      //  - alice: aliceSecretToken rows that should be cleared by /clear
      //  - bob: bobSecretToken rows that must NOT be cleared by alice's /clear
      await seedConversationHistory([
        {
          groupFolder: ALICE_GROUP_FOLDER,
          role: 'user',
          content: `Alice remembers the ${aliceSecretToken} value`,
        },
        {
          groupFolder: ALICE_GROUP_FOLDER,
          role: 'assistant',
          content: `Sure, the ${aliceSecretToken} value is stored`,
        },
        {
          groupFolder: BOB_GROUP_FOLDER,
          role: 'user',
          content: `Bob's unique token is ${bobSecretToken}`,
        },
        {
          groupFolder: BOB_GROUP_FOLDER,
          role: 'assistant',
          content: `Yes, ${bobSecretToken} noted`,
        },
      ]);
    }, INSTALL_TIMEOUT);

    afterAll(() => {
      if (portForwardProc) {
        portForwardProc.kill();
        portForwardProc = null;
      }
      if (installed) {
        execSync(
          `helm --kube-context ${CONTEXT} uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
        execSync(
          `kubectl --context ${CONTEXT} delete namespace ${NS} --wait=false 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
      }
    }, 60_000);

    // ── AC1: /clear replies with "cleared" within 5 s, no LLM call ───────────

    it(
      'AC1: /clear replies with "cleared" within 5 s without an LLM call',
      async () => {
        const start = Date.now();

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/clear',
          (lines) => lines.some((l) => /cleared/i.test(l)),
          CLEAR_REPLY_TIMEOUT_MS,
        );

        const elapsed = Date.now() - start;

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(
          replyText,
          'Reply must contain "cleared" (case-insensitive)',
        ).toMatch(/cleared/i);

        expect(
          elapsed,
          `Reply must arrive within ${CLEAR_REPLY_TIMEOUT_MS} ms (no LLM round-trip)`,
        ).toBeLessThan(CLEAR_REPLY_TIMEOUT_MS);
      },
      TEST_TIMEOUT,
    );

    // ── AC2: after /clear, prior content is not re-surfaced ──────────────────
    // Gated on live LLM availability.

    it.skipIf(skipAc2)(
      `AC2: after /clear, prior content is not re-surfaced by LLM (skipped if no live LLM: ${liveLlmSkipReason || 'provider available'})`,
      async () => {
        // Ask the LLM to recall the previously seeded secret token.
        // After /clear the LLM has no history so it cannot produce the token.
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          'What was the unique value I mentioned earlier? Repeat it exactly.',
          (lines) => lines.length > 0,
          SSE_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // The LLM must not reproduce the token because the history was cleared.
        expect(
          replyText,
          `Reply must not contain the previously cleared token "${aliceSecretToken}"`,
        ).not.toContain(aliceSecretToken);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: /clear on empty history still replies gracefully ─────────────────
    // At this point alice's history was already cleared by AC1, so this is an
    // effectively empty history. Re-send /clear and expect a graceful reply.

    it(
      'AC3: /clear on an already-empty history replies gracefully (no error, contains "cleared")',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/clear',
          (lines) => lines.some((l) => /cleared/i.test(l)),
          CLEAR_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Must reply gracefully
        expect(
          replyText,
          'Reply must contain "cleared" (case-insensitive)',
        ).toMatch(/cleared/i);

        // Must not be a stack trace
        expect(
          replyText,
          'Reply must not contain "Error:" (stack trace indicator)',
        ).not.toMatch(/^Error:/m);
        expect(
          replyText,
          'Reply must not contain stack-frame indicator ("    at ")',
        ).not.toMatch(/^\s{4}at /m);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: alice's /clear does not affect bob's history ────────────────────

    it(
      "AC4: alice's /clear does not affect bob's history (bob's /search still finds his messages)",
      async () => {
        // Bob searches for his unique token — it should still be present
        const { status, replyLines } = await sendAndCollect(
          BOB_USER,
          BOB_PASS,
          `/search ${bobSecretToken}`,
          (lines) =>
            lines.some(
              (l) =>
                l.toLowerCase().includes('found') ||
                l.toLowerCase().includes('result') ||
                l.toLowerCase().includes('no results'),
            ),
          SSE_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message (bob) must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Bob's history must not be empty — his token must be found
        expect(
          replyText,
          `Bob's /search must find his token "${bobSecretToken}"`,
        ).toContain(bobSecretToken);

        // Bob's reply must indicate results, not "no results"
        expect(
          replyText,
          "Bob's /search must return results, not 'No results'",
        ).not.toMatch(/no results/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: SQLite conversation_history row count → 0 after /clear ──────────

    it(
      'AC5: conversation_history row count for alice is 0 after /clear (verified via kubectl exec)',
      () => {
        // /clear was already triggered in AC1. Read the on-disk DB directly.
        const count = countConversationRows(ALICE_GROUP_FOLDER);
        expect(
          count,
          `conversation_history must have 0 rows for ${ALICE_GROUP_FOLDER} after /clear`,
        ).toBe(0);
      },
      TEST_TIMEOUT,
    );
  },
);
