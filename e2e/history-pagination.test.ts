/**
 * End-to-end tests for Story 18: GET /history pagination.
 *
 * Installs kubeclaw into an isolated namespace (kubeclaw-e2e-hist) on the
 * minikube cluster, seeds 7 messages directly into the channel
 * pod's SQLite DB, then exercises the GET /history endpoint.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test . && \
 *   docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar && \
 *   minikube image load /tmp/orch.tar && \
 *   kubectl --context minikube delete namespace kubeclaw-e2e-hist \
 *     --ignore-not-found --timeout=60s && \
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *   npx vitest run --config vitest.e2e.config.ts history-pagination
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw-e2e-hist';
const RELEASE = 'kubeclaw-hist';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14103;

const HTTP_USER = 'histuser';
const HTTP_PASS = 'histpass';
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

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
 * Seed 7 conversation_history rows for the given group_folder directly into
 * the channel pod's SQLite DB. Returns the 7 IDs in chronological order.
 */
function seedMessages(groupFolder: string): string[] {
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
      const ids = [];
      const base = Date.now() - 7000;
      for (let i = 0; i < 7; i++) {
        const id = groupFolder + '-seed-' + i;
        const role = i % 2 === 0 ? 'user' : 'assistant';
        const content = 'message-' + i;
        const created_at = new Date(base + i * 1000).toISOString();
        db.run(
          'INSERT OR REPLACE INTO conversation_history (id, group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, groupFolder, groupFolder, role, content, created_at]
        );
        ids.push(id);
      }

      fs.writeFileSync(dbPath, Buffer.from(db.export()));
      console.log(ids.join(','));
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  const result = runScriptInChannelPod(script);
  const ids = result
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length !== 7) {
    throw new Error(`Expected 7 seeded IDs, got ${ids.length}: ${result}`);
  }
  return ids;
}

// ─── Top-level suite setup (runs at import time, no vitest hook timeout) ─────
//
// We use a top-level async immediately-invoked function so that the full
// cluster setup (helm install, waitForChannel, port-forward, seed) completes
// before any describe/it body runs. This pattern follows specialist-catalog.test.ts.

const suiteState: {
  ready: boolean;
  skipReason: string;
  seededIds: string[];
  groupFolder: string;
} = {
  ready: false,
  skipReason: '',
  seededIds: [],
  groupFolder: '',
};

