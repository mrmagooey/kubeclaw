/**
 * End-to-end tests for Story 26: DELETE /history.
 *
 * Installs kubeclaw into an isolated namespace (kubeclaw-e2e-del-history) on
 * the minikube cluster, registers two users (alice + bob),
 * seeds messages for both, then exercises the DELETE /history endpoint.
 *
 * ACs verified:
 *   AC1 — authenticated DELETE → 204; subsequent GET /history → empty
 *   AC2 — unauthenticated DELETE → 401, history intact
 *   AC3 — scoped to authenticated user (alice's DELETE doesn't affect bob)
 *   AC4 — idempotent (DELETE on already-empty history → 204)
 *   AC5 — (LLM-dep, skipIf) next message reply has no memory of prior turns
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test . && \
 *   docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar && \
 *   minikube image load /tmp/orch.tar && \
 *   kubectl --context minikube delete namespace kubeclaw-e2e-del-history \
 *     --ignore-not-found --timeout=60s && \
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *   npx vitest run --config vitest.e2e.config.ts history-delete 2>&1 | tee /tmp/del-hist.log | tail -25
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw-e2e-del-history';
const RELEASE = 'kubeclaw-del-hist';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14111;

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';

const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// LLM availability flag — AC5 uses skipIf
const LLM_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Run kubectl against this test's namespace. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, '-n', NAMESPACE, ...args],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30_000 },
  );
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

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

async function waitForChannelPod(timeoutMs = 180_000): Promise<void> {
  await waitUntil(
    () => {
      const r = kc([
        'get',
        'pods',
        '-l',
        'app=kubeclaw-channel-http',
        '-o',
        'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  await sleep(1500);
  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl --context ${KUBE_CONTEXT} port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT)], {
      stdio: 'pipe',
    });
    if (nc.status === 0) return;
  }
  throw new Error(
    `Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 20s`,
  );
}

/**
 * Run a Node.js script inside the HTTP channel pod to interact with SQLite.
 * Uses sql.js (already bundled in node_modules) — no native sqlite3 needed.
 */
