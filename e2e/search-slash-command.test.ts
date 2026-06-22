/**
 * e2e tests for Story 11: User searches their conversation history via the /search chat command.
 *
 * Acceptance criteria:
 *  AC1. POST /message containing `/search <unique-token>` — where the token was previously
 *       seeded into conversation_history — returns an SSE reply listing that message with
 *       a date stamp and a snippet containing the token.
 *  AC2. POST /message containing `/search xqzz-no-match-e2e` returns an SSE reply matching
 *       "No results" (case-insensitive).
 *  AC3. POST /message containing `/search --limit 1 <token>` when two matches exist returns
 *       exactly one result line (contains `[1]` but not `[2]`).
 *  AC4. Results are scoped to the current user's group — bob's messages do not appear in
 *       alice's search results.
 *  AC5. A bare `/search` returns usage help (contains "search" or "Usage", case-insensitive)
 *       and no stack-trace indicators.
 *
 * LLM-independent — slash commands are intercepted in channel-runner.ts before the LLM queue.
 *
 * Test data is seeded by running a Node.js snippet inside the channel pod using the
 * app's own sql.js (already bundled in /app/node_modules) so that FTS4 triggers fire
 * within a consistent sql.js environment. The channel pod is then restarted to reload
 * the on-disk DB into its in-memory sql.js instance.
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

const NS = 'kubeclaw-e2e-search';
const RELEASE = 'ke2e-search';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14096;
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

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const SSE_REPLY_TIMEOUT_MS = 20_000;

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

/**
 * POST a message to the channel via the forwarded port and return the HTTP status.
 */
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
  throw new Error(`Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`);
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
 * Seed rows into conversation_history (and the FTS4 index) inside the channel pod
 * by running a Node.js snippet with sql.js. Rows are written to the on-disk DB file.
 * The channel pod is then restarted so its in-memory sql.js instance reloads from disk.
 *
 * @param rows Array of { groupFolder, role, content } to insert.
 */
