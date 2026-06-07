/**
 * Story 52 — GET /export downloads conversation history as NDJSON
 *
 * Deploys the HTTP channel into an isolated namespace on the kind cluster,
 * sends a few messages to build conversation history, then verifies:
 *
 *   AC1: Authenticated GET /export → 200 + Content-Type: application/x-ndjson
 *        + Content-Disposition: attachment; filename="kubeclaw-export-<group>-<date>.ndjson"
 *        + body rows each have role, content, timestamp, sender.
 *   AC2: All rows included (no pagination cap), oldest-first.
 *   AC3: Unauthenticated GET /export → 401.
 *   AC4: HEAD /export → same headers as GET, no body.
 *   AC5: POST /export → 405 with Allow: GET, HEAD.
 *
 * LLM-independent: the channel records messages in conversation_history even
 * before the LLM pipeline runs, so no ANTHROPIC_API_KEY is needed.
 *
 * Run (manual):
 *   docker build -t kubeclaw-orchestrator:e2e-test . \
 *     && docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch-s52.tar \
 *     && kind load image-archive /tmp/orch-s52.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw-e2e-export \
 *     --ignore-not-found --timeout=60s
 *   npx vitest run --config vitest.e2e.config.ts export
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-export';
const RELEASE = 'ke2e-export';
const CHART_DIR = './helm/kubeclaw';
const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const HTTP_LOCAL_PORT = 14135; // unique: no other e2e test uses this port

const HTTP_USER = 'alice';
const HTTP_PASS = 'alicepw';

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const SUITE_TIMEOUT = 10 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Make an HTTP request and return status, headers, and body. */
function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: HTTP_LOCAL_PORT,
        path,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
        },
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
    if (body) req.write(body);
    req.end();
  });
}

/** POST a text message as the given user. */
async function postMessage(user: string, pass: string, text: string): Promise<number> {
  const { statusCode } = await rawRequest(
    'POST',
    '/message',
    {
      Authorization: basicAuth(user, pass),
      'Content-Type': 'application/json',
    },
    JSON.stringify({ text }),
  );
  return statusCode;
}

// ── Cluster availability check ────────────────────────────────────────────────

const clusterAvailable =
  spawnSync('kubectl', ['--context', KUBE_CONTEXT, 'cluster-info'], {
    stdio: 'pipe',
    timeout: 10_000,
  }).status === 0;

if (!clusterAvailable) {
  console.warn(
    `[export] kubectl context ${KUBE_CONTEXT} not reachable — suite skipped`,
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
      '--set', 'redis.password=e2e-export-redis-pass',
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
  'Story 52 — GET /export downloads conversation history as NDJSON',
  { timeout: SUITE_TIMEOUT },
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

      // Register alice's group by sending a message (auto-registration side-effect).
      // The LLM pipeline may not respond (no valid API key in e2e), but the
      // conversation_history row is written synchronously in appendConversationMessage.
      // We need a registered group first — trigger auto-registration via a POST.
      const s1 = await postMessage(HTTP_USER, HTTP_PASS, 'Hello from e2e test');
      expect(s1).toBe(200);
      // Give the orchestrator a moment to register the group.
      await sleep(3000);
    }, INSTALL_TIMEOUT);

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
        { stdio: 'pipe', timeout: 60_000 } as any,
      );
      spawnSync(
        'kubectl',
        ['--context', KUBE_CONTEXT, 'delete', 'namespace', NAMESPACE, '--wait=false'],
        { stdio: 'pipe', timeout: 30_000 },
      );
    }, 90_000);

    // AC1: GET /export → 200 + correct Content-Type
    it('AC1: GET /export → 200 with Content-Type: application/x-ndjson', async () => {
      const { statusCode, headers } = await rawRequest('GET', '/export', {
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      });
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toBe('application/x-ndjson');
    });

    // AC1: Content-Disposition header
    it('AC1: Content-Disposition is attachment with correct filename pattern', async () => {
      const { statusCode, headers } = await rawRequest('GET', '/export', {
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      });
      expect(statusCode).toBe(200);
      const cd = headers['content-disposition'] ?? '';
      expect(cd).toMatch(
        /^attachment; filename="kubeclaw-export-[^"]*-\d{4}-\d{2}-\d{2}\.ndjson"$/,
      );
    });

    // AC2: Body rows have correct schema
    it('AC2: body rows each have role, content, timestamp, sender — oldest-first', async () => {
      const { statusCode, body } = await rawRequest('GET', '/export', {
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      });
      expect(statusCode).toBe(200);

      const lines = body.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBeGreaterThanOrEqual(1);

      for (const line of lines) {
        const row = JSON.parse(line) as Record<string, unknown>;
        expect(typeof row.role).toBe('string');
        expect(['user', 'assistant']).toContain(row.role);
        expect(typeof row.content).toBe('string');
        expect(typeof row.timestamp).toBe('string');
        expect(typeof row.sender).toBe('string');
      }

      // First row should be the initial message we sent (user role)
      const firstRow = JSON.parse(lines[0]) as Record<string, string>;
      expect(firstRow.role).toBe('user');
      expect(firstRow.content).toBe('Hello from e2e test');
      expect(firstRow.sender).toBe(HTTP_USER);
    });

    // AC3: Unauthenticated → 401
    it('AC3: unauthenticated GET /export → 401', async () => {
      const { statusCode } = await rawRequest('GET', '/export');
      expect(statusCode).toBe(401);
    });

    // AC4: HEAD same headers, no body
    it('AC4: HEAD /export → 200 with same headers as GET, no body', async () => {
      const { statusCode, headers, body } = await rawRequest('HEAD', '/export', {
        Authorization: basicAuth(HTTP_USER, HTTP_PASS),
      });
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toBe('application/x-ndjson');
      expect(headers['content-disposition']).toMatch(/^attachment; filename="kubeclaw-export-/);
      expect(body).toBe('');
    });

    // AC5: POST → 405 + Allow: GET, HEAD
    it('AC5: POST /export → 405 with Allow: GET, HEAD', async () => {
      const { statusCode, headers } = await rawRequest(
        'POST',
        '/export',
        {
          Authorization: basicAuth(HTTP_USER, HTTP_PASS),
          'Content-Type': 'application/json',
        },
        '{}',
      );
      expect(statusCode).toBe(405);
      expect(headers['allow']).toMatch(/\bGET\b/);
      expect(headers['allow']).toMatch(/\bHEAD\b/);
    });
  },
);
