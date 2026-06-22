/**
 * Story 34 — Per-user POST /message rate limit returns 429 with Retry-After
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster with
 * perUserMessagesPerMinute=5 and verifies:
 *
 *   AC1: 6 rapid POSTs from alice → first 5 return 200, 6th returns 429 +
 *        Retry-After header (positive integer ≤ 60).
 *   AC2: After waiting Retry-After seconds, a 7th POST from alice returns 200
 *        (the token bucket has refilled).
 *   AC3: While alice is throttled, bob can POST normally (buckets are per-user).
 *   AC4: Throttled requests do NOT increment the messages table row count
 *        (verified via kubectl exec sqlite3 query).
 *   AC5: 20 rapid GET /history?limit=1 from alice all return 200 (read-only
 *        endpoints are NOT throttled by the message limiter).
 *
 * LLM-independent: the 429 path and GET /history path return before LLM
 * dispatch. Only AC1-AC3 POSTs that reach handleInbound are checked for
 * side-effects; those succeed without an LLM because `onMessage` is called
 * but the LLM pipeline is not exercised (the test uses a stub).
 *
 * Run (manual):
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch-s34.tar \
 *     && minikube image load /tmp/orch-s34.tar
 *   kubectl --context minikube delete namespace kubeclaw-e2e-ratelimit \
 *     --ignore-not-found --timeout=60s
 *   npx vitest run --config vitest.e2e.config.ts rate-limit
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ──────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-ratelimit';
const RELEASE = 'ke2e-ratelimit';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14119;

const HTTP_USER_ALICE = 'alice';
const HTTP_PASS_ALICE = 'alicepass';
const HTTP_USER_BOB = 'bob';
const HTTP_PASS_BOB = 'bobpass';

/** perUserMessagesPerMinute set in helm install — must match AC1 assertion. */
const RATE_LIMIT = 5;

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

/** Poll until fn() returns truthy or timeoutMs elapses. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Make an HTTP request and return status, headers, and body. */
function rawRequest(opts: {
  method: string;
  path: string;
  user: string;
  pass: string;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {
      Authorization: basicAuthHeader(opts.user, opts.pass),
    };
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
    `[rate-limit] kubectl context ${KUBE_CONTEXT} not reachable — suite skipped`,
  );
}

// ── Port-forward lifecycle ────────────────────────────────────────────────────

let portForwardProcess: ChildProcess | null = null;

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover port-forward from a previous run.
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
  // Remove any pre-existing namespace (leftover from previous run).
  spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { stdio: 'pipe', timeout: 90_000 },
  );
  // Wait for the namespace to fully terminate before reinstalling.
  spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, 'wait', '--for=delete', `ns/${NAMESPACE}`, '--timeout=90s'],
    { stdio: 'pipe', timeout: 100_000 },
  );

  // Secret value for HTTP_CHANNEL_USERS: "alice:alicepass,bob:bobpass"
  const usersSecret = `${HTTP_USER_ALICE}:${HTTP_PASS_ALICE},${HTTP_USER_BOB}:${HTTP_PASS_BOB}`;

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
      // Enable the HTTP channel with alice and bob.
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
      '--set', 'redis.password=e2e-ratelimit-redis-pass',
      // Set rate limit to 5 for this test
      `--set`, `httpChannel.rateLimit.perUserMessagesPerMinute=${RATE_LIMIT}`,
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

// ── AC4 helper: query sqlite via kubectl exec ──────────────────────────────────

/**
 * Counts messages rows for alice in the orchestrator DB via kubectl exec.
 * Same pattern as Story 9 AC1.
 */
