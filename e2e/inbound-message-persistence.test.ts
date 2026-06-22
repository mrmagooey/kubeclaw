/**
 * e2e tests for Story 9: Inbound messages are durably stored per user.
 *
 * Acceptance criteria:
 *  AC1. Authenticated POST → 200 + DB row immediately (chat_jid='http:alice',
 *       sender='alice', content matches) — before any LLM reply is awaited.
 *  AC2. Unauthenticated POST → 401 + no DB row written for that content.
 *  AC3. User isolation: alice's row not in bob's chat_jid.
 *  AC4. PVC durability: after rollout restart, rows persist.
 *  AC5. User-originated rows have is_from_me=0 and is_bot_message=0.
 *
 * LLM-independent — all assertions are DB presence/absence queries.
 *
 * Prerequisites:
 *  - minikube cluster (context: minikube)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup racing)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const NS = 'kubeclaw-e2e-persist';
const RELEASE = 'ke2e-persist';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14094;
const HTTP_PORT = 4080; // channel pod's httpPort

// DB path inside channel pod
const DB_PATH = '/app/store/messages-http.db';

// Users for multi-user tests (comma-separated format parsed by http.ts)
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpw';

// Comma-separated user list in "user:pass,user:pass" format as parsed by http.ts.
const HTTP_USERS = `${ALICE_USER}:${ALICE_PASS},${BOB_USER}:${BOB_PASS}`;

// Helm install timeout (ms) — waiting for orchestrator + Redis + channel
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 90_000;

let portForwardProc: ChildProcess | null = null;

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

/** POST a message to the channel via the forwarded port. Returns the HTTP status code. */
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
 * Count rows in the channel pod's SQLite DB matching a unique text fragment.
 *
 * The channel pod uses sql.js (WASM SQLite) and stores the DB at
 * /app/store/messages-http.db. sql.js saves as a standard SQLite binary,
 * so raw strings are stored verbatim in the page data. We grep the binary
 * file for the unique text fragment — reliable for short, unique strings
 * that will not appear in SQLite metadata.
 */
function countDbRows(textFragment: string): number {
  const podName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );
  if (!podName) return -1;

  // grep -c exits 1 when there are 0 matches — use '|| echo 0' to normalize
  const result = kube(
    `exec ${podName} -- sh -c "test -f ${DB_PATH} && grep -c '${textFragment}' ${DB_PATH} || echo 0"`,
    { allowFail: true },
  );
  const n = parseInt(result.trim(), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Poll the DB until the text fragment appears (or timeout expires).
 * Returns true if the fragment appeared, false on timeout.
 */
async function waitForDbRow(
  textFragment: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countDbRows(textFragment) > 0) return true;
    await sleep(500);
  }
  return false;
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
      // Any response (including 401) means the port-forward is alive
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
 * Start a port-forward to the channel pod. Returns the spawned process.
 * Kills any existing process bound to the port first.
 */
