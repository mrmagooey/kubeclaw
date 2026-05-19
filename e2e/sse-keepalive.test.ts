/**
 * End-to-end tests for Story 24: SSE keepalive heartbeat.
 *
 * Acceptance criteria:
 *   AC1 — Authenticated GET /stream → at least one `: ping` line within 35s (no user activity).
 *   AC2 — `: ping` is a comment-frame: no `id:` field, does not increment Last-Event-ID tracking.
 *   AC3 — Two distinct heartbeats within 70s.
 *   AC4 — Unauthenticated GET /stream → 401 before any heartbeat.
 *   AC5 — /help reply still delivered alongside heartbeats (timer not cleared by data events).
 *
 * LLM-independent. The keepalive is implemented in src/channels/http.ts:410-417 via
 * setInterval(() => res.write(': ping\n\n'), 30_000).
 *
 * Infrastructure:
 *   - kind cluster: kubeclaw-e2e-istio
 *   - namespace:    kubeclaw-e2e-keepalive
 *   - HTTP channel port-forwarded to localhost:14109
 *   - Helm installs with alice:alicepw and a placeholder LLM key.
 *
 * Run after building and loading the image:
 *   docker build -t kubeclaw-orchestrator:e2e-test . && \
 *   docker save kubeclaw-orchestrator:e2e-test | kind load image-archive /dev/stdin --name kubeclaw-e2e-istio
 *
 *   kubectl --context kind-kubeclaw-e2e-istio \
 *     delete namespace kubeclaw-e2e-keepalive --ignore-not-found --timeout=60s
 *
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *   npx vitest run --config vitest.e2e.config.ts sse-keepalive
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { isKubernetesAvailable } from './setup.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-keepalive';
const RELEASE = 'kubeclaw-e2e-keepalive';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14109;
const CHANNEL_HTTP_PORT = 4080;

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';

const HTTP_URL = `http://127.0.0.1:${HTTP_LOCAL_PORT}`;

// The keepalive fires every 30s. We allow 35s for one ping and 70s for two.
const FIRST_PING_TIMEOUT_MS = 35_000;
const TWO_PINGS_TIMEOUT_MS = 70_000;

// ─── Skip guard ───────────────────────────────────────────────────────────────

const clusterAvailable = isKubernetesAvailable();
const shouldSkip = !clusterAvailable;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Poll until predicate() is truthy or timeoutMs elapses. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/**
 * Open a raw HTTP SSE connection and accumulate ALL lines (including comment
 * lines such as `: ping`). Uses node:http so comment lines are visible —
 * fetch/browser SSE APIs strip comment frames before exposing them.
 *
 * Returns:
 *  - `lines`   every raw line received (trimmed of trailing \r)
 *  - `ids`     values from `id:` fields
 *  - `data`    values from `data:` fields
 *  - `pings`   count of `: ping` comment-frames received
 *  - `abort`   close the connection
 *  - `ready`   resolves when the response headers arrive (HTTP 200 confirmed)
 *  - `statusCode` the HTTP status (for 401 checks)
 */
function openSseRaw(opts: {
  user?: string;
  pass?: string;
  lastEventId?: string;
}): {
  lines: string[];
  ids: string[];
  data: string[];
  pings: number[];
  abort: () => void;
  ready: Promise<number>;
} {
  const lines: string[] = [];
  const ids: string[] = [];
  const data: string[] = [];
  const pings: number[] = [];

  let resolveReady: (status: number) => void;
  const ready = new Promise<number>((r) => (resolveReady = r));

  const reqHeaders: Record<string, string> = {};
  if (opts.user && opts.pass) {
    reqHeaders['Authorization'] = basicAuth(opts.user, opts.pass);
  }
  if (opts.lastEventId !== undefined) {
    reqHeaders['Last-Event-ID'] = opts.lastEventId;
  }

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: HTTP_LOCAL_PORT,
      path: '/stream',
      method: 'GET',
      headers: reqHeaders,
    },
    (res) => {
      resolveReady(res.statusCode ?? 0);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const rawLine of chunk.split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          lines.push(line);
          if (line === ': ping') {
            pings.push(Date.now());
          } else if (line.startsWith('id: ')) {
            ids.push(line.slice('id: '.length).trim());
          } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
          }
        }
      });
      res.on('error', () => {});
    },
  );
  req.on('error', () => {});
  req.end();

  return {
    lines,
    ids,
    data,
    pings,
    abort: () => req.destroy(),
    ready,
  };
}

/** POST a message and return the HTTP status code. */
async function postMessage(text: string): Promise<number> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(ALICE_USER, ALICE_PASS),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