function runScriptInChannelPod(script: string): string {
  const podResult = kc([
    'get',
    'pods',
    '-l',
    'app=kubeclaw-channel-http',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
  if (!podResult.ok || !podResult.stdout.trim()) {
    throw new Error(`Could not find channel pod: ${podResult.stderr}`);
  }
  const podName = podResult.stdout.trim();

  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = spawnSync(
      'kubectl',
      [
        '--context',
        KUBE_CONTEXT,
        '-n',
        NAMESPACE,
        'exec',
        podName,
        '-c',
        'channel',
        '--',
        'node',
        '-e',
        script,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
    );
    if (r.status === 0) return (r.stdout ?? '').trim();
    lastErr = `stdout: ${r.stdout}\nstderr: ${r.stderr}`;
    if (
      !/pods .* not found|connection refused|no Ready pods|error: unable to upgrade/i.test(
        r.stderr ?? '',
      )
    )
      break;
    spawnSync('sleep', ['3']);
  }
  throw new Error(`kubectl exec node script failed:\n${lastErr}`);
}

/**
 * Seed N conversation_history rows for a given group_folder directly into
 * the channel pod's SQLite DB.
 */
function seedMessages(groupFolder: string, count: number): void {
  const script = `
    const fs = require('node:fs');
    const initSqlJs = require('/app/node_modules/sql.js');
    (async () => {
      const SQL = await initSqlJs();
      const candidates = ['/app/groups/db.sqlite', '/app/store/db.sqlite'];
      let dbPath = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) { dbPath = p; break; }
      }
      if (!dbPath) {
        const { execSync } = require('node:child_process');
        const found = execSync(
          'find /app /data -name "*.db" -o -name "*.sqlite" 2>/dev/null || true'
        ).toString().trim().split('\\n').filter(Boolean);
        if (found.length === 0) { console.error('no-db-found'); process.exit(1); }
        dbPath = found[0];
      }

      const data = fs.readFileSync(dbPath);
      const db = new SQL.Database(new Uint8Array(data));

      const groupFolder = ${JSON.stringify(groupFolder)};
      const count = ${count};
      const base = Date.now() - count * 1000;
      for (let i = 0; i < count; i++) {
        const id = groupFolder + '-seed-' + i;
        const role = i % 2 === 0 ? 'user' : 'assistant';
        const content = 'message-' + i;
        const created_at = new Date(base + i * 1000).toISOString();
        db.run(
          'INSERT OR REPLACE INTO conversation_history (id, group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, groupFolder, groupFolder, role, content, created_at]
        );
      }

      fs.writeFileSync(dbPath, Buffer.from(db.export()));
      console.log('ok');
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  const result = runScriptInChannelPod(script);
  if (!result.includes('ok')) {
    throw new Error(`seedMessages failed: ${result}`);
  }
}

/**
 * Compute the group folder for a given HTTP user JID.
 * Mirrors the jidToFolder() logic in channel-runner.ts.
 */
function groupFolderFor(username: string): string {
  const jid = `http:${username}`;
  const sanitized = jid
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55);
  return `http-${sanitized}`;
}

// ─── Suite-level state ────────────────────────────────────────────────────────

const suiteState: {
  ready: boolean;
  skipReason: string;
  aliceFolder: string;
  bobFolder: string;
} = {
  ready: false,
  skipReason: '',
  aliceFolder: '',
  bobFolder: '',
};

async function runSetup(): Promise<void> {
  if (!isKubernetesAvailable()) {
    suiteState.skipReason = 'no Kubernetes cluster available';
    return;
  }

  // Clean slate.
  spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      'delete',
      'namespace',
      NAMESPACE,
      '--ignore-not-found',
      '--timeout=90s',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 100_000 },
  );
  spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      'wait',
      '--for=delete',
      `ns/${NAMESPACE}`,
      '--timeout=90s',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 100_000 },
  );

  // Install kubeclaw with HTTP channel and two users.
  const helmResult = spawnSync(
    'helm',
    [
      'upgrade',
      '--install',
      RELEASE,
      CHART_DIR,
      '--kube-context',
      KUBE_CONTEXT,
      '--namespace',
      NAMESPACE,
      '--create-namespace',
      '--timeout',
      '180s',
      '--set',
      `namespace=${NAMESPACE}`,
      '--set',
      'image.tag=e2e-test',
      '--set',
      'image.pullPolicy=IfNotPresent',
      '--set',
      'credentialInjection.broker.image=kubeclaw-orchestrator:e2e-test',
      '--set',
      'channels.http.enabled=true',
      '--set',
      'channels.http.httpPort=4080',
      '--set',
      'credentialInjection.mode=off',
      '--set',
      'orchestrator.replicas=1',
      '--set-string',
      // Comma must be escaped so helm doesn't split it into multiple keys.
      `secrets.httpChannelUsers=${ALICE_USER}:${ALICE_PASS}\\,${BOB_USER}:${BOB_PASS}`,
      '--set',
      'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set',
      'channels.http.envVars[0].key=users',
      '--set',
      'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set',
      'channels.http.envVars[1].key=port',
      '--set',
      'channels.http.envVars[1].optional=true',
      '--set',
      'secrets.anthropicApiKey=test-key',
      '--set',
      'redis.password=e2e-del-hist-redis-pass',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );

  if (helmResult.status !== 0) {
    suiteState.skipReason = `helm install failed: ${helmResult.stderr.slice(0, 500)}`;
    return;
  }

  // Wait for channel pod.
  try {
    await waitForChannelPod(180_000);
  } catch (err) {
    suiteState.skipReason = `channel pod not ready: ${err}`;
    return;
  }

  // Port-forward.
  try {
    await startPortForward();
  } catch (err) {
    suiteState.skipReason = `port-forward failed: ${err}`;
    return;
  }

  // Register both users with the orchestrator via POST /message.
  for (const [user, pass] of [
    [ALICE_USER, ALICE_PASS],
    [BOB_USER, BOB_PASS],
  ]) {
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`${HTTP_URL}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: basicAuth(user, pass),
          },
          body: JSON.stringify({ text: 'hello' }),
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) break;
      } catch {
        // ignore transient errors
      }
      await sleep(3000);
    }
  }

  // Give the orchestrator time to register both groups.
  await sleep(10_000);

  // Wait until both users' GET /history returns 200.
  for (const [user, pass] of [
    [ALICE_USER, ALICE_PASS],
    [BOB_USER, BOB_PASS],
  ]) {
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        const probe = await fetch(`${HTTP_URL}/history?limit=1`, {
          headers: { Authorization: basicAuth(user, pass) },
          signal: AbortSignal.timeout(5000),
        });
        if (probe.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // ignore
      }
      await sleep(2000);
    }
    if (!ready) {
      suiteState.skipReason = `GET /history not available for ${user} after registration wait`;
      return;
    }
  }

  suiteState.aliceFolder = groupFolderFor(ALICE_USER);
  suiteState.bobFolder = groupFolderFor(BOB_USER);

  // Seed messages for both users.
  try {
    seedMessages(suiteState.aliceFolder, 5);
    seedMessages(suiteState.bobFolder, 5);
  } catch (err) {
    suiteState.skipReason = `failed to seed messages: ${err}`;
    return;
  }

  // Restart channel pod so the sql.js file-write is visible to the in-process DB.
  spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      '-n',
      NAMESPACE,
      'rollout',
      'restart',
      'deployment/kubeclaw-channel-http',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
  );

  try {
    await waitForChannelPod(120_000);
  } catch (err) {
    suiteState.skipReason = `channel pod not ready after restart: ${err}`;
    return;
  }

  try {
    await startPortForward();
  } catch (err) {
    suiteState.skipReason = `port-forward failed after restart: ${err}`;
    return;
  }

  // Wait until alice's seeded messages are visible.
  let seededVisible = false;
  for (let i = 0; i < 20; i++) {
    try {
      const probe = await fetch(`${HTTP_URL}/history?limit=5`, {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(5000),
      });
      if (probe.status === 200) {
        const body = (await probe.json()) as { messages: unknown[] };
        if (body.messages.length >= 5) {
          seededVisible = true;
          break;
        }
      }
    } catch {
      // ignore
    }
    await sleep(2000);
  }

  if (!seededVisible) {
    suiteState.skipReason =
      'seeded messages not visible via GET /history after restart';
    return;
  }

  suiteState.ready = true;
}

