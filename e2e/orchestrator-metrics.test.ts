/**
 * E2E: Orchestrator Prometheus metrics endpoint (Story 2)
 *
 * Verifies that the orchestrator's /metrics endpoint is scrapeable after
 * kubeclaw is installed, exposes the expected kubeclaw_* metric families,
 * and survives a pod restart.
 *
 * Acceptance criteria:
 *   AC1: GET /metrics returns HTTP 200 with Prometheus Content-Type
 *   AC2: Body contains the four required metric families
 *   AC3: kubeclaw_tool_job_spawned_total increments after a tool-job spawn
 *   AC4: Endpoint reachable on port 9091 without auth
 *   AC5: Metric families present after pod restart
 *
 * Requires: kind cluster `kubeclaw-e2e-istio` with image pre-loaded.
 *   Image tag must be `e2e-test` (loaded via kind load image-archive).
 *   The test installs kubeclaw if not already present.
 *
 * Run:
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts orchestrator-metrics
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// ── Constants ──────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw';
const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw';
const MANIFESTS_DIR = join(process.cwd(), 'e2e', 'manifests');

/**
 * Local port for the metrics port-forward.
 * 19091 — unique, does not clash with any other e2e test port-forward:
 *   16379 = global-setup Redis
 *   16380 = helm-chart.test.ts Redis
 *   14091 = specialist-catalog.test.ts HTTP
 *   19090 = credential-injection.test.ts broker metrics
 */
const METRICS_LOCAL_PORT = 19091;

/**
 * Local ports for AC3 in-cluster mock LLM:
 *   19201 = mock-llm control (kind cluster)
 *   19202 = channel-http HTTP (kind cluster)
 */
const MOCK_LLM_CTRL_PORT = 19201;
const CHANNEL_HTTP_PORT = 19202;

const ORCHESTRATOR_READY_TIMEOUT_MS = 120_000;
const METRICS_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

// ── Skip guard ──────────────────────────────────────────────────────────────────

const contextAvailable =
  spawnSync('kubectl', ['config', 'get-contexts', KUBE_CONTEXT], {
    stdio: 'pipe',
  }).status === 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run kubectl with --context=KUBE_CONTEXT. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Poll condition until it returns true, or throw on timeout. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** GET http://localhost:<port>/metrics and return { status, body, contentType }. */
async function scrapeMetrics(port: number): Promise<{
  status: number;
  body: string;
  contentType: string;
}> {
  const resp = await fetch(`http://localhost:${port}/metrics`);
  const body = await resp.text();
  return {
    status: resp.status,
    body,
    contentType: resp.headers.get('content-type') ?? '',
  };
}

/**
 * The four required metric family names from AC2.
 * The orchestrator exposes these even with zero observations (prom-client
 * renders the HELP+TYPE lines without a data line when the counter is zero).
 */
const REQUIRED_METRIC_FAMILIES = [
  'kubeclaw_tool_job_spawned_total',
  'kubeclaw_tool_job_duration_seconds',
  'kubeclaw_redis_ipc_messages_total',
  'kubeclaw_group_queue_depth',
];

// ── Suite setup / teardown ─────────────────────────────────────────────────────

let portForwardProc: ChildProcess | null = null;

beforeAll(async () => {
  if (!contextAvailable) return;

  // Install kubeclaw if not already present (idempotent).
  const helmStatus = spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'status', RELEASE, '--namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (helmStatus.status !== 0) {
    console.log(`Installing kubeclaw into ${KUBE_CONTEXT}...`);
    kc(['create', 'namespace', NAMESPACE]);
    const install = spawnSync(
      'helm',
      [
        '--kube-context', KUBE_CONTEXT,
        'upgrade', '--install',
        RELEASE, CHART_DIR,
        '--namespace', NAMESPACE,
        '--timeout', '120s',
        '--set', `namespace=${NAMESPACE}`,
        '--set', 'secrets.anthropicApiKey=test-key',
        '--set', 'redis.password=e2e-test-pass',
        '--set', 'image.tag=e2e-test',
        '--set', 'image.pullPolicy=Never',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 180_000 },
    );
    if (install.status !== 0) {
      throw new Error(
        `helm install failed:\nstdout: ${install.stdout}\nstderr: ${install.stderr}`,
      );
    }
    console.log('helm install complete');
  }

  // Wait for orchestrator to be Ready.
  console.log('Waiting for kubeclaw-orchestrator to be Ready...');
  await waitUntil(
    () => {
      const r = kc([
        'get', 'deployment', 'kubeclaw-orchestrator',
        '-n', NAMESPACE,
        '-o', 'jsonpath={.status.readyReplicas}',
      ]);
      return r.ok && r.stdout.trim() === '1';
    },
    ORCHESTRATOR_READY_TIMEOUT_MS,
    'kubeclaw-orchestrator readyReplicas=1',
  );
  console.log('kubeclaw-orchestrator is Ready');

  // Kill any leftover port-forward on our port from a previous run.
  spawnSync('pkill', ['-f', `port-forward.*${METRICS_LOCAL_PORT}`], { stdio: 'pipe' });
  await sleep(500);

  // Start the metrics port-forward: svc/kubeclaw-orchestrator → 9091.
  portForwardProc = spawn(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      'port-forward',
      '-n', NAMESPACE,
      'svc/kubeclaw-orchestrator',
      `${METRICS_LOCAL_PORT}:9091`,
    ],
    { stdio: 'pipe' },
  );

  // Give kubectl port-forward time to establish the tunnel.
  await sleep(2000);
}, 180_000);