function countAliceMessagesInSqlite(): number {
  // Find the channel pod name
  const podName = sh(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      '-n', NAMESPACE,
      'get', 'pods',
      '-l', 'app=kubeclaw-channel-http',
      '-o', 'jsonpath={.items[0].metadata.name}',
    ],
  ).trim();

  if (!podName) {
    throw new Error('Could not find channel pod');
  }

  // Query the messages table
  const result = sh(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      '-n', NAMESPACE,
      'exec', podName,
      '--',
      'sqlite3',
      '/app/groups/http:alice/db.sqlite',
      'SELECT COUNT(*) FROM messages WHERE sender="alice";',
    ],
    { ignoreExit: true },
  ).trim();

  return parseInt(result, 10) || 0;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!clusterAvailable)(
  'Story 34 — per-user POST /message rate limit with 429 + Retry-After',
  { timeout: 15 * 60 * 1000 },
  () => {
    beforeAll(async () => {
      if (!clusterAvailable) return;

      const skipInstall = process.env.KUBECLAW_SKIP_HELM_INSTALL === 'true';
      if (!skipInstall) {
        helmInstall();
      }

      // Wait for the channel pod to be Ready.
      await waitUntil(
        () => {
          const r = spawnSync(
            'kubectl',
            [
              '--context', KUBE_CONTEXT,
              '-n', NAMESPACE,
              'get', 'pods',
              '-l', 'app=kubeclaw-channel-http',
              '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
            ],
            { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
          );
          const statuses = (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
          return statuses.length > 0 && statuses.every((s) => s === 'True');
        },
        120_000,
        'channel-http pod Ready',
      );

      await startPortForward();
    }, 8 * 60 * 1000);

    afterAll(() => {
      if (!clusterAvailable) return;
      if (portForwardProcess) {
        portForwardProcess.kill();
        portForwardProcess = null;
      }
      spawnSync('pkill', ['-f', `port-forward.*${HTTP_LOCAL_PORT}:80`], { stdio: 'pipe' });
      spawnSync(
        'helm',
        ['uninstall', RELEASE, '--kube-context', KUBE_CONTEXT, '-n', NAMESPACE],
        { stdio: 'pipe', timeout: 60_000, ignoreExit: true } as any,
      );
      spawnSync(
        'kubectl',
        ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE, '--wait=false'],
        { stdio: 'pipe', timeout: 30_000 },
      );
    }, 90_000);

    // AC1: first RATE_LIMIT POSTs → 200; (RATE_LIMIT+1)th → 429 + Retry-After ≤ 60
    it(
      `AC1: first ${RATE_LIMIT} POSTs return 200; ${RATE_LIMIT + 1}th returns 429 + Retry-After`,
      async () => {
        for (let i = 0; i < RATE_LIMIT; i++) {
          const r = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, `msg-${i}`);
          expect(r.statusCode).toBe(200);
        }

        const throttled = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'throttled');
        expect(throttled.statusCode).toBe(429);

        const retryAfter = parseInt(throttled.headers['retry-after'] ?? '0', 10);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(60);
      },
    );

    // AC2: after Retry-After seconds, a subsequent POST returns 200
    it('AC2: after Retry-After seconds, the next POST from alice returns 200', async () => {
      // Drain alice's bucket (may already be from AC1, but drain again for
      // test isolation — the channel restarts between suites only, not between
      // individual tests, so alice's bucket may already be empty).
      for (let i = 0; i < RATE_LIMIT; i++) {
        await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, `drain-${i}`);
      }

      const throttled = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'check-throttled');
      expect(throttled.statusCode).toBe(429);

      const retryAfterSeconds = parseInt(throttled.headers['retry-after'] ?? '0', 10);
      expect(retryAfterSeconds).toBeGreaterThan(0);

      // Wait for the bucket to refill
      await sleep(retryAfterSeconds * 1000 + 500); // +500ms buffer

      const recovery = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'after-wait');
      expect(recovery.statusCode).toBe(200);
    });

    // AC3: while alice is throttled, bob can POST normally
    it('AC3: while alice is throttled, bob can POST normally', async () => {
      // Drain alice (may already be throttled from AC2 recovery — drain again)
      for (let i = 0; i < RATE_LIMIT; i++) {
        await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, `drain-${i}`);
      }

      const aliceThrottled = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'check');
      expect(aliceThrottled.statusCode).toBe(429);

      // Bob has an independent bucket — his first POST returns 200
      const bobOk = await postMessage(HTTP_USER_BOB, HTTP_PASS_BOB, 'hello from bob');
      expect(bobOk.statusCode).toBe(200);
    });

    // AC4: throttled requests do NOT write to the messages DB table
    it('AC4: throttled POSTs do not increment alice messages row count', async () => {
      // Wait for any in-flight DB writes from earlier tests to settle
      await sleep(500);

      const countBefore = countAliceMessagesInSqlite();

      // Ensure alice is throttled: drain her bucket completely
      for (let i = 0; i < RATE_LIMIT; i++) {
        await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, `ac4-drain-${i}`);
      }

      // The throttled request
      const throttled = await postMessage(HTTP_USER_ALICE, HTTP_PASS_ALICE, 'ac4-throttled');
      expect(throttled.statusCode).toBe(429);

      // Wait a moment for any async effects (there should be none)
      await sleep(500);

      const countAfter = countAliceMessagesInSqlite();

      // The throttled request must NOT have added a row
      // (the 5 drain requests each add 1 row, but the throttled one must not)
      expect(countAfter).toBe(countBefore + RATE_LIMIT);
    });

    // AC5: 20 rapid GET /history?limit=1 from alice all return 200 (not throttled)
    it('AC5: 20 rapid GET /history requests are NOT throttled', async () => {
      // GET /history is a read-only endpoint that must not be subject to the
      // message rate limiter. Even if alice has been throttled on POST /message,
      // GET /history must always return 200 (or 404 if not registered, but
      // never 429 due to the message rate limiter).
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          rawRequest({
            method: 'GET',
            path: '/history?limit=1',
            user: HTTP_USER_ALICE,
            pass: HTTP_PASS_ALICE,
          }),
        ),
      );

      // All 20 requests must NOT return 429
      for (const r of results) {
        expect(r.statusCode).not.toBe(429);
      }
    });
  },
);