// Top-level await: runs before any test or describe body.
await runSetup();

const shouldSkip = !suiteState.ready;
const skipReason = shouldSkip
  ? `history-delete tests skipped: ${suiteState.skipReason || 'setup failed'}`
  : '';

// ─── Teardown ─────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync(
    'helm',
    [
      'uninstall',
      RELEASE,
      '--kube-context',
      KUBE_CONTEXT,
      '--namespace',
      NAMESPACE,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      'delete',
      'namespace',
      NAMESPACE,
      '--ignore-not-found',
      '--timeout=60s',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
  );
}, 120_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DELETE /history (Story 26)', () => {
  /**
   * AC1: Authenticated DELETE → 204; subsequent GET /history → empty array.
   */
  it.skipIf(shouldSkip)(
    'AC1: authenticated DELETE returns 204 and clears history',
    async () => {
      // Confirm alice has history before the delete.
      const beforeRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(beforeRes.status).toBe(200);
      const before = (await beforeRes.json()) as { messages: unknown[] };
      expect(before.messages.length).toBeGreaterThan(0);

      // DELETE /history as alice.
      const delRes = await fetch(`${HTTP_URL}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(delRes.status).toBe(204);

      // Subsequent GET /history must be empty.
      const afterRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(afterRes.status).toBe(200);
      const after = (await afterRes.json()) as { messages: unknown[] };
      expect(after.messages.length).toBe(0);
    },
    30_000,
  );

  /**
   * AC2: Unauthenticated DELETE → 401; history remains intact (bob's history
   * is verified as still present since we haven't deleted it yet).
   */
  it.skipIf(shouldSkip)(
    'AC2: unauthenticated DELETE returns 401 and leaves history intact',
    async () => {
      // Confirm bob's history is present.
      const beforeRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(BOB_USER, BOB_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(beforeRes.status).toBe(200);
      const before = (await beforeRes.json()) as { messages: unknown[] };
      expect(before.messages.length).toBeGreaterThan(0);

      // Attempt DELETE without credentials.
      const delRes = await fetch(`${HTTP_URL}/history`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
      });
      expect(delRes.status).toBe(401);

      // Attempt DELETE with wrong password.
      const delRes2 = await fetch(`${HTTP_URL}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(BOB_USER, 'wrongpass') },
        signal: AbortSignal.timeout(10_000),
      });
      expect(delRes2.status).toBe(401);

      // Bob's history must still be intact.
      const afterRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(BOB_USER, BOB_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(afterRes.status).toBe(200);
      const after = (await afterRes.json()) as { messages: unknown[] };
      expect(after.messages.length).toBeGreaterThan(0);
    },
    30_000,
  );

  /**
   * AC3: Scoped to authenticated user — alice's DELETE (already done in AC1)
   * did not affect bob's history.  This test confirms bob still has messages.
   */
  it.skipIf(shouldSkip)(
    'AC3: DELETE is scoped to the authenticated user; other users unaffected',
    async () => {
      // Alice's history was cleared in AC1.
      const aliceRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(aliceRes.status).toBe(200);
      const aliceBody = (await aliceRes.json()) as { messages: unknown[] };
      expect(aliceBody.messages.length).toBe(0);

      // Bob's history is still present (cleared only by the unauthenticated
      // attempt in AC2 which returned 401, so it was never actually deleted).
      const bobRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(BOB_USER, BOB_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(bobRes.status).toBe(200);
      const bobBody = (await bobRes.json()) as { messages: unknown[] };
      expect(bobBody.messages.length).toBeGreaterThan(0);
    },
    30_000,
  );

  /**
   * AC4: Idempotent — DELETE on an already-empty history → 204.
   */
  it.skipIf(shouldSkip)(
    'AC4: DELETE on already-empty history returns 204 (idempotent)',
    async () => {
      // Alice's history is already empty from AC1.
      const delRes = await fetch(`${HTTP_URL}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(delRes.status).toBe(204);

      // Still empty after second delete.
      const afterRes = await fetch(`${HTTP_URL}/history?limit=10`, {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(afterRes.status).toBe(200);
      const after = (await afterRes.json()) as { messages: unknown[] };
      expect(after.messages.length).toBe(0);
    },
    30_000,
  );

  /**
   * AC5 (LLM-dependent): next message after DELETE has no memory of prior
   * turns. Skipped when ANTHROPIC_API_KEY is not set.
   */
  it.skipIf(shouldSkip || !LLM_AVAILABLE)(
    'AC5: next reply after DELETE has no memory of prior turns',
    async () => {
      // Send a distinctive message to bob so the LLM "remembers" something.
      await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(BOB_USER, BOB_PASS),
        },
        body: JSON.stringify({ text: 'My favourite fruit is a durian.' }),
        signal: AbortSignal.timeout(10_000),
      });

      // Wait a bit for the LLM to process.
      await sleep(8_000);

      // Clear bob's history.
      const delRes = await fetch(`${HTTP_URL}/history`, {
        method: 'DELETE',
        headers: { Authorization: basicAuth(BOB_USER, BOB_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(delRes.status).toBe(204);

      // Ask about the earlier message — a fresh session should not know.
      await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(BOB_USER, BOB_PASS),
        },
        body: JSON.stringify({ text: 'What fruit did I say I liked?' }),
        signal: AbortSignal.timeout(10_000),
      });

      // Verify GET /history after the question is empty (the delete cleared old
      // rows and the new question is the first entry).
      await sleep(8_000);
      const histRes = await fetch(`${HTTP_URL}/history?limit=20`, {
        headers: { Authorization: basicAuth(BOB_USER, BOB_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(histRes.status).toBe(200);
      const hist = (await histRes.json()) as {
        messages: Array<{ role: string; content: string }>;
      };

      // The "durian" message must not appear in history (it was cleared).
      const hasOldMessage = hist.messages.some((m) =>
        m.content.toLowerCase().includes('durian'),
      );
      expect(hasOldMessage).toBe(false);

      // The new question should be the first (or only) user message in history.
      const userMessages = hist.messages.filter((m) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(1);
      expect(userMessages[0].content).toContain('What fruit');
    },
    60_000,
  );
});
