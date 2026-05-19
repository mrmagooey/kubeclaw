/**
 * e2e tests for Story 16: User compacts their conversation history via
 * /compact and /summary chat commands.
 *
 * Acceptance criteria:
 *  AC1 (LLM-dep). POST /message "/compact" when history > default keep-window
 *       returns SSE reply containing "Compacted" (case-insensitive), a count
 *       of messages summarised, and a summary id — and SQLite row count drops.
 *  AC2 (LLM-dep). POST /message "/compact --keep 2" when ≥ 4 rows exist returns
 *       SSE reply confirming compaction; row count ≤ 2 afterwards.
 *  AC3. POST /message "/compact" when history is empty (or within keep-window)
 *       returns SSE reply containing "Nothing to compact" — graceful no-op.
 *  AC4. After AC1 compact, POST /message "/summary" returns SSE reply with
 *       non-empty summary text and "Summary" or "[1/" present.
 *  AC5. POST /message "/summary" before any compact returns SSE containing
 *       "No summary" — graceful empty-state.
 *
 * LLM gate: ACs 1 and 2 require a live LLM (summariser).  They are skipped
 * with it.skipIf() when KUBECLAW_NO_LLM=true or when no live provider is
 * reachable at LIVE_LLM_BASE_URL.
 *
 * Prerequisites:
 *  - kind cluster kubeclaw-e2e-istio (context: kind-kubeclaw-e2e-istio)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup from racing install)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-compact';
const RELEASE = 'ke2e-compact';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14101;
const HTTP_PORT = 4080;

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';

// Group folder for HTTP channel alice user:
//   jidToFolder("http", "http:alice") → "http-http-alice"
const ALICE_GROUP_FOLDER = 'http-http-alice';

// DB path inside channel pod
const DB_PATH = '/app/store/messages-http.db';

// Live LLM provider (for AC1/AC2 skip guard)
const LIVE_BASE_URL =
  process.env.LIVE_LLM_BASE_URL || 'http://192.168.7.100:8080/v1';
const LIVE_MODEL =
  process.env.LIVE_LLM_MODEL || 'gemma-4-E4B-it-Q4_0.gguf';
const LIVE_API_KEY = process.env.LIVE_LLM_API_KEY || 'no-key';

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const SSE_REPLY_TIMEOUT_MS = 20_000;
const FAST_REPLY_TIMEOUT_MS = 5_000; // no-LLM paths must reply quickly
const LLM_REPLY_TIMEOUT_MS = 90_000; // LLM summarisation can be slow

// ── Module-level skip flags ────────────────────────────────────────────────────

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

// Respect explicit KUBECLAW_NO_LLM=true override (e.g. from CI without a
// self-hosted provider).
const noLlmEnv = process.env.KUBECLAW_NO_LLM === 'true';

let liveLlmAvailable = false;
let liveLlmSkipReason = '';

async function probeLiveLlm(): Promise<void> {
  if (noLlmEnv) {
    liveLlmSkipReason = 'KUBECLAW_NO_LLM=true';
    return;
  }
  if (!clusterReachable) {
    liveLlmSkipReason = 'no Kubernetes cluster';
    return;
  }
  try {
    const modelsRes = await fetch(`${LIVE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!modelsRes.ok) {
      liveLlmSkipReason = `GET /models returned HTTP ${modelsRes.status}`;
      return;
    }
    const chatRes = await fetch(`${LIVE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LIVE_API_KEY}`,
      },
      body: JSON.stringify({
        model: LIVE_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!chatRes.ok) {
      liveLlmSkipReason = `POST /chat/completions returned HTTP ${chatRes.status}`;
      return;
    }
    const payload = (await chatRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    if (typeof payload.choices?.[0]?.message?.content !== 'string') {
      liveLlmSkipReason = 'malformed chat response';
      return;
    }
    liveLlmAvailable = true;
  } catch (err) {
    liveLlmSkipReason = err instanceof Error ? err.message : String(err);
  }
}

await probeLiveLlm();

const skipLlmDep = !clusterReachable || !liveLlmAvailable;

// ── State ─────────────────────────────────────────────────────────────────────

let portForwardProc: ChildProcess | null = null;

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

async function postMessage(user: string, pass: string, text: string): Promise<number> {
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
 * Start an SSE listener, POST a message, wait for a matching reply.
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
      // not ready
    }
    await sleep(1000);
  }
  throw new Error(
    `Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`,
  );
}

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
 * Seed rows into conversation_history by running a Node.js snippet inside
 * the channel pod, then restart the pod so its in-memory DB reloads.
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

  // Restart the channel pod so its in-memory sql.js reloads from disk
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

  portForwardProc = await startPortForward();
  await sleep(2000);
}

/**
 * Delete all conversation_history rows for a group folder by running a
 * Node.js snippet inside the channel pod, then restart so in-memory DB
 * is clean.
 */
