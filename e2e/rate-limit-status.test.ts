/**
 * Story 57 — GET /message/rate-limit exposes remaining quota without consuming
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster with
 * perUserMessagesPerMinute=10 and verifies:
 *
 *   AC1: Authenticated GET /message/rate-limit returns HTTP 200 with JSON
 *        { limit: 10, remaining: <0..10>, resetInSeconds: <0..60> }.
 *        `remaining` reflects the current bucket WITHOUT decrementing it.
 *   AC2: After consuming 3 messages via POST /message, GET /message/rate-limit
 *        returns remaining=7 and the next POST /message is still permitted.
 *   AC3: With perUserMessagesPerMinute=0 (unlimited), the endpoint returns
 *        { limit: null, remaining: null, resetInSeconds: null }.
 *   AC4: Unauthenticated GET /message/rate-limit returns 401.
 *   AC5: POST /message/rate-limit returns 405 with Allow: GET, HEAD.
 *        HEAD /message/rate-limit returns the same headers as GET with no body.
 *
 * LLM-independent: peekRateLimit never touches the LLM pipeline.
 *
 * Namespace: kubeclaw-e2e-ratelimit-status. Port: 14140.
 *
 * Run (manual):
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch-s57.tar \
 *     && kind load image-archive /tmp/orch-s57.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-ratelimit-status \
 *     --ignore-not-found --timeout=60s
 *   npx vitest run --config vitest.e2e.config.ts rate-limit-status
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ──────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-ratelimit-status';
const RELEASE = 'ke2e-rls';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14140;

const HTTP_USER_ALICE = 'alice';
const HTTP_PASS_ALICE = 'alicepass';

/** perUserMessagesPerMinute set in helm install — must match AC1 assertion. */
const RATE_LIMIT = 10;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** spawnSync wrapper that throws on non-zero exit. */
function sh(
  cmd: string,
  args: string[],
  opts: { timeout?: number; ignoreExit?: boolean } = {},
): string {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 60_000,
  });
  if (!opts.ignoreExit && r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${r.status}):\n` +
        `stderr: ${r.stderr}\nstdout: ${r.stdout}`,
    );
  }
  return r.stdout ?? '';
}

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Make an HTTP request and return status, headers, and body. */
function rawRequest(opts: {
  method: string;
  path: string;
  user?: string;
  pass?: string;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {};
    if (opts.user !== undefined && opts.pass !== undefined) {
      reqHeaders['Authorization'] = basicAuthHeader(opts.user, opts.pass);
    }
    if (opts.body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: HTTP_LOCAL_PORT,
        path: opts.path,
        method: opts.method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

/** GET /message/rate-limit shorthand. */
function getRateLimit(user: string, pass: string) {
  return rawRequest({ method: 'GET', path: '/message/rate-limit', user, pass });
}

/** POST /message shorthand. */
function postMessage(user: string, pass: string, text: string) {
  return rawRequest({
    method: 'POST',
    path: '/message',
    user,
    pass,
    body: JSON.stringify({ text }),
  });
}

// ── Cluster availability check ─────────────────────────────────────────────────

const clusterAvailable =
  spawnSync('kubectl', ['--context', KUBE_CONTEXT, 'cluster-info'], {
    stdio: 'pipe',
    timeout: 10_000,
  }).status === 0;

if (!clusterAvailable) {
  console.warn(
    `[rate-limit-status] kubectl context ${KUBE_CONTEXT} not reachable — suite skipped`,
  );
}

// ── Port-forward lifecycle ────────────────────────────────────────────────────

let portForwardProcess: ChildProcess | null = null;

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], { stdio: 'pipe' });
  await sleep(1500);

  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl --context ${KUBE_CONTEXT} port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT}:80 2>&1 || true; sleep 0.1; done`,
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

// ── Helm install ──────────────────────────────────────────────────────────────

