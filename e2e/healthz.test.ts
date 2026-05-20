/**
 * Story 32 — HTTP /healthz liveness endpoint
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster and
 * verifies that GET /healthz returns 200 + JSON body, HEAD works, POST → 405,
 * and sub-paths → 404.
 *
 * LLM-independent: no LLM provider or Redis required.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch-s32.tar \
 *     && kind load image-archive /tmp/orch-s32.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-healthz \
 *     --ignore-not-found --timeout=60s
 *   npx vitest run --config vitest.e2e.config.ts healthz
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-healthz';
const RELEASE = 'ke2e-healthz';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14117;

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
    `[healthz] kubectl context ${KUBE_CONTEXT} not reachable — suite skipped`,
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
      '--set', 'redis.password=e2e-healthz-redis-pass',
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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!clusterAvailable)(
  'Story 32 — /healthz liveness endpoint',
  { timeout: 10 * 60 * 1000 },
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

    // AC1: GET /healthz → 200, Content-Type: application/json, body has status and uptime_ms
    it('AC1: GET /healthz → 200 with JSON body containing status and uptime_ms', async () => {
      const { statusCode, headers, body } = await rawRequest('GET', '/healthz');
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toMatch(/application\/json/);
      const parsed = JSON.parse(body) as { status: string; uptime_ms: number };
      expect(parsed.status).toBe('ok');
      expect(typeof parsed.uptime_ms).toBe('number');
      expect(parsed.uptime_ms).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(parsed.uptime_ms)).toBe(true);
    });

    // AC2: Two successive calls show monotonically non-decreasing uptime_ms
    it('AC2: successive calls have non-decreasing uptime_ms', async () => {
      const r1 = await rawRequest('GET', '/healthz');
      expect(r1.statusCode).toBe(200);
      const b1 = JSON.parse(r1.body) as { status: string; uptime_ms: number };

      await sleep(50);

      const r2 = await rawRequest('GET', '/healthz');
      expect(r2.statusCode).toBe(200);
      const b2 = JSON.parse(r2.body) as { status: string; uptime_ms: number };

      expect(b2.uptime_ms).toBeGreaterThanOrEqual(b1.uptime_ms);
    });

    // AC3: HEAD /healthz → 200, no body, same headers
    it('AC3: HEAD /healthz → 200, no body, correct headers', async () => {
      const { statusCode, headers, body } = await rawRequest('HEAD', '/healthz');
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toMatch(/application\/json/);
      expect(body).toBe('');
    });

    // AC4: POST /healthz → 405 + Allow: GET, HEAD
    it('AC4: POST /healthz → 405 with Allow: GET, HEAD', async () => {
      const { statusCode, headers } = await rawRequest('POST', '/healthz');
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
      expect(headers['allow']).toMatch(/\bHEAD\b/);
    });

    // AC5: GET /healthz/anything → 404 (exact-match only)
    it('AC5: GET /healthz/anything → 404 (sub-path not matched)', async () => {
      const { statusCode } = await rawRequest('GET', '/healthz/anything');
      expect(statusCode).toBe(404);
    });
  },
);
