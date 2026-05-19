/**
 * Story 25: POST /message returns `{id}` JSON
 *
 * End-to-end tests verifying that POST /message on the HTTP channel responds
 * with a JSON body containing a unique `id` string.
 *
 * ACs:
 *   1. Authenticated POST → 200 with {"id":"<msgId>"} JSON body
 *   2. Two POSTs → distinct IDs
 *   3. Returned `id` matches the stored DB row (via GET /history)
 *   4. No auth → 401, no id
 *   5. Missing/blank text → 400, no id
 *
 * Prerequisites:
 *   - kind cluster (kind-kubeclaw-e2e-istio) with the kubeclaw-orchestrator:e2e-test
 *     image already loaded (done by the build script before running this suite).
 *   - kubectl context pointing at the kind cluster.
 *   - helm 3.x on PATH.
 *
 * Run via:
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts message-id-ack
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-msg-ack';
const RELEASE = 'ke2e-msg-ack';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14110; // unique port — does not clash with other e2e suites
const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepass';
const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// When running locally with multiple clusters, operators set KUBECLAW_E2E_KUBE_CONTEXT
// to target the correct cluster.  In CI the kind cluster is the sole context so
// this env var is optional.
const KUBE_CONTEXT =
  process.env.KUBECLAW_E2E_KUBE_CONTEXT ?? 'kind-kubeclaw-e2e-istio';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Run kubectl with the configured context; returns stdout (trimmed). Throws on failure. */
function kube(args: string[]): string {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, ...args],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    },
  );
  if (r.status !== 0) {
    throw new Error(
      `kubectl ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr}`,
    );
  }
  return (r.stdout ?? '').trim();
}

/** Run kubectl in NAMESPACE; returns stdout (trimmed). Throws on failure. */
function kc(args: string[]): string {
  return kube([...args, '-n', NAMESPACE]);
}

/** Poll until fn() is truthy or timeoutMs elapses. */
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

/** Wait for the channel HTTP pod to be Ready. */
async function waitForChannelPod(timeoutMs = 120_000): Promise<void> {
  await waitUntil(
    () => {
      const r = spawnSync(
        'kubectl',
        [
          '--context', KUBE_CONTEXT,
          'get', 'pods',
          '-l', 'app=kubeclaw-channel-http',
          '-o',
          'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
          '-n', NAMESPACE,
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
      );
      const statuses = (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
      return statuses.length > 0 && statuses.every((s) => s === 'True');
    },
    timeoutMs,
    'channel-http pod Ready',
  );
}

let portForwardProcess: ChildProcess | null = null;

/** Start the port-forward to svc/kubeclaw-channel-http. */
async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover kubectl port-forward from a previous run that still holds
  // the port (happens on retry).
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

  // Wait for the port to be reachable.
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

// ─── Suite lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Clean up any leftover namespace from a previous run.
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'delete', 'namespace', NAMESPACE,
      '--ignore-not-found', '--wait=false',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=90s',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 100_000 },
  );

  // Install kubeclaw with only the HTTP channel enabled.
  // LLM secrets use a placeholder key; the tests are LLM-independent.
  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--kube-context', KUBE_CONTEXT,
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--timeout', '180s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'secrets.anthropicApiKey=test-key-placeholder',
      '--set', 'secrets.claudeCodeOauthToken=test-token-placeholder',
      '--set', 'secrets.openaiApiKey=test-key-placeholder',
      // Use the image pre-loaded by the build script (tag=e2e-test, loaded via kind load).
      '--set', 'image.tag=e2e-test',
      '--set', 'image.pullPolicy=Never',
      // Enable the HTTP channel with alice as the sole user.
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
      '--set', 'redis.password=e2e-ack-redis-pass',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `helm upgrade failed (exit ${result.status}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }

  // Wait for the HTTP channel pod to be ready before port-forwarding.
  await waitForChannelPod(180_000);

  // Open port-forward so tests can reach the channel at HTTP_URL.
  await startPortForward();
}, 360_000);

afterAll(async () => {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], {
    stdio: 'pipe',
  });
  spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'uninstall', RELEASE, '-n', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
  );
  spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'delete', 'namespace', NAMESPACE,
      '--ignore-not-found', '--wait=false',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );
}, 120_000);

// ─── AC 1: Authenticated POST → 200 with {"id":"<msgId>"} ────────────────────

describe('Story 25 — POST /message returns message ID', () => {
  it('AC1: authenticated POST returns 200 with JSON {id}', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: 'AC1 hello world' }),
    });

    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');

    const body = (await res.json()) as { id?: unknown };
    expect(typeof body.id).toBe('string');
    expect((body.id as string).length).toBeGreaterThan(0);
  }, 30_000);

  // ─── AC 2: Two POSTs → distinct IDs ────────────────────────────────────────

  it('AC2: two POSTs produce distinct IDs', async () => {
    async function postMsg(text: string): Promise<string> {
      const res = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(HTTP_USER, HTTP_PASS),
        },
        body: JSON.stringify({ text }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      return body.id;
    }

    const id1 = await postMsg('AC2 first message');
    const id2 = await postMsg('AC2 second message');

    expect(id1).not.toBe(id2);
  }, 30_000);

  // ─── AC 3: Returned id matches DB row via GET /history ──────────────────────

  it('AC3: returned id matches the stored DB row via GET /history', async () => {
    const content = `AC3-verify-${Date.now()}`;

    // POST the message and capture the returned id.
    const postRes = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: content }),
    });
    expect(postRes.status).toBe(200);
    const { id } = (await postRes.json()) as { id: string };
    expect(typeof id).toBe('string');

    // Retrieve history for alice and find a row with the same id and content.
    const histRes = await fetch(`${HTTP_URL}/history`, {
      headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
    });
    expect(histRes.status).toBe(200);

    type MsgRow = { id: string; content: string; chat_jid: string };
    const rows = (await histRes.json()) as MsgRow[];
    expect(Array.isArray(rows)).toBe(true);

    const match = rows.find((r) => r.id === id);
    expect(match).toBeDefined();
    expect(match?.content).toBe(content);
  }, 30_000);

  // ─── AC 4: No auth → 401, no id ─────────────────────────────────────────────

  it('AC4: unauthenticated POST returns 401 with no id field', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'should be rejected' }),
    });

    expect(res.status).toBe(401);

    // The body should not be a JSON object with an id field.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === 'object') {
      expect((parsed as Record<string, unknown>)['id']).toBeUndefined();
    }
  }, 30_000);

  // ─── AC 5: Missing/blank text → 400, no id ──────────────────────────────────

  it('AC5: missing/blank text returns 400 with no id field', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: '   ' }),
    });

    expect(res.status).toBe(400);

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === 'object') {
      expect((parsed as Record<string, unknown>)['id']).toBeUndefined();
    }
  }, 30_000);
});