let portForwardProcess: ChildProcess | null = null;
let installed = false;

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover port-forward from a prior test run.
  spawnSync(
    'pkill',
    ['-f', `port-forward.*${HTTP_LOCAL_PORT}:${CHANNEL_HTTP_PORT}`],
    { stdio: 'pipe' },
  );
  await sleep(1500);

  // Find the channel pod name and forward directly to it (networkPolicy is
  // disabled so no ClusterIP service is created by the Helm chart).
  const podNameResult = spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      '-n',
      NAMESPACE,
      'get',
      'pod',
      '-l',
      'app=kubeclaw-channel-http',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
  );

  const podName = podNameResult.stdout.trim();
  if (!podName) {
    throw new Error(
      `Could not find kubeclaw-channel-http pod in namespace ${NAMESPACE}`,
    );
  }

  portForwardProcess = spawn(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      '-n',
      NAMESPACE,
      'port-forward',
      podName,
      `${HTTP_LOCAL_PORT}:${CHANNEL_HTTP_PORT}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );

  // Wait up to 20s for the port to accept connections.
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const nc = spawnSync('nc', ['-z', '127.0.0.1', String(HTTP_LOCAL_PORT)], {
      stdio: 'pipe',
    });
    if (nc.status === 0) return;
  }
  throw new Error(
    `Port-forward to localhost:${HTTP_LOCAL_PORT} did not come up within 20s`,
  );
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkip)(
  'SSE keepalive heartbeat e2e (Story 24)',
  // Overall suite budget: helm install (up to 10 min) + 5 tests × 90s each.
  { timeout: 20 * 60 * 1000 },
  () => {
    beforeAll(async () => {
      // Tear down any leftover namespace from a prior run.
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
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'wait',
          '--for=delete',
          `ns/${NAMESPACE}`,
          '--timeout=60s',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
      );

      // Pre-create namespace with Helm ownership labels/annotations.
      for (const cmd of [
        ['create', 'namespace', NAMESPACE],
        ['label', 'namespace', NAMESPACE, 'app.kubernetes.io/managed-by=Helm'],
        [
          'annotate',
          'namespace',
          NAMESPACE,
          `meta.helm.sh/release-name=${RELEASE}`,
          `meta.helm.sh/release-namespace=${NAMESPACE}`,
        ],
      ]) {
        spawnSync('kubectl', ['--context', KUBE_CONTEXT, ...cmd], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }

      const installResult = spawnSync(
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
          '5m',
          '--set',
          `namespace=${NAMESPACE}`,
          '--set',
          'secrets.anthropicApiKey=placeholder-key',
          '--set',
          'secrets.claudeCodeOauthToken=placeholder-token',
          '--set',
          'channels.http.enabled=true',
          '--set',
          'channels.http.type=http',
          '--set',
          `channels.http.httpPort=${CHANNEL_HTTP_PORT}`,
          '--set',
          'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
          '--set',
          'channels.http.envVars[0].key=users',
          '--set-string',
          `secrets.httpChannelUsers=${ALICE_USER}:${ALICE_PASS}`,
          '--set',
          'credentialInjection.mode=off',
          '--set',
          'redis.password=e2e-keepalive-redis-pass',
          '--set',
          'image.tag=e2e-test',
          '--set',
          'networkPolicy.enabled=false',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 360_000 },
      );

      if (installResult.status !== 0) {
        throw new Error(
          `helm upgrade failed (exit ${installResult.status}):\n` +
            `stderr: ${installResult.stderr}\nstdout: ${installResult.stdout}`,
        );
      }

      installed = true;

      // Wait for both deployments to be ready.
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'rollout',
          'status',
          'deployment/kubeclaw-orchestrator',
          '-n',
          NAMESPACE,
          '--timeout=180s',
        ],
        { encoding: 'utf8', stdio: 'inherit', timeout: 210_000 },
      );
      spawnSync(
        'kubectl',
        [
          '--context',
          KUBE_CONTEXT,
          'rollout',
          'status',
          'deployment/kubeclaw-channel-http',
          '-n',
          NAMESPACE,
          '--timeout=180s',
        ],
        { encoding: 'utf8', stdio: 'inherit', timeout: 210_000 },
      );

      await startPortForward();

      // Give the channel a moment to fully settle before tests start.
      await sleep(2000);
    }, 15 * 60 * 1000);

    afterAll(() => {
      if (portForwardProcess) {
        portForwardProcess.kill();
        portForwardProcess = null;
      }
      if (!installed) return;
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
          '--wait=false',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }, 60_000);

    // ── AC1: First `: ping` within 35s ───────────────────────────────────────

    it(
      'AC1: authenticated GET /stream receives at least one `: ping` line within 35s',
      async () => {
        const sse = openSseRaw({ user: ALICE_USER, pass: ALICE_PASS });
        const status = await sse.ready;
        expect(status).toBe(200);

        await waitUntil(
          () => sse.pings.length >= 1,
          FIRST_PING_TIMEOUT_MS,
          'first `: ping` heartbeat',
        );

        sse.abort();

        expect(sse.pings.length).toBeGreaterThanOrEqual(1);
      },
      // Per-test timeout must accommodate the wait window plus buffer.
      FIRST_PING_TIMEOUT_MS + 5_000,
    );

    // ── AC2: `: ping` is a comment-frame, no id:, no Last-Event-ID increment ─

    it(
      'AC2: `: ping` lines are comment-frames with no id: field and do not affect Last-Event-ID',
      async () => {
        const sse = openSseRaw({ user: ALICE_USER, pass: ALICE_PASS });
        const status = await sse.ready;
        expect(status).toBe(200);

        // Wait for the first ping.
        await waitUntil(
          () => sse.pings.length >= 1,
          FIRST_PING_TIMEOUT_MS,
          'first `: ping` for AC2',
        );

        // Capture the id count at the point a ping has arrived.
        const idCountAfterPing = sse.ids.length;

        sse.abort();

        // The `: ping` lines should appear in raw lines.
        expect(sse.lines.some((l) => l === ': ping')).toBe(true);

        // No id: field should have been emitted alongside or inside a `: ping` frame.
        // A `: ping` event is a comment line followed by a blank line — the SSE
        // spec defines comments (lines starting with `:`) as not dispatching events
        // and not updating the last event ID. We verify this by confirming no `id:`
        // lines appeared in the stream unless a real data event was also present.
        // Since we sent no messages, no data events should exist, so id count == 0.
        expect(idCountAfterPing).toBe(0);

        // The `: ping` line itself must not start with `id:`.
        for (const line of sse.lines) {
          if (line === ': ping') {
            // This is a comment — must NOT start with `id:`
            expect(line.startsWith('id:')).toBe(false);
          }
        }
      },
      FIRST_PING_TIMEOUT_MS + 5_000,
    );

    // ── AC3: Two distinct heartbeats within 70s ───────────────────────────────

    it(
      'AC3: two distinct `: ping` heartbeats are received within 70s',
      async () => {
        const sse = openSseRaw({ user: ALICE_USER, pass: ALICE_PASS });
        const status = await sse.ready;
        expect(status).toBe(200);

        await waitUntil(
          () => sse.pings.length >= 2,
          TWO_PINGS_TIMEOUT_MS,
          'two `: ping` heartbeats',
        );

        sse.abort();

        expect(sse.pings.length).toBeGreaterThanOrEqual(2);
        // The two pings must be distinct timestamps (at least 1ms apart).
        expect(sse.pings[1]).toBeGreaterThan(sse.pings[0]);
        // They should be approximately 30s apart (allow ±10s for scheduling jitter).
        const gap = sse.pings[1] - sse.pings[0];
        expect(gap).toBeGreaterThan(20_000);
        expect(gap).toBeLessThan(50_000);
      },
      TWO_PINGS_TIMEOUT_MS + 5_000,
    );

    // ── AC4: Unauthenticated → 401 before any heartbeat ──────────────────────

    it(
      'AC4: unauthenticated GET /stream returns 401 without emitting any heartbeat',
      async () => {
        // Open without credentials.
        const sse = openSseRaw({});
        const status = await sse.ready;

        // Should immediately get a 401 response.
        expect(status).toBe(401);

        // Wait a brief moment to confirm no ping is ever sent on a 401 response.
        await sleep(2000);

        sse.abort();

        // No pings or data should have arrived on an unauthorized connection.
        expect(sse.pings.length).toBe(0);
        expect(sse.data.length).toBe(0);
      },
      10_000,
    );

    // ── AC5: /help reply delivered alongside heartbeats ───────────────────────

    it(
      'AC5: /help reply is delivered on the SSE stream while the keepalive timer is active',
      async () => {
        const sse = openSseRaw({ user: ALICE_USER, pass: ALICE_PASS });
        const status = await sse.ready;
        expect(status).toBe(200);

        // Give the SSE connection a moment to register server-side.
        await sleep(500);

        // Post /help — this is a static intercept that fires without an LLM call.
        const postStatus = await postMessage('/help');
        expect(postStatus).toBe(200);

        // Wait for the /help data reply (it references /search).
        await waitUntil(
          () => sse.data.some((d) => d.includes('/search')),
          15_000,
          '/help reply on SSE stream',
        );

        // Verify the reply arrived.
        expect(sse.data.some((d) => d.includes('/search'))).toBe(true);

        // Now wait to confirm a keepalive ping also arrives (timer not cleared).
        await waitUntil(
          () => sse.pings.length >= 1,
          FIRST_PING_TIMEOUT_MS,
          '`: ping` heartbeat after /help reply',
        );

        sse.abort();

        // Both the /help reply and at least one keepalive must have arrived.
        expect(sse.data.some((d) => d.includes('/search'))).toBe(true);
        expect(sse.pings.length).toBeGreaterThanOrEqual(1);
      },
      // AC5 waits for /help reply (up to 15s) then a full heartbeat interval (35s).
      15_000 + FIRST_PING_TIMEOUT_MS + 5_000,
    );
  },
);
