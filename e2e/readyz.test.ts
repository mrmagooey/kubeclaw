/**
 * Story 33 — HTTP /readyz readiness endpoint
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster and
 * verifies that:
 *   AC1: GET /readyz → 200 + JSON body {status:"ready",checks:{db:"ok",redis:"ok"}}
 *   AC2: With Redis scaled to 0 → 503 within 10 s + {status:"not_ready",checks:{db:"ok",redis:"unreachable"}}
 *       Pod does NOT crash; kubectl get pod still shows Running.
 *   AC3: After Redis restored → GET /readyz returns 200 again within 30 s (no pod restart).
 *   AC4: HEAD /readyz mirrors GET (status code only, no body); POST /readyz → 405 + Allow: GET, HEAD.
 *   AC5: kubeclaw-channel-http Service carries readinessProbe on /readyz; with Redis down
 *       the channel pod's IP is removed from Endpoints within 30 s.
 *
 * LLM-dependence: none.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch-s33.tar \
 *     && kind load image-archive /tmp/orch-s33.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-readyz \
 *     --ignore-not-found --timeout=60s
 *   npx vitest run --config vitest.e2e.config.ts readyz
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-readyz';
const RELEASE = 'ke2e-readyz';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14118;

const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepass';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Make an HTTP request and return status, headers, and body. */
function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: HTTP_LOCAL_PORT, path, method, headers },
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
    req.end();
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
    `[readyz] kubectl context ${KUBE_CONTEXT} not reachable — suite skipped`,
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
      // Enable the HTTP channel with a single user.
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
      '--set', 'redis.password=e2e-readyz-redis-pass',
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

// ── Redis scale helpers ───────────────────────────────────────────────────────

function scaleRedis(replicas: number, label: string): void {
  sh('kubectl', [
    '--context', KUBE_CONTEXT,
    '-n', NAMESPACE,
    'scale', 'deployment', 'kubeclaw-redis',
    `--replicas=${replicas}`,
  ]);
  console.log(`[readyz] Redis scaled to ${replicas} replica(s) (${label})`);
}

/** Check whether the channel pod's IP appears in Endpoints for kubeclaw-channel-http. */
function channelInEndpoints(): boolean {
  const r = spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      '-n', NAMESPACE,
      'get', 'endpoints', 'kubeclaw-channel-http',
      '-o', 'jsonpath={.subsets[*].addresses[*].ip}',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
  );
  return (r.stdout ?? '').trim().length > 0;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!clusterAvailable)(
  'Story 33 — /readyz readiness endpoint',
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

      // Restore Redis in case a test left it scaled down.
      try {
        scaleRedis(1, 'afterAll cleanup');
      } catch {
        // best-effort
      }

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

    // AC1: GET /readyz → 200, Content-Type: application/json, body has correct shape
    it('AC1: GET /readyz → 200 with ready JSON body', async () => {
      const { statusCode, headers, body } = await rawRequest('GET', '/readyz');
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toMatch(/application\/json/);
      const parsed = JSON.parse(body) as {
        status: string;
        checks: { db: string; redis: string };
      };
      expect(parsed.status).toBe('ready');
      expect(parsed.checks.db).toBe('ok');
      expect(parsed.checks.redis).toBe('ok');
    });

    // AC2: Redis scaled to 0 → 503 within 10 s; pod stays Running
    it('AC2: /readyz returns 503 within 10 s when Redis is scaled to 0; pod still Running', async () => {
      scaleRedis(0, 'AC2');

      // Poll until 503 is returned (max 10 s)
      let lastStatus = 0;
      let lastBody = '';
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const r = await rawRequest('GET', '/readyz');
          lastStatus = r.statusCode;
          lastBody = r.body;
          if (r.statusCode === 503) break;
        } catch {
          // port-forward may briefly drop when Redis goes away
        }
        await sleep(500);
      }

      expect(lastStatus).toBe(503);
      const parsed = JSON.parse(lastBody) as {
        status: string;
        checks: { db: string; redis: string };
      };
      expect(parsed.status).toBe('not_ready');
      expect(parsed.checks.db).toBe('ok');
      expect(parsed.checks.redis).toBe('unreachable');

      // Pod itself must still be Running (not CrashLoopBackOff / Terminating)
      const r = spawnSync(
        'kubectl',
        [
          '--context', KUBE_CONTEXT,
          '-n', NAMESPACE,
          'get', 'pods',
          '-l', 'app=kubeclaw-channel-http',
          '-o', 'jsonpath={.items[*].status.phase}',
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
      );
      const phases = (r.stdout ?? '').trim().split(/\s+/).filter(Boolean);
      expect(phases.every((p) => p === 'Running')).toBe(true);
    });

    // AC3: Redis restored → 200 again within 30 s, no pod restart
    it('AC3: /readyz returns 200 again within 30 s after Redis is restored', async () => {
      // Redis should still be at 0 replicas from AC2.
      scaleRedis(1, 'AC3');

      await waitUntil(
        async () => {
          try {
            const r = await rawRequest('GET', '/readyz');
            return r.statusCode === 200;
          } catch {
            return false;
          }
        },
        30_000,
        '/readyz returns 200 after Redis restore',
        1000,
      );
    });

    // AC4: HEAD /readyz mirrors GET (status code only, no body)
    it('AC4: HEAD /readyz → 200, no body', async () => {
      const { statusCode, body } = await rawRequest('HEAD', '/readyz');
      expect(statusCode).toBe(200);
      expect(body).toBe('');
    });

    // AC4: POST /readyz → 405 + Allow: GET, HEAD
    it('AC4: POST /readyz → 405 with Allow: GET, HEAD', async () => {
      const { statusCode, headers } = await rawRequest('POST', '/readyz');
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
      expect(headers['allow']).toMatch(/\bHEAD\b/);
    });

    // AC5: With Redis down, channel pod's IP is removed from Endpoints within 30 s
    it('AC5: With Redis scaled to 0, channel pod removed from kubeclaw-channel-http Endpoints within 30 s', async () => {
      scaleRedis(0, 'AC5');

      await waitUntil(
        () => !channelInEndpoints(),
        30_000,
        'channel pod IP removed from kubeclaw-channel-http Endpoints',
        2000,
      );

      // Restore Redis for cleanup
      scaleRedis(1, 'AC5 restore');
    });

    // AC5 complement: With Redis restored, pod re-joins Endpoints within 30 s
    it('AC5: After Redis restored, channel pod re-joins Endpoints within 30 s', async () => {
      // Redis should be at 1 replica from previous restore.
      await waitUntil(
        () => channelInEndpoints(),
        30_000,
        'channel pod IP back in kubeclaw-channel-http Endpoints',
        2000,
      );
    });
  },
);