async function clearConversationHistoryInPod(groupFolder: string): Promise<void> {
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
  if (!fs.existsSync(dbPath)) { console.log('nothing to clear'); return; }
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(data));
  db.run('DELETE FROM conversation_history WHERE group_folder = ?', ['${groupFolder}']);
  db.run('DELETE FROM conversation_history_fts WHERE group_folder = ?', ['${groupFolder}']);
  db.run('DELETE FROM conversation_summaries WHERE group_folder = ?', ['${groupFolder}']);
  const buffer = Buffer.from(db.export());
  fs.writeFileSync(dbPath, buffer);
  db.close();
  console.log('cleared');
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
      `clearConversationHistoryInPod failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

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

  portForwardProc = await startPortForward();
  await sleep(2000);
}

/**
 * Count conversation_history rows for a given group folder via kubectl exec.
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
  if (!fs.existsSync(dbPath)) { console.log('0'); return; }
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
  '/compact and /summary slash commands end-to-end (Story 16)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, {
            stdio: 'pipe',
          });
          await sleep(2000);
        } catch {
          break;
        }
      }

      // Write values file so commas in user strings don't hit helm's array-separator parsing
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-compact-'));
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
          `  httpChannelUsers: "${ALICE_USER}:${ALICE_PASS}"`,
          // Wire the live LLM provider into the channel pod so /compact can summarise.
          // Uses process.env values (defaulting to the same probe endpoint) so the
          // channel pod calls the same provider the test probed.
          `  openaiApiKey: "${LIVE_API_KEY}"`,
          `  openaiBaseUrl: "${LIVE_BASE_URL}"`,
          `  directLlmModel: "${LIVE_MODEL}"`,
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
      await sleep(3000);
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

    // ── AC5: /summary before any compact returns "No summary" ────────────────
    // Runs first (clean state) — does NOT depend on LLM.

    it(
      'AC5: /summary before any compact returns "No summary" (LLM-independent)',
      async () => {
        // Start with a clean slate so previous test runs don't affect this check
        await clearConversationHistoryInPod(ALICE_GROUP_FOLDER);

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/summary',
          (lines) =>
            lines.some(
              (l) =>
                /no summary/i.test(l) ||
                /no.*summary.*exists/i.test(l) ||
                /summary chain/i.test(l),
            ),
          FAST_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        // Must indicate there is no summary (graceful empty-state)
        expect(
          replyText,
          'Reply must indicate no summary exists (case-insensitive)',
        ).toMatch(/no summary/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: /compact on empty history returns "Nothing to compact" ───────────
    // LLM-independent.

    it(
      'AC3: /compact on empty/within-window history returns "Nothing to compact" (LLM-independent)',
      async () => {
        // History is already empty from AC5 clear
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/compact',
          (lines) =>
            lines.some(
              (l) =>
                /nothing to compact/i.test(l) ||
                /no conversation history/i.test(l) ||
                /all messages.*within.*keep/i.test(l),
            ),
          FAST_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        // The response is either "No conversation history to compact." or
        // "Nothing to compact — all messages are within the keep-window of N."
        expect(
          replyText,
          'Reply must indicate nothing was compacted (no-op path)',
        ).toMatch(/nothing to compact|no conversation history/i);

        // Must not be a stack trace
        expect(replyText).not.toMatch(/^Error:/m);
        expect(replyText).not.toMatch(/^\s{4}at /m);
      },
      TEST_TIMEOUT,
    );

    // ── AC1: /compact when history > default keep-window ─────────────────────
    // LLM-dependent (calls summarise()). We seed 22 messages (default keep
    // window = 20) so plain "/compact" has 2 messages to summarise.

    it.skipIf(skipLlmDep)(
      `AC1: /compact when history > keep-window replies with "Compacted", a count, and reduces row count (LLM-dep; skip: ${liveLlmSkipReason || 'provider available'})`,
      async () => {
        // Clear first so retries don't accumulate rows from previous attempts
        await clearConversationHistoryInPod(ALICE_GROUP_FOLDER);

        // Seed 22 messages so history.length (22) > default keepWindow (20)
        const rows: Array<{ groupFolder: string; role: 'user' | 'assistant'; content: string }> = [];
        for (let i = 1; i <= 22; i++) {
          rows.push({
            groupFolder: ALICE_GROUP_FOLDER,
            role: i % 2 === 1 ? 'user' : 'assistant',
            content: `Seeded message ${i} for compact AC1 test — unique token story16-ac1-${i}`,
          });
        }
        await seedConversationHistory(rows);

        const rowsBefore = countConversationRows(ALICE_GROUP_FOLDER);
        expect(
          rowsBefore,
          'Should have 22 seeded rows before compaction',
        ).toBe(22);

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/compact',
          (lines) =>
            lines.some((l) => /compacted/i.test(l)) ||
            lines.some((l) => /nothing to compact/i.test(l)),
          LLM_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(
          replyText,
          'Reply must contain "Compacted" (case-insensitive)',
        ).toMatch(/compacted/i);

        // Reply must include a numeric count of messages summarised
        expect(
          replyText,
          'Reply must include a message count (digit sequence)',
        ).toMatch(/\d+/);

        // Reply must include a summary id (the id string returned by insertSummary,
        // of the form "<group>-summary-<timestamp>-<rand>")
        expect(
          replyText,
          'Reply must include a summary id reference (contains "summary" and an id)',
        ).toMatch(/into summary\s+\S+/i);

        const rowsAfter = countConversationRows(ALICE_GROUP_FOLDER);
        expect(
          rowsAfter,
          'Row count must drop after /compact',
        ).toBeLessThan(rowsBefore);
      },
      TEST_TIMEOUT + LLM_REPLY_TIMEOUT_MS,
    );

    // ── AC4: /summary after AC1 compact includes the summary text ─────────────
    // LLM-dependent (summary was produced by LLM in AC1).

    it.skipIf(skipLlmDep)(
      `AC4: /summary after compact returns non-empty summary text with "[1/" or "Summary" (LLM-dep; skip: ${liveLlmSkipReason || 'provider available'})`,
      async () => {
        // AC1 must have run first and produced a summary; if this test is
        // reached then AC1 passed (skipIf is the same guard).
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/summary',
          (lines) =>
            lines.some(
              (l) =>
                /\[1\//i.test(l) ||
                /summary/i.test(l),
            ),
          FAST_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Must contain either the chain-header "[1/" or "Summary" (case-insensitive)
        expect(
          replyText,
          'Reply must contain "[1/" or "Summary" (case-insensitive)',
        ).toMatch(/\[1\/|summary/i);

        // Must not be the no-summary message
        expect(
          replyText,
          'Reply must not be the empty-state message',
        ).not.toMatch(/no summary exists/i);

        // Text must be non-trivially long (at least 20 chars of actual content)
        expect(replyText.trim().length).toBeGreaterThan(20);
      },
      TEST_TIMEOUT,
    );

    // ── AC2: /compact --keep 2 leaves ≤ 2 rows ───────────────────────────────
    // LLM-dependent.

    it.skipIf(skipLlmDep)(
      `AC2: /compact --keep 2 with ≥ 4 rows leaves ≤ 2 rows in SQLite (LLM-dep; skip: ${liveLlmSkipReason || 'provider available'})`,
      async () => {
        // Seed 4 fresh messages for this AC (clear first so state is predictable)
        await clearConversationHistoryInPod(ALICE_GROUP_FOLDER);
        await seedConversationHistory([
          {
            groupFolder: ALICE_GROUP_FOLDER,
            role: 'user',
            content: 'Message one for AC2 keep-window test — story16-ac2-a',
          },
          {
            groupFolder: ALICE_GROUP_FOLDER,
            role: 'assistant',
            content: 'Response one for AC2 keep-window test — story16-ac2-b',
          },
          {
            groupFolder: ALICE_GROUP_FOLDER,
            role: 'user',
            content: 'Message two for AC2 keep-window test — story16-ac2-c',
          },
          {
            groupFolder: ALICE_GROUP_FOLDER,
            role: 'assistant',
            content: 'Response two for AC2 keep-window test — story16-ac2-d',
          },
        ]);

        const rowsBefore = countConversationRows(ALICE_GROUP_FOLDER);
        expect(rowsBefore, 'Need ≥ 4 rows before compact --keep 2').toBeGreaterThanOrEqual(4);

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/compact --keep 2',
          (lines) =>
            lines.some((l) => /compacted/i.test(l)) ||
            lines.some((l) => /nothing to compact/i.test(l)),
          LLM_REPLY_TIMEOUT_MS,
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(
          replyText,
          'Reply must confirm compaction occurred',
        ).toMatch(/compacted/i);

        const rowsAfter = countConversationRows(ALICE_GROUP_FOLDER);
        expect(
          rowsAfter,
          'Row count must be ≤ 2 after /compact --keep 2',
        ).toBeLessThanOrEqual(2);
      },
      TEST_TIMEOUT + LLM_REPLY_TIMEOUT_MS,
    );
  },
);
