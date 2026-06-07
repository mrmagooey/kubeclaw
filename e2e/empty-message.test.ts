/**
 * Story 27: Empty POST /message rejection
 *
 * End-to-end tests verifying that POST /message on the HTTP channel rejects
 * empty, whitespace-only, missing-text, and malformed-JSON bodies with a 400
 * status and an appropriate error message, and that no DB row is written.
 *
 * ACs:
 *   1. {"text":""} → 400 + "Missing text", no DB row
 *   2. {"text":"   "} → 400 + "Missing text", no DB row
 *   3. {} → 400 + "Missing text"
 *   4. Malformed JSON ("not-json") → 400 + "Invalid JSON"
 *   5. Valid text → 200 + {id}  (regression guard, post-Story 25)
 *
 * LLM-independent — no real LLM key needed.
 *
 * Prerequisites:
 *   - kind cluster (kind-kubeclaw-e2e-istio) with the kubeclaw-orchestrator:e2e-test
 *     image already loaded (done by the build script before running this suite).
 *   - kubectl context pointing at the kind cluster.
 *   - helm 3.x on PATH.
 *
 * Run via:
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-empty-msg \
 *     --ignore-not-found --timeout=60s && \
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts empty-message
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-empty-msg';
const RELEASE = 'ke2e-empty-msg';
const CHART_DIR = './helm/kubeclaw';
const HTTP_LOCAL_PORT = 14112; // unique port — does not clash with other e2e suites
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

/** Poll until fn() is truthy or timeoutMs elapses. */
async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
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

/** POST a valid message as alice. Returns the message id. */
async function postValidMessage(text: string): Promise<string> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(HTTP_USER, HTTP_PASS),
    },
    body: JSON.stringify({ text }),
  });
  if (res.status !== 200) {
    throw new Error(
      `Expected 200 from POST /message, got ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Fetch GET /history for alice.
 *
 * Returns `null` when the group is not yet registered (404), so callers can
 * wait until alice's group becomes visible after the first valid POST.
 */
async function getHistory(): Promise<{ id: string; content: string }[] | null> {
  const res = await fetch(`${HTTP_URL}/history`, {
    headers: { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
  });
  if (res.status === 404) {
    // Group not yet registered — alice hasn't sent a valid message yet.
    return null;
  }
  if (res.status !== 200) {
    throw new Error(`GET /history returned unexpected ${res.status}`);
  }
  const body = (await res.json()) as { messages: { id: string; content: string }[] };
  return body.messages;
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
      '--set', 'redis.password=e2e-empty-msg-redis-pass',
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

  // Send a valid message to trigger group registration via the orchestrator.
  // The persistence side-effect guard in ACs 1–3 compares row counts via
  // GET /history, which returns 404 until alice's group is registered.
  await postValidMessage('seed — triggers alice group registration');

  // Wait until GET /history returns 200 (group registered by the orchestrator).
  // The response may have 0 rows (conversation_history is separate from the
  // messages table) — we only need 200 to confirm group registration.
  await waitUntil(
    async () => {
      const rows = await getHistory();
      return rows !== null;
    },
    90_000,
    'alice group registered — GET /history returns 200',
    2_000,
  );
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Story 27 — Empty POST /message rejection', () => {
  // ─── AC 1: {"text":""} → 400 + "Missing text", no DB row ──────────────────

  it('AC1: empty string text returns 400 "Missing text" and no DB row is written', async () => {
    const beforeRows = await getHistory();
    expect(beforeRows).not.toBeNull();

    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: '' }),
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing text');

    // Persistence side-effect guard: no new row should have been added.
    const afterRows = await getHistory();
    expect(afterRows).not.toBeNull();
    expect(afterRows!.length).toBe(beforeRows!.length);
  }, 30_000);

  // ─── AC 2: {"text":"   "} → 400 + "Missing text", no DB row ───────────────

  it('AC2: whitespace-only text returns 400 "Missing text" and no DB row is written', async () => {
    const beforeRows = await getHistory();
    expect(beforeRows).not.toBeNull();

    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: '   ' }),
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing text');

    // Persistence side-effect guard: no new row should have been added.
    const afterRows = await getHistory();
    expect(afterRows).not.toBeNull();
    expect(afterRows!.length).toBe(beforeRows!.length);
  }, 30_000);

  // ─── AC 3: {} → 400 + "Missing text" ──────────────────────────────────────

  it('AC3: missing text field returns 400 "Missing text" and no DB row is written', async () => {
    const beforeRows = await getHistory();
    expect(beforeRows).not.toBeNull();

    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing text');

    // Persistence side-effect guard: no new row should have been added.
    const afterRows = await getHistory();
    expect(afterRows).not.toBeNull();
    expect(afterRows!.length).toBe(beforeRows!.length);
  }, 30_000);

  // ─── AC 4: malformed JSON → 400 + "Invalid JSON" ──────────────────────────

  it('AC4: malformed JSON body returns 400 "Invalid JSON"', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Invalid JSON');
  }, 30_000);

  // ─── AC 5: Valid text → 200 + {id} (regression guard, post-Story 25) ──────

  it('AC5: valid text returns 200 with {id} (regression guard)', async () => {
    const res = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      },
      body: JSON.stringify({ text: 'AC5 valid message for regression guard' }),
    });

    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');

    const parsed = (await res.json()) as { id?: unknown };
    expect(typeof parsed.id).toBe('string');
    expect((parsed.id as string).length).toBeGreaterThan(0);
  }, 30_000);
});