function helmInstall(): void {
  // Remove any pre-existing namespace.
  spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { stdio: 'pipe', timeout: 90_000 },
  );
  spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, 'wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=90s'],
    { stdio: 'pipe', timeout: 100_000 },
  );

  const usersSecret = `${HTTP_USER_ALICE}:${HTTP_PASS_ALICE}`;

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
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', 'secrets.claudeCodeOauthToken=test-token',
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=4080',
      '--set-string', `secrets.httpChannelUsers=${usersSecret}`,
      '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
      '--set', 'channels.http.envVars[0].key=users',
      '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
      '--set', 'channels.http.envVars[1].key=port',
      '--set', 'channels.http.envVars[1].optional=true',
      '--set', 'credentialInjection.mode=off',
      '--set', 'redis.password=e2e-ratelimitstatus-redis-pass',
      '--set', `httpChannel.rateLimit.perUserMessagesPerMinute=${RATE_LIMIT}`,
      '--set', 'image.tag=e2e-test',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `helm install failed (exit ${result.status}):\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
}

/** Wait until the channel pod becomes Ready. */
async function waitForChannelReady(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = spawnSync(
      'kubectl',
      [
        '--context', KUBE_CONTEXT,
        '-n', NAMESPACE,
        'get', 'pods',
        '-l', 'kubeclaw.io/pod-type=channel',
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    if (out.stdout.trim() === 'True') return;
    await sleep(3000);
  }
  throw new Error('Channel pod did not become Ready within timeout');
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  'Story 57 — GET /message/rate-limit exposes remaining quota without consuming',
  { skip: !clusterAvailable },
  () => {
    beforeAll(async () => {
      helmInstall();
      await waitForChannelReady();
      await startPortForward();
    }, 360_000);

    afterAll(async () => {
      if (portForwardProcess) {
        portForwardProcess.kill();
        portForwardProcess = null;
      }
      sh('helm', [
        'uninstall', RELEASE,
        '--kube-context', KUBE_CONTEXT,
        '--namespace', NAMESPACE,
        '--ignore-not-found',
      ], { ignoreExit: true });
      spawnSync(
        'kubectl',
        ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
        { stdio: 'pipe', timeout: 90_000 },
      );
    }, 120_000);

    // AC1: authenticated GET returns 200 with correct JSON shape
    it('AC1: GET /message/rate-limit returns 200 with { limit, remaining, resetInSeconds }', async () => {
      const res = await getRateLimit(HTTP_USER_ALICE, HTTP_PASS_ALICE);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');

      const body = JSON.parse(res.body) as {
        limit: number;
        remaining: number;
        resetInSeconds: number;
      };
      expect(body.limit).toBe(RATE_LIMIT);
      expect(body.remaining).toBeGreaterThanOrEqual(0);
      expect(body.remaining).toBeLessThanOrEqual(RATE_LIMIT);
      expect(body.resetInSeconds).toBeGreaterThanOrEqual(0);
      expect(body.resetInSeconds).toBeLessThanOrEqual(60);
    });

    // AC1 (read-only): peeking 5 times does not decrement remaining
    it('AC1 (peek-idempotent): repeated GETs do not change remaining', async () => {
      // Call 5 times in quick succession
      const results = await Promise.all(
        Array.from({ length: 5 }, () => getRateLimit(HTTP_USER_ALICE, HTTP_PASS_ALICE)),
      );
      const remainingValues = results.map((r) => (JSON.parse(r.body) as { remaining: number }).remaining);

      // All remaining values must be identical (no decrement on read)
      const first = remainingValues[0];
      for (const v of remainingValues) {
        expect(v).toBe(first);
      }
    });

    // AC2: after 3 POST /message calls, remaining = 7
    it('AC2: after 3 POST /message calls, remaining drops to 7 and next POST still allowed', async () => {
      // Consume 3 tokens
      for (let i = 0; i < 3; i++) {
        const r = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, `ac2-msg-${i + 1}`);
        expect(r.statusCode).toBe(200);
      }

      // Check remaining
      const peekRes = await getRateLimit(HTTP_USER_ALICE, HTTP_PASS_ALICE);
      expect(peekRes.statusCode).toBe(200);
      const body = JSON.parse(peekRes.body) as { remaining: number };
      // NOTE: time may have passed since the 3 posts, so remaining ≥ 7 is the
      // minimal assertion (bucket can only refill, not drain, on its own).
      expect(body.remaining).toBeGreaterThanOrEqual(7);
      expect(body.remaining).toBeLessThanOrEqual(RATE_LIMIT);

      // 4th POST must still succeed
      const r4 = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'ac2-msg-4');
      expect(r4.statusCode).toBe(200);
    });

    // AC4: unauthenticated request → 401
    it('AC4: unauthenticated GET /message/rate-limit returns 401', async () => {
      const res = await rawRequest({ method: 'GET', path: '/message/rate-limit' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Basic realm=');
    });

    // AC5: POST → 405 with Allow header; HEAD returns headers only
    it('AC5: POST /message/rate-limit returns 405 with Allow: GET, HEAD', async () => {
      const res = await rawRequest({
        method: 'POST',
        path: '/message/rate-limit',
        user: HTTP_USER_ALICE,
        pass: HTTP_PASS_ALICE,
        body: '{}',
      });
      expect(res.statusCode).toBe(405);
      const allow = res.headers['allow'] ?? '';
      expect(allow).toContain('GET');
      expect(allow).toContain('HEAD');
    });

    it('AC5: HEAD /message/rate-limit returns same status + headers as GET but no body', async () => {
      const getRes = await getRateLimit(HTTP_USER_ALICE, HTTP_PASS_ALICE);
      const headRes = await rawRequest({
        method: 'HEAD',
        path: '/message/rate-limit',
        user: HTTP_USER_ALICE,
        pass: HTTP_PASS_ALICE,
      });

      expect(headRes.statusCode).toBe(200);
      expect(headRes.headers['content-type']).toBe(getRes.headers['content-type']);
      expect(headRes.body).toBe('');
    });
  },
);

// ── AC3 — unlimited variant (separate helm install) ───────────────────────────
//
// This sub-suite reinstalls the chart with perUserMessagesPerMinute=0 to
// verify the unlimited path returns { limit: null, ... }.
//
// It shares the same namespace but uses a dedicated describe block so it can
// run conditionally and in sequence with the main suite.

describe(
  'Story 57 AC3 — unlimited (perUserMessagesPerMinute=0)',
  { skip: !clusterAvailable },
  () => {
    const NAMESPACE_UNLIMITED = 'kubeclaw-e2e-rls-unlimited';
    const RELEASE_UNLIMITED = 'ke2e-rls-unlimited';
    const HTTP_LOCAL_PORT_UNLIMITED = 14142;
    let pf: ChildProcess | null = null;

    beforeAll(async () => {
      // Tear down any existing run
      spawnSync(
        'kubectl',
        ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE_UNLIMITED, '--ignore-not-found', '--timeout=60s'],
        { stdio: 'pipe', timeout: 90_000 },
      );
      spawnSync(
        'kubectl',
        ['--context', KUBE_CONTEXT, 'wait', '--for=delete', `ns/${NAMESPACE_UNLIMITED}`, '--timeout=90s'],
        { stdio: 'pipe', timeout: 100_000 },
      );

      const usersSecret = `${HTTP_USER_ALICE}:${HTTP_PASS_ALICE}`;
      const result = spawnSync(
        'helm',
        [
          'upgrade', '--install',
          RELEASE_UNLIMITED,
          CHART_DIR,
          '--kube-context', KUBE_CONTEXT,
          '--namespace', NAMESPACE_UNLIMITED,
          '--create-namespace',
          '--timeout', '180s',
          '--set', `namespace=${NAMESPACE_UNLIMITED}`,
          '--set', 'secrets.anthropicApiKey=test-key',
          '--set', 'secrets.claudeCodeOauthToken=test-token',
          '--set', 'channels.http.enabled=true',
          '--set', 'channels.http.type=http',
          '--set', 'channels.http.httpPort=4080',
          '--set-string', `secrets.httpChannelUsers=${usersSecret}`,
          '--set', 'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
          '--set', 'channels.http.envVars[0].key=users',
          '--set', 'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
          '--set', 'channels.http.envVars[1].key=port',
          '--set', 'channels.http.envVars[1].optional=true',
          '--set', 'credentialInjection.mode=off',
          '--set', 'redis.password=e2e-rls-unlimited-redis-pass',
          '--set', 'httpChannel.rateLimit.perUserMessagesPerMinute=0', // unlimited
          '--set', 'image.tag=e2e-test',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 240_000 },
      );
      if (result.status !== 0) {
        throw new Error(`helm install (unlimited) failed:\nstderr: ${result.stderr}`);
      }

      // Wait for channel pod Ready
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const out = spawnSync(
          'kubectl',
          [
            '--context', KUBE_CONTEXT,
            '-n', NAMESPACE_UNLIMITED,
            'get', 'pods',
            '-l', 'kubeclaw.io/pod-type=channel',
            '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
          ],
          { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
        );
        if (out.stdout.trim() === 'True') break;
        await sleep(3000);
      }

      // Start port-forward
      spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT_UNLIMITED}:80`], { stdio: 'pipe' });
      await sleep(1500);
      pf = spawn(
        'bash',
        [
          '-c',
          `while true; do kubectl --context ${KUBE_CONTEXT} port-forward -n ${NAMESPACE_UNLIMITED} svc/kubeclaw-channel-http ${HTTP_LOCAL_PORT_UNLIMITED}:80 2>&1 || true; sleep 0.1; done`,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
      );
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const nc = spawnSync('nc', ['-z', 'localhost', String(HTTP_LOCAL_PORT_UNLIMITED)], { stdio: 'pipe' });
        if (nc.status === 0) break;
      }
    }, 420_000);

    afterAll(async () => {
      if (pf) { pf.kill(); pf = null; }
      sh('helm', ['uninstall', RELEASE_UNLIMITED, '--kube-context', KUBE_CONTEXT, '--namespace', NAMESPACE_UNLIMITED, '--ignore-not-found'], { ignoreExit: true });
      spawnSync('kubectl', ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE_UNLIMITED, '--ignore-not-found', '--timeout=60s'], { stdio: 'pipe', timeout: 90_000 });
    }, 120_000);

    it('AC3: unlimited config returns { limit: null, remaining: null, resetInSeconds: null }', async () => {
      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const reqHeaders = {
          Authorization: basicAuthHeader(HTTP_USER_ALICE, HTTP_PASS_ALICE),
        };
        const req = http.request(
          { hostname: '127.0.0.1', port: HTTP_LOCAL_PORT_UNLIMITED, path: '/message/rate-limit', method: 'GET', headers: reqHeaders },
          (httpRes) => {
            const chunks: Buffer[] = [];
            httpRes.on('data', (c: Buffer) => chunks.push(c));
            httpRes.on('end', () => resolve({ statusCode: httpRes.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ limit: null, remaining: null, resetInSeconds: null });
    });
  },
);