afterAll(async () => {
  if (portForwardProc) {
    portForwardProc.kill();
    portForwardProc = null;
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe.skipIf(!contextAvailable)(
  'Orchestrator Prometheus metrics endpoint (Story 2)',
  () => {
    it(
      'AC1: GET /metrics returns HTTP 200 with Prometheus Content-Type',
      async () => {
        const { status, contentType } = await scrapeMetrics(METRICS_LOCAL_PORT);
        expect(status).toBe(200);
        // Prometheus text format: text/plain; version=0.0.4; charset=utf-8
        expect(contentType).toMatch(/text\/plain/);
        expect(contentType).toMatch(/version=0\.0\.4/);
      },
      METRICS_TIMEOUT_MS,
    );

    it(
      'AC2: body contains all four required kubeclaw_* metric families',
      async () => {
        const { body } = await scrapeMetrics(METRICS_LOCAL_PORT);
        for (const family of REQUIRED_METRIC_FAMILIES) {
          expect(body, `Missing metric family: ${family}`).toContain(family);
        }
      },
      METRICS_TIMEOUT_MS,
    );

    it.skipIf(!contextAvailable || process.env.KUBECLAW_E2E_METRICS_SPAWN !== '1')(
      'AC3: kubeclaw_tool_job_spawned_total increments after a tool-job spawn',
      async () => {
        // ── 1. Deploy mock LLM into the kubeclaw namespace (kind cluster). ──
        const applyResult = spawnSync(
          'kubectl',
          [
            '--context', KUBE_CONTEXT,
            'apply', '-f', join(MANIFESTS_DIR, 'mock-llm.yaml'),
            '-n', NAMESPACE,
          ],
          { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
        );
        if (applyResult.status !== 0) {
          throw new Error(`Failed to apply mock-llm.yaml: ${applyResult.stderr}`);
        }

        // Wait for mock LLM pod to be ready.
        await waitUntil(
          () => {
            const r = kc([
              'get', 'pod', '-n', NAMESPACE, '-l', 'app=kubeclaw-mock-llm',
              '-o', 'jsonpath={.items[0].status.phase}',
            ]);
            return r.ok && r.stdout.trim() === 'Running';
          },
          60_000,
          'mock-llm pod Running',
        );

        // ── 2. Point channel-http at the in-cluster mock LLM. ─────────────
        const patchResult = kc([
          'set', 'env', 'deployment/kubeclaw-channel-http',
          '-n', NAMESPACE,
          `OPENAI_BASE_URL=http://kubeclaw-mock-llm.${NAMESPACE}.svc:11434/v1`,
        ], { timeout: 30_000 });
        if (!patchResult.ok) {
          throw new Error(`kubectl set env failed: ${patchResult.stderr}`);
        }

        // Wait for rollout.
        kc([
          'rollout', 'status', 'deployment/kubeclaw-channel-http',
          '-n', NAMESPACE, '--timeout=60s',
        ], { timeout: 70_000 });

        // ── 3. Port-forward mock LLM control port and channel-http. ───────
        const mockFwd = spawn(
          'kubectl',
          [
            '--context', KUBE_CONTEXT,
            'port-forward', '-n', NAMESPACE,
            'svc/kubeclaw-mock-llm',
            `${MOCK_LLM_CTRL_PORT}:11434`,
          ],
          { stdio: 'pipe' },
        );

        const channelFwd = spawn(
          'kubectl',
          [
            '--context', KUBE_CONTEXT,
            'port-forward', '-n', NAMESPACE,
            'svc/kubeclaw-channel-http',
            `${CHANNEL_HTTP_PORT}:80`,
          ],
          { stdio: 'pipe' },
        );

        try {
          // Wait for port-forwards to establish.
          await sleep(3000);

          // ── 4. Scrape baseline counter. ───────────────────────────────
          const { body: baselineBody } = await scrapeMetrics(METRICS_LOCAL_PORT);
          const baselineMatch = baselineBody.match(
            /kubeclaw_tool_job_spawned_total\s+(\d+(?:\.\d+)?)/,
          );
          const baseline = baselineMatch ? parseFloat(baselineMatch[1]) : 0;

          // ── 5. Queue a tool call on the mock LLM. ─────────────────────
          await fetch(`http://localhost:${MOCK_LLM_CTRL_PORT}/control/queue-tool-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'execute_agent', arguments: { task: 'echo hello' } }),
          });

          // ── 6. Trigger a message to the channel. ──────────────────────
          // The channel calls mock LLM → gets tool_calls → orchestrator spawns a job.
          fetch(`http://localhost:${CHANNEL_HTTP_PORT}/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Basic ' + Buffer.from('testuser:testpass').toString('base64'),
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({
              content: 'trigger tool job',
              sender: 'testuser',
              chat_jid: 'http:testuser',
            }),
          }).catch(() => { /* fire-and-forget */ });

          // ── 7. Poll metrics until the counter increments. ─────────────
          let spawned = false;
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            await sleep(3000);
            try {
              const { body } = await scrapeMetrics(METRICS_LOCAL_PORT);
              const match = body.match(/kubeclaw_tool_job_spawned_total\s+(\d+(?:\.\d+)?)/);
              if (match && parseFloat(match[1]) > baseline) {
                spawned = true;
                break;
              }
            } catch {
              // port-forward may blip
            }
          }

          expect(spawned, 'kubeclaw_tool_job_spawned_total did not increment within 60s').toBe(true);
        } finally {
          mockFwd.kill();
          channelFwd.kill();
        }
      },
      120_000,
    );

    it(
      'AC4: endpoint reachable on port 9091 (no auth required, no 401/403)',
      async () => {
        // A plain fetch with no Authorization header must succeed.
        const { status } = await scrapeMetrics(METRICS_LOCAL_PORT);
        expect(status).not.toBe(401);
        expect(status).not.toBe(403);
        expect(status).toBe(200);
      },
      METRICS_TIMEOUT_MS,
    );

    it(
      'AC5: metric families present after orchestrator pod restart',
      async () => {
        // Trigger a rollout restart and wait for the new pod to be Ready.
        const rollout = kc([
          'rollout', 'restart',
          'deployment/kubeclaw-orchestrator',
          '-n', NAMESPACE,
        ], { timeout: 30_000 });
        expect(rollout.ok, `rollout restart failed: ${rollout.stderr}`).toBe(true);

        // Wait for the deployment to be ready again after restart.
        await waitUntil(
          () => {
            const r = kc([
              'get', 'deployment', 'kubeclaw-orchestrator',
              '-n', NAMESPACE,
              '-o', 'jsonpath={.status.readyReplicas}',
            ]);
            return r.ok && r.stdout.trim() === '1';
          },
          RESTART_TIMEOUT_MS,
          'kubeclaw-orchestrator readyReplicas=1 after restart',
        );

        // The port-forward connection is broken by the pod restart.
        // Kill and re-establish it against the new pod.
        if (portForwardProc) {
          portForwardProc.kill();
          portForwardProc = null;
        }
        spawnSync('pkill', ['-f', `port-forward.*${METRICS_LOCAL_PORT}`], { stdio: 'pipe' });
        await sleep(1000);

        portForwardProc = spawn(
          'kubectl',
          [
            '--context', KUBE_CONTEXT,
            'port-forward',
            '-n', NAMESPACE,
            'svc/kubeclaw-orchestrator',
            `${METRICS_LOCAL_PORT}:9091`,
          ],
          { stdio: 'pipe' },
        );
        // Wait for tunnel to establish.
        await sleep(2500);

        // Poll until the endpoint responds (pod may need a few extra seconds
        // after the rollout marks it Ready before the metrics server is hot).
        let body = '';
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            const result = await scrapeMetrics(METRICS_LOCAL_PORT);
            if (result.status === 200) {
              body = result.body;
              break;
            }
          } catch {
            // port-forward not yet ready
          }
          await sleep(1500);
        }

        for (const family of REQUIRED_METRIC_FAMILIES) {
          expect(body, `Missing metric family after restart: ${family}`).toContain(family);
        }
      },
      RESTART_TIMEOUT_MS + 60_000,
    );
  },
);