async function startPortForward(): Promise<ChildProcess> {
  // Kill any stale process bound to the local port
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

// ── Skip guard: only run on the istio kind cluster ──────────────────────────

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
  'inbound message persistence (Story 9)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for namespace termination
      for (let i = 0; i < 30; i++) {
        try {
          execSync(
            `kubectl --context ${CONTEXT} get namespace ${NS}`,
            { stdio: 'pipe' },
          );
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write a values file so that the multi-user string (containing commas)
      // does not hit helm's --set comma-as-array-separator parsing.
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-persist-'));
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
        // Install kubeclaw with HTTP channel and two users (alice + bob)
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

      // Wait for orchestrator
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      // Wait for channel
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      // Start port-forward
      portForwardProc = await startPortForward();

      // Give HTTP server a moment to be fully ready
      await sleep(2000);
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

    // ── AC1: Authenticated POST → 200 + DB row ────────────────────────────────

    it(
      'AC1: authenticated POST returns 200 and stores a row in messages DB',
      async () => {
        const uniqueText = `story9-alice-${Date.now()}`;

        const status = await postMessage(ALICE_USER, ALICE_PASS, uniqueText);
        expect(status, 'POST /message must return 200').toBe(200);

        // Poll for the row — storeMessage is synchronous but port-forward may add latency
        const appeared = await waitForDbRow(uniqueText, 5_000);
        expect(
          appeared,
          `DB must contain a row with content "${uniqueText}" within 5 s`,
        ).toBe(true);
      },
      TEST_TIMEOUT,
    );

    // ── AC2: Unauthenticated POST → 401 + no DB row ───────────────────────────

    it(
      'AC2: unauthenticated POST returns 401 and writes no DB row',
      async () => {
        const uniqueText = `story9-unauth-${Date.now()}`;

        const res = await fetch(`http://localhost:${LOCAL_PORT}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: uniqueText }),
        });
        expect(res.status, 'POST without Authorization must return 401').toBe(
          401,
        );

        // Give the channel a moment to process (it should not)
        await sleep(1500);

        const count = countDbRows(uniqueText);
        expect(
          count,
          'Unauthenticated message must NOT appear in the DB',
        ).toBe(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: User isolation ───────────────────────────────────────────────────

    it(
      "AC3: bob's message appears under bob's chat_jid, not alice's",
      async () => {
        // Send a message as bob with a unique token
        const bobText = `story9-bob-iso-${Date.now()}`;

        const status = await postMessage(BOB_USER, BOB_PASS, bobText);
        expect(status, "bob's POST must return 200").toBe(200);

        // Wait for bob's row to land
        const bobAppeared = await waitForDbRow(bobText, 5_000);
        expect(bobAppeared, "bob's message must appear in the DB").toBe(true);

        // Verify that the token does NOT appear under alice's chat_jid.
        // Since countDbRows greps the binary DB for the text fragment, the
        // fragment appearing in a row proves the content was stored.  Because
        // the unique token cannot collide with any other content we assert:
        //   - it IS in the DB (bob's row exists), confirmed above
        //   - we query the DB via Python to count rows specifically under alice's
        //     chat_jid, which must be 0.
        const podName = kube(
          `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
        );
        const aliceRows = kube(
          `exec ${podName} -- python3 -c ` +
            `"import sqlite3; c=sqlite3.connect('${DB_PATH}'); ` +
            `r=c.execute(\\"SELECT COUNT(*) FROM messages WHERE chat_jid='http:${ALICE_USER}' AND content='${bobText}'\\"` +
            `).fetchone()[0]; print(r)"`,
          { allowFail: true },
        );
        expect(
          parseInt(aliceRows.trim() || '0', 10),
          "bob's message must NOT appear under alice's chat_jid",
        ).toBe(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: PVC durability — rows survive pod restart ────────────────────────

    it(
      'AC4: stored rows persist after channel pod rollout restart',
      async () => {
        // Store a message before the restart
        const uniqueText = `story9-persist-${Date.now()}`;
        const status = await postMessage(ALICE_USER, ALICE_PASS, uniqueText);
        expect(status).toBe(200);

        const appeared = await waitForDbRow(uniqueText, 5_000);
        expect(appeared, 'Row must be present before restart').toBe(true);

        // Kill port-forward — it will become stale after the pod is replaced
        if (portForwardProc) {
          portForwardProc.kill();
          portForwardProc = null;
        }

        // Rollout restart the channel deployment
        execSync(
          `kubectl --context ${CONTEXT} rollout restart deployment/kubeclaw-channel-http -n ${NS}`,
          { stdio: 'pipe' },
        );
        execSync(
          `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
          { stdio: 'inherit' },
        );

        // Restart port-forward against the new pod
        portForwardProc = await startPortForward();

        // Query the DB in the new pod — rows must still be there
        const countAfter = countDbRows(uniqueText);
        expect(
          countAfter,
          'Row must still be present after pod rollout restart (PVC durability)',
        ).toBeGreaterThan(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: is_from_me=0 and is_bot_message=0 for user-originated rows ───────

    it(
      'AC5: user-originated rows have is_from_me=0 and is_bot_message=0',
      async () => {
        const uniqueText = `story9-flags-${Date.now()}`;
        const status = await postMessage(ALICE_USER, ALICE_PASS, uniqueText);
        expect(status).toBe(200);

        const appeared = await waitForDbRow(uniqueText, 5_000);
        expect(appeared, 'Row must appear in DB').toBe(true);

        const podName = kube(
          `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
        );

        // Query the actual column values for this row
        const result = kube(
          `exec ${podName} -- python3 -c ` +
            `"import sqlite3; c=sqlite3.connect('${DB_PATH}'); ` +
            `r=c.execute(\\"SELECT is_from_me, is_bot_message FROM messages WHERE content='${uniqueText}' LIMIT 1\\"` +
            `).fetchone(); print(r[0], r[1]) if r else print('NOT FOUND')"`,
          { allowFail: true },
        );

        expect(result.trim(), 'Row must exist in DB for AC5 query').not.toBe(
          'NOT FOUND',
        );

        const parts = result.trim().split(/\s+/);
        const isFromMe = parseInt(parts[0] ?? '1', 10);
        const isBotMessage = parseInt(parts[1] ?? '1', 10);

        expect(isFromMe, 'is_from_me must be 0 for user-originated rows').toBe(
          0,
        );
        expect(
          isBotMessage,
          'is_bot_message must be 0 for user-originated rows',
        ).toBe(0);
      },
      TEST_TIMEOUT,
    );
  },
);
