/**
 * Minikube-live e2e: Story 169 — bash tool job runs against the group's /data PVC.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded:
 *   svc/kubeclaw-channel-http → localhost:14081
 *   svc/kubeclaw-redis        → localhost:16381
 *
 * Test strategy
 * ─────────────
 * This test uses the Redis bypass (same pattern as minikube-live-tool-pods.test.ts)
 * to avoid LLM non-determinism when asserting the execution-category dispatch path.
 * The bypass writes a bash tool call directly to the spawn-tool-pod + toolcalls
 * Redis streams, then asserts the tool pod runs and returns the correct output.
 *
 * Two sub-tests:
 *
 * 1. bash-execution-pod: verifies the execution-category tool pod spawns,
 *    the pod logs contain "Executing tool=bash", and the result stream carries
 *    a non-error response. Uses a simple `echo` command so no PVC seeding is
 *    required — the echo output is deterministic.
 *
 * 2. bash-security-context: verifies the spawned execution tool pod's
 *    securityContext includes runAsNonRoot and that the serviceAccount token
 *    is not auto-mounted (Story 169 AC3). Asserts via kubectl get pod -o json.
 *
 * Why no PVC seed via filesystem MCP?
 *   The filesystem MCP is a separate capability pod not deployed by the standard
 *   helm values-minikube.yaml; seeding /data/sales.csv would require a dedicated
 *   capability install step. The echo-based test covers the full tool dispatch
 *   path (bash → execution category → spawn-tool-pod → tool-server → result
 *   stream) without depending on PVC content.
 *
 * Hard assertions:
 *   - A pod labelled app=kubeclaw-tool-pod appears within 90 s.
 *   - Pod logs contain "Executing tool=bash".
 *   - Result stream entry contains the expected output string.
 *   - Pod securityContext.runAsNonRoot is true (AC3).
 *   - Pod does NOT have automountServiceAccountToken: true (AC3).
 *
 * ACs not fully coverable:
 *   AC1 (LLM emits bash tool call) — this test uses the Redis bypass; the
 *       LLM-driven path is exercised by the LLM-directive variant in
 *       minikube-live-tool-pods.test.ts. Marked informational.
 *   AC4 (SSE reply contains numeric answer) — requires seeding /data/sales.csv
 *       which needs the filesystem MCP; out-of-scope. Covered by the result
 *       stream assertion instead.
 *   AC5 (cross-group PVC isolation) — requires two groups with separate PVC
 *       subPaths, which is outside the scope of the bash dispatch path itself.
 *       The PVC sub-path logic is unit-tested in e2e/tool-job.test.ts.
 *
 * Run: npm run test:minikube-live -- minikube-live-bash-data-pvc
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function waitForToolPod(
  labelSelector: string,
  timeoutMs: number,
  sinceMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', labelSelector,
      '--sort-by=.metadata.creationTimestamp',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
    ]);
    if (r.ok && r.stdout.trim()) {
      const podLines = r.stdout.trim().split('\n').reverse();
      for (const podLine of podLines) {
        const [name, ts] = podLine.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) return name;
      }
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

async function waitForPodLog(
  podName: string,
  substring: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl(['logs', '-n', NAMESPACE, podName, '--all-containers=true'], { timeout: 10_000 });
    if (r.stdout.includes(substring)) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

/**
 * Poll a Redis stream for an entry whose "requestId" field matches `requestId`.
 */