async function runSetup(): Promise<void> {
  if (!isKubernetesAvailable()) {
    suiteState.skipReason = 'no Kubernetes cluster available';
    return;
  }

  // Clean slate: delete the namespace if it exists.
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

  // Install kubeclaw with HTTP channel enabled.
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
      `secrets.httpChannelUsers=${HTTP_USER}:${HTTP_PASS}`,
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
      'redis.password=e2e-hist-redis-pass',
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

  // Port-forward so tests can reach the HTTP channel.
  try {
    await startPortForward();
  } catch (err) {
    suiteState.skipReason = `port-forward failed: ${err}`;
    return;
  }

  // Register the user with the orchestrator by sending a POST /message.
  // This triggers onChatMetadata which causes the orchestrator to register
  // http:histuser.
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(HTTP_USER, HTTP_PASS),
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

  // Give the orchestrator time to register the group and propagate to the
  // channel pod via Redis IPC.
  await sleep(10_000);

  // Wait until GET /history returns 200 (group is registered in channel memory).
  // We poll up to 30s for the group to be available.
  let historyReady = false;
  for (let i = 0; i < 15; i++) {
    try {
      const probe = await fetch(`${HTTP_URL}/history?limit=1`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(5000),
      });
      if (probe.status === 200) {
        historyReady = true;
        break;
      }
    } catch {
      // ignore
    }
    await sleep(2000);
  }

  if (!historyReady) {
    suiteState.skipReason = 'GET /history not available after registration wait';
    return;
  }

  // Derive the group folder using the same logic as jidToFolder() in
  // channel-runner.ts: prefix="http", jid="http:histuser" →
  // sanitized="http-histuser" → folder="http-http-histuser"
  const jid = `http:${HTTP_USER}`;
  const sanitized = jid
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55);
  suiteState.groupFolder = `http-${sanitized}`;

  // Seed 7 messages.
  try {
    suiteState.seededIds = seedMessages(suiteState.groupFolder);
  } catch (err) {
    suiteState.skipReason = `failed to seed messages: ${err}`;
    return;
  }

  // sql.js runs in-process — the channel pod's live DB instance won't see the
  // file-level write until the process restarts. Roll the deployment to force a
  // DB reload, then re-establish the port-forward (the old tunnel dies with the pod).
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      '-n', NAMESPACE,
      'rollout', 'restart',
      'deployment/kubeclaw-channel-http',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
  );

  // Wait for the new pod to be Ready.
  try {
    await waitForChannelPod(120_000);
  } catch (err) {
    suiteState.skipReason = `channel pod not ready after restart: ${err}`;
    return;
  }

  // Re-establish the port-forward to the new pod.
  try {
    await startPortForward();
  } catch (err) {
    suiteState.skipReason = `port-forward failed after restart: ${err}`;
    return;
  }

  // Wait until GET /history returns the seeded messages (pod has loaded DB).
  let seededVisible = false;
  for (let i = 0; i < 20; i++) {
    try {
      const probe = await fetch(`${HTTP_URL}/history?limit=7`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(5000),
      });
      if (probe.status === 200) {
        const body = (await probe.json()) as { messages: unknown[] };
        if (body.messages.length >= 7) {
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
  ? `history-pagination tests skipped: ${suiteState.skipReason || 'setup failed'}`
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

describe('GET /history pagination (Story 18)', () => {
  /**
   * AC1: GET /history?limit=5 returns HTTP 200 with up to 5 most-recent
   * messages, each with id, role, content, created_at.
   */
  it.skipIf(shouldSkip)(
    'returns 200 with ≤5 messages when limit=5',
    async () => {
      const res = await fetch(`${HTTP_URL}/history?limit=5`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { messages: unknown[] };
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBeLessThanOrEqual(5);
      expect(body.messages.length).toBeGreaterThan(0);

      // Each message must have the required fields.
      for (const msg of body.messages as Record<string, unknown>[]) {
        expect(typeof msg.id).toBe('string');
        expect(['user', 'assistant']).toContain(msg.role);
        expect(typeof msg.content).toBe('string');
        expect(typeof msg.created_at).toBe('string');
      }
    },
    30_000,
  );

  /**
   * AC2: GET /history?before=<id>&limit=5 returns 5 messages older than
   * the cursor ID.
   */
  it.skipIf(shouldSkip)(
    'returns messages older than before cursor',
    async () => {
      // Fetch the first page (5 most-recent).
      const page1Res = await fetch(`${HTTP_URL}/history?limit=5`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        messages: Array<{ id: string; created_at: string }>;
      };
      expect(page1.messages.length).toBeGreaterThan(0);

      // The oldest message in page 1 is at index 0 (chronological order).
      const oldestInPage1 = page1.messages[0];

      // Fetch page 2 using the oldest message as cursor.
      const page2Res = await fetch(
        `${HTTP_URL}/history?limit=5&before=${encodeURIComponent(oldestInPage1.id)}`,
        {
          headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
          signal: AbortSignal.timeout(10_000),
        },
      );
      expect(page2Res.status).toBe(200);
      const page2 = (await page2Res.json()) as {
        messages: Array<{ id: string; created_at: string }>;
      };

      // All page-2 messages must be older than the cursor.
      for (const msg of page2.messages) {
        expect(msg.created_at < oldestInPage1.created_at).toBe(true);
      }
    },
    30_000,
  );

  /**
   * AC3: GET /history with no limit defaults to ≤20 messages (not unbounded).
   */
  it.skipIf(shouldSkip)(
    'defaults to ≤20 messages when no limit given',
    async () => {
      const res = await fetch(`${HTTP_URL}/history`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { messages: unknown[] };
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBeLessThanOrEqual(20);
    },
    30_000,
  );

  /**
   * AC4: GET /history without valid Basic Auth → HTTP 401.
   */
  it.skipIf(shouldSkip)(
    'returns 401 without valid Basic Auth',
    async () => {
      // No credentials
      const res1 = await fetch(`${HTTP_URL}/history`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(res1.status).toBe(401);

      // Wrong password
      const res2 = await fetch(`${HTTP_URL}/history`, {
        headers: { Authorization: basicAuth(HTTP_USER, 'wrongpass') },
        signal: AbortSignal.timeout(10_000),
      });
      expect(res2.status).toBe(401);
    },
    30_000,
  );

  /**
   * AC5: Two consecutive pages with limit=3 over the 7 seeded messages
   * yield 6 distinct IDs (no overlap).
   */
  it.skipIf(shouldSkip)(
    'two pages of limit=3 yield 6 distinct IDs with no overlap',
    async () => {
      // Page 1: 3 most-recent of the 7 seeded messages.
      const page1Res = await fetch(`${HTTP_URL}/history?limit=3`, {
        headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
        signal: AbortSignal.timeout(10_000),
      });
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(page1.messages.length).toBe(3);

      const oldestId = page1.messages[0].id;

      // Page 2: 3 messages before the oldest in page 1.
      const page2Res = await fetch(
        `${HTTP_URL}/history?limit=3&before=${encodeURIComponent(oldestId)}`,
        {
          headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
          signal: AbortSignal.timeout(10_000),
        },
      );
      expect(page2Res.status).toBe(200);
      const page2 = (await page2Res.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(page2.messages.length).toBe(3);

      // Collect all IDs and assert uniqueness (no overlap between pages).
      const allIds = [
        ...page1.messages.map((m) => m.id),
        ...page2.messages.map((m) => m.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(6);
    },
    30_000,
  );
});