async function seedConversationHistory(
  rows: Array<{ groupFolder: string; role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  // Build the insert statements for the Node.js script.
  // We use crypto.randomUUID() to generate IDs and insert into both
  // conversation_history and conversation_history_fts so the FTS index matches.
  const rowsJson = JSON.stringify(
    rows.map((r) => ({ ...r, id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` })),
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
    throw new Error(`seedConversationHistory failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  if (!result.stdout.includes('seeded')) {
    throw new Error(`seedConversationHistory unexpected output: ${result.stdout}`);
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

// ── Skip guard ────────────────────────────────────────────────────────────────

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

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  '/search slash command end-to-end (Story 11)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    // Shared unique token used across AC1 / AC2 / AC3 / AC4
    const aliceToken = `story11-alice-${Date.now()}`;
    const dupToken = `story11-dup-${Date.now()}`;
    const bobToken = `story11-bob-${Date.now()}`;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for namespace termination
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, { stdio: 'pipe' });
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write a values file so that the multi-user string (containing commas)
      // does not hit helm's --set comma-as-array-separator parsing.
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-search-'));
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

      // Seed conversation history rows for AC1, AC3, and AC4 tests:
      //  - alice: aliceToken (one row) — for AC1
      //  - alice: dupToken (two rows) — for AC3
      //  - bob: aliceToken + bobToken — for AC4 (alice's search must NOT find bob's rows)
      await seedConversationHistory([
        // AC1: alice has one message with aliceToken
        { groupFolder: ALICE_GROUP_FOLDER, role: 'user', content: `Searching for ${aliceToken} in conversation` },
        // AC3: alice has two messages with dupToken
        { groupFolder: ALICE_GROUP_FOLDER, role: 'user', content: `First message containing ${dupToken}` },
        { groupFolder: ALICE_GROUP_FOLDER, role: 'assistant', content: `Second message also has ${dupToken} here` },
        // AC4: bob also has a message with aliceToken — alice's search should NOT return it
        { groupFolder: BOB_GROUP_FOLDER, role: 'user', content: `Bob sees ${aliceToken} from bob perspective` },
        { groupFolder: BOB_GROUP_FOLDER, role: 'user', content: `Bob unique ${bobToken} message` },
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

    // ── AC1: token match returns snippet with date stamp ──────────────────────

    it(
      'AC1: /search <token> returns a result containing the token and a date stamp',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/search ${aliceToken}`,
          (lines) => lines.some((l) => l.toLowerCase().includes('found') || l.toLowerCase().includes('result')),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Reply must report at least one result
        expect(replyText, 'Reply must contain "Found" or "result"').toMatch(/found|result/i);

        // Reply must contain the token in a snippet
        expect(replyText, `Reply must contain the token "${aliceToken}"`).toContain(aliceToken);

        // Reply must contain a date stamp in format YYYY-MM-DD
        expect(replyText, 'Reply must contain a date stamp (YYYY-MM-DD)').toMatch(
          /\[\d{4}-\d{2}-\d{2}\]/,
        );

        // Reply must contain a result line starting with [1]
        expect(replyText, 'Reply must contain a numbered result [1]').toContain('[1]');
      },
      TEST_TIMEOUT,
    );

    // ── AC2: no-match query returns "No results" ──────────────────────────────

    it(
      'AC2: /search <no-match-string> returns "No results" reply',
      async () => {
        const noMatchQuery = 'xqzz-no-match-e2e';

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/search ${noMatchQuery}`,
          (lines) => lines.some((l) => l.toLowerCase().includes('no results') || l.toLowerCase().includes('no result')),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(replyText, 'Reply must contain "No results"').toMatch(/no results/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: --limit 1 caps result count to one ───────────────────────────────

    it(
      'AC3: /search --limit 1 <token> returns exactly one result when two matches exist',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/search --limit 1 ${dupToken}`,
          (lines) => lines.some((l) => l.includes('[1]')),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Must contain exactly one numbered result
        expect(replyText, 'Reply must contain result [1]').toContain('[1]');
        expect(replyText, 'Reply must NOT contain result [2] due to --limit 1').not.toContain('[2]');
      },
      TEST_TIMEOUT,
    );

    // ── AC4: group isolation — alice cannot see bob's messages ────────────────

    it(
      "AC4: alice's /search does not return bob's messages",
      async () => {
        // Alice searches for the aliceToken — bob also has a row with aliceToken
        // but it must NOT appear in alice's results (group isolation).
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/search ${aliceToken}`,
          (lines) => lines.some((l) =>
            l.toLowerCase().includes('found') ||
            l.toLowerCase().includes('result') ||
            l.toLowerCase().includes('no results'),
          ),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Alice's result must exist (her own message was seeded)
        expect(replyText, 'Alice must get at least one result for her own message').toMatch(
          /found|result/i,
        );

        // The reply must not reference bob's unique content
        expect(
          replyText,
          "Reply must not contain bob's unique group content",
        ).not.toContain('bob perspective');

        // Bob's unique token must not appear in alice's search
        expect(
          replyText,
          "Reply must not contain bob's unique token",
        ).not.toContain(bobToken);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: bare /search shows usage help ───────────────────────────────────

    it(
      'AC5: bare /search returns usage help, not a stack trace',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/search',
          (lines) => lines.some((l) =>
            /search|usage/i.test(l),
          ),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        // Must contain usage help
        expect(replyText, 'Reply must contain "search" or "Usage" (case-insensitive)').toMatch(
          /search|usage/i,
        );

        // Must NOT be a stack trace
        expect(replyText, 'Reply must not contain "Error:" (stack trace indicator)').not.toMatch(
          /^Error:/m,
        );
        expect(replyText, 'Reply must not contain "    at " (stack frame indicator)').not.toMatch(
          /^\s{4}at /m,
        );
      },
      TEST_TIMEOUT,
    );
  },
);