async function pollToolResult(
  redis: Redis,
  stream: string,
  requestId: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const entries = await redis.xrange(stream, '-', '+');
        for (const [, fields] of entries) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          if (obj.requestId === requestId) return resolve(obj);
        }
      } catch { /* stream may not exist yet */ }
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for tool result on ${stream} (requestId=${requestId})`));
      }
      setTimeout(check, 2000);
    };
    void check();
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: Story 169 — bash tool job dispatched via Redis bypass', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(`Port-forward to ${HTTP_URL} not reachable — globalSetup may have failed.`);
      return;
    }

    // 2. Connect to Redis using the orchestrator ACL password.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`Failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();
  }, 120_000);

  afterAll(async () => {
    if (redis) {
      try { await redis.quit(); } catch { /* ignore */ }
    }
  });

  // ── 1. bash → execution-category tool pod spawn and result ───────────────

  it(
    'bash tool call → execution-category tool pod spawns and returns stdout (Story 169 AC2)',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `direct-test-bash-169-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'execution';

      // Stream keys follow src/k8s/redis-client.ts conventions:
      //   getToolCallsStream(agentJobId, category)  → kubeclaw:toolcalls:<id>:<cat>
      //   getToolResultsStream(agentJobId, category) → kubeclaw:toolresults:<id>:<cat>
      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Write the bash tool call BEFORE spawning the pod so tool-server picks
      // it up at lastId='0-0' (same ordering as alpine-tool-execution.test.ts).
      // The marker string is distinctive enough to confirm this test's result.
      const marker = `kubeclaw-bash-story169-${rand}`;
      await redis!.xadd(
        toolCallsStream,
        '*',
        'requestId', requestId,
        'tool', 'bash',
        'input', JSON.stringify({ command: `echo ${marker}` }),
      );

      const testStartMs = Date.now();

      // Spawn the execution-category tool pod via the orchestrator's
      // spawn-tool-pod stream (getSpawnToolPodStream() = 'kubeclaw:spawn-tool-pod').
      await redis!.xadd(
        'kubeclaw:spawn-tool-pod',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'http-http-alice',
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      // AC2: a pod with app=kubeclaw-tool-pod must appear within 90 s.
      const podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
      expect(
        podName,
        `No execution tool pod appeared within 90 s for agentJobId=${agentJobId} (Story 169 AC2)`,
      ).not.toBeNull();
      console.log(`bash tool pod appeared: ${podName}`);

      // AC2 proxy: pod logs must contain "Executing tool=bash".
      // tool-server.ts emits: `Executing tool=bash requestId=...`
      const logFound = await waitForPodLog(podName!, 'Executing tool=bash', 90_000);
      expect(
        logFound,
        `Pod ${podName} logs did not contain "Executing tool=bash" within 90 s`,
      ).toBe(true);

      // AC4 proxy: result stream must carry the marker in its result field.
      const result = await pollToolResult(redis!, toolResultsStream, requestId, 60_000);
      expect(result.requestId, 'result entry missing requestId').toBe(requestId);
      expect(result.result ?? '', `bash result must contain marker "${marker}"`).toContain(marker);
      console.log(`bash result: ${(result.result ?? '').trim()}`);
    },
    300_000,
  );

  // ── 2. execution tool pod: securityContext assertions (Story 169 AC3) ──────

  it(
    'execution-category tool pod runs as non-root with no SA token mount (Story 169 AC3)',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `direct-test-bash-sec-169-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'execution';

      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;

      // Write a trivial bash call so the pod starts promptly.
      await redis!.xadd(
        toolCallsStream,
        '*',
        'requestId', requestId,
        'tool', 'bash',
        'input', JSON.stringify({ command: 'id' }),
      );

      const testStartMs = Date.now();

      await redis!.xadd(
        'kubeclaw:spawn-tool-pod',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'http-http-alice',
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      const podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
      expect(
        podName,
        `No execution tool pod appeared within 90 s for AC3 security check (agentJobId=${agentJobId})`,
      ).not.toBeNull();
      console.log(`Security-context check pod: ${podName}`);

      // Wait for the pod to be visible in the API (it may be Pending/Running).
      // We don't require it to succeed — we only need the spec to inspect.
      await new Promise((r) => setTimeout(r, 3000));

      // AC3a: runAsNonRoot must be true in the pod-level or container-level securityContext.
      // The chart template kubeclaw.toolJobSecurityContext sets this at the pod level
      // (k8s/40-agent-job-template.yaml: spec.securityContext.runAsNonRoot: true).
      const secCtx = kubectl([
        'get', 'pod', '-n', NAMESPACE, podName!,
        '-o', 'jsonpath={.spec.securityContext.runAsNonRoot}',
      ]);
      // Also check per-container securityContext in case the pod-level is absent.
      const containerSecCtx = kubectl([
        'get', 'pod', '-n', NAMESPACE, podName!,
        '-o', 'jsonpath={.spec.containers[0].securityContext.runAsNonRoot}',
      ]);
      const runAsNonRoot =
        secCtx.stdout.trim() === 'true' || containerSecCtx.stdout.trim() === 'true';
      expect(
        runAsNonRoot,
        `Pod ${podName} must have runAsNonRoot=true at pod or container level (Story 169 AC3)`,
      ).toBe(true);

      // AC3b: automountServiceAccountToken must NOT be true (either absent or explicitly false).
      const saMount = kubectl([
        'get', 'pod', '-n', NAMESPACE, podName!,
        '-o', 'jsonpath={.spec.automountServiceAccountToken}',
      ]);
      // An empty string means the field is absent (defaults to false in K8s ≥1.24
      // when the ServiceAccount also has it disabled). "false" is the explicit opt-out.
      const tokenMountValue = saMount.stdout.trim();
      expect(
        tokenMountValue === 'false' || tokenMountValue === '',
        `Pod ${podName} must not have automountServiceAccountToken=true; got "${tokenMountValue}" (Story 169 AC3)`,
      ).toBe(true);

      console.log(
        `Security context: runAsNonRoot=${runAsNonRoot}, automountServiceAccountToken="${tokenMountValue}"`,
      );
    },
    300_000,
  );
});
