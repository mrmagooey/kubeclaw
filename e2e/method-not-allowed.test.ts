/**
 * Story 31 — 405 Method Not Allowed with Allow header
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster and
 * verifies that every known path responds with 405 + Allow when hit with the
 * wrong method, and that unknown paths still return 404.
 *
 * LLM-independent: no LLM provider or Redis required.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar \
 *     && kind load image-archive /tmp/orch.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-405 \
 *     --ignore-not-found --timeout=60s
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *     npx vitest run --config vitest.e2e.config.ts method-not-allowed
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ─────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-405';
const RELEASE = 'ke2e-405';
const CHART_DIR = './helm/kubeclaw';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14116;

const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepass';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

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

/** kubectl against the test namespace on the kind context. */
function kc(args: string[], opts: { timeout?: number; ignoreExit?: boolean } = {}): string {
  return sh('kubectl', ['--context', CONTEXT, '-n', NS, ...args], opts);
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

/** Make an HTTP request using Node's http module (preserves method spelling). */
function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: LOCAL_PORT, path, method, headers },
      (res) => {
        res.resume(); // drain body
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
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
  spawnSync('kubectl', ['--context', CONTEXT, 'cluster-info'], {
    stdio: 'pipe',
    timeout: 10_000,
  }).status === 0;

// Log whether we are skipping.
if (!clusterAvailable) {
  console.warn(
    `[method-not-allowed] kubectl context ${CONTEXT} not reachable — suite skipped`,
  );
}

// ── Port-forward lifecycle ────────────────────────────────────────────────────

let portForwardProcess: ChildProcess | null = null;

async function startPortForward(): Promise<void> {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }
  // Kill any leftover port-forward from a previous run (e.g. after retry).
  spawnSync('pkill', ['-f', `port-forward.*${LOCAL_PORT}:80`], { stdio: 'pipe' });
  await sleep(1500);

  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl --context ${CONTEXT} port-forward -n ${NS} svc/kubeclaw-channel-http ${LOCAL_PORT}:80 2>&1 || true; sleep 0.1; done`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: false },
  );

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const nc = spawnSync('nc', ['-z', 'localhost', String(LOCAL_PORT)], { stdio: 'pipe' });
    if (nc.status === 0) return;
  }
  throw new Error(`Port-forward to localhost:${LOCAL_PORT} did not come up within 20s`);
}

// ── Helm install ──────────────────────────────────────────────────────────────

function helmInstall(): void {
  // Remove any pre-existing namespace (leftover from previous run).
  spawnSync(
    'kubectl',
    ['--context', CONTEXT, 'delete', 'namespace', NS, '--ignore-not-found', '--timeout=60s'],
    { stdio: 'pipe', timeout: 90_000 },
  );
  // Wait for the namespace to fully terminate before reinstalling.
  spawnSync(
    'kubectl',
    ['--context', CONTEXT, 'wait', `--for=delete`, `ns/${NS}`, '--timeout=90s'],
    { stdio: 'pipe', timeout: 100_000 },
  );

  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--kube-context', CONTEXT,
      '--namespace', NS,
      '--create-namespace',
      '--timeout', '180s',
      '--set', `namespace=${NS}`,
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
      '--set', 'redis.password=e2e-405-redis-pass',
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
  'Story 31 — 405 Method Not Allowed',
  { timeout: 10 * 60 * 1000 },
  () => {
    beforeAll(async () => {
      if (!clusterAvailable) return; // guarded by describe.skipIf, but be safe

      helmInstall();

      // Wait for the channel pod to be Ready.
      await waitUntil(
        () => {
          const r = spawnSync(
            'kubectl',
            [
              '--context', CONTEXT,
              '-n', NS,
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
      spawnSync('pkill', ['-f', `port-forward.*${LOCAL_PORT}:80`], { stdio: 'pipe' });
      spawnSync(
        'helm',
        ['uninstall', RELEASE, '--kube-context', CONTEXT, '-n', NS],
        { stdio: 'pipe', timeout: 60_000 },
      );
      spawnSync(
        'kubectl',
        ['--context', CONTEXT, 'delete', 'namespace', NS, '--wait=false'],
        { stdio: 'pipe', timeout: 30_000 },
      );
    }, 90_000);

    // AC1: DELETE /stream → 405, Allow: GET
    it('DELETE /stream → 405 with Allow: GET', async () => {
      const { statusCode, headers } = await rawRequest(
        'DELETE',
        '/stream',
        { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
      );
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
    });

    // AC2: PUT /message → 405, Allow: POST
    it('PUT /message → 405 with Allow: POST', async () => {
      const { statusCode, headers } = await rawRequest(
        'PUT',
        '/message',
        { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
      );
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bPOST\b/);
    });

    // AC3: POST /history → 405, Allow: GET, DELETE
    it('POST /history → 405 with Allow: GET, DELETE', async () => {
      const { statusCode, headers } = await rawRequest(
        'POST',
        '/history',
        { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
      );
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
      expect(headers['allow']).toMatch(/\bDELETE\b/);
    });

    // AC4: POST /attachments/list → 405, Allow: GET
    it('POST /attachments/list → 405 with Allow: GET', async () => {
      const { statusCode, headers } = await rawRequest(
        'POST',
        '/attachments/list',
        { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
      );
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
    });

    // AC5: PATCH /nonexistent → 404 (not 405 — unknown path)
    it('PATCH /nonexistent → 404 (unknown path is not a 405)', async () => {
      const { statusCode } = await rawRequest(
        'PATCH',
        '/nonexistent',
        { Authorization: basicAuth(HTTP_USER, HTTP_PASS) },
      );
      expect(statusCode).toBe(404);
    });
  },
);
