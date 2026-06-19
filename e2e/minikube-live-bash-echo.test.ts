/**
 * Minikube-live e2e: bash catalog tool — real `echo` execution + stdout round-trip.
 *
 * ── Why this test exists ──────────────────────────────────────────────────────
 * The sibling test `minikube-live-bash-data-pvc.test.ts` calls jobRunner
 * directly and asserts only on the generated K8s Job *manifest* (volumes, env,
 * wrapper command). It never runs a command or inspects its output. This test
 * closes that gap: it dispatches the `bash` catalog tool end-to-end and asserts
 * the command's STDOUT flows all the way back to the caller.
 *
 * `echo` is the ideal probe because it runs entirely inside the alpine sidecar
 * with NO external dependency, network egress, or API key — so unlike
 * web_search / places_search (which tolerate auth errors) we can assert on the
 * EXACT output. We echo a unique marker and require it to appear verbatim in the
 * tool result.
 *
 * ── Test strategy: Redis direct bypass ────────────────────────────────────────
 * Same deterministic pattern as minikube-live-places-search.test.ts — no LLM in
 * the loop, so it does not depend on a small local model reliably picking the
 * tool:
 *
 *   1. Write the tool call to kubeclaw:toolcalls:<agentJobId>:bash with
 *      input = { command: "echo <MARKER>" }.
 *   2. XADD kubeclaw:spawn-tool-pod with category=bash. The orchestrator's
 *      spawn watcher (src/k8s/ipc-redis.ts) calls resolveTool('bash') against
 *      the helm catalog (helm/kubeclaw/values.yaml: bash → image alpine:latest,
 *      pattern file, mount scratch, run `sh -c "$(cat "$INPUT_DIR/command")"`)
 *      and spawns the file-bridge sidecar.
 *   3. Assert a sidecar tool pod (app=kubeclaw-sidecar-tool) appears within 90 s.
 *   4. Assert kubeclaw:toolresults:<agentJobId>:bash receives a result within
 *      120 s carrying the correct requestId, AND that the result contains the
 *      echoed marker — proving the command ran and its stdout round-tripped.
 *
 * ── Cluster gate ──────────────────────────────────────────────────────────────
 * If the globalSetup port-forward is not reachable the test fails its
 * provisioned gate (consistent with the other minikube-live tests).
 *
 * Run: npm run test:minikube-live -- minikube-live-bash-echo
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
// mount=scratch means groupFolder is never used as a PVC subPath; it only needs
// to be a non-empty, valid group label so the spawn watcher accepts the request.
const GROUP_FOLDER = 'http-http-alice';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers (mirrored from minikube-live-places-search.test.ts) ────────────────

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

/**
 * Poll kubectl for a pod matching `labelSelector` created at or after `sinceMs`
 * (with 2 s clock-skew slop). Returns the pod name or null on timeout.
 */
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
      const lines = r.stdout.trim().split('\n').reverse(); // newest first
      for (const line of lines) {
        const [name, ts] = line.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) return name;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/**
 * Poll a Redis stream for an entry whose `requestId` field matches. Returns the
 * full field map or throws on timeout.
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
        return reject(
          new Error(`Timed out waiting for tool result on ${stream} (requestId=${requestId})`),
        );
      }
      setTimeout(check, 2000);
    };
    void check();
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: bash catalog tool — real echo execution + stdout round-trip', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP channel port-forward is live (globalSetup must have run).
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Connect to Redis as the 'orchestrator' ACL user using the password from
    //    the chart-managed Secret — identical to the places-search test.
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

  it(
    'bash direct bypass — echo runs in sidecar and its stdout round-trips back',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `bash-echo-e2e-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'bash';

      // Unique, shell-safe marker (alphanumerics + hyphens only — no quoting
      // hazards in `sh -c "$(cat "$INPUT_DIR/command")"`). Requiring this exact
      // string in the result proves the command actually executed; a spawn that
      // returned an empty/error result would not contain it.
      const marker = `KUBECLAW-ECHO-${rand}-${Date.now()}`;
      const command = `echo ${marker}`;

      // Stream keys mirror getToolCallsStream / getToolResultsStream in
      // src/k8s/redis-client.ts: kubeclaw:toolcalls:<id>:<category>
      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Brief pause so the spawn watcher has settled past its initial startup.
      await new Promise((r) => setTimeout(r, 1000));

      // Write the tool call BEFORE spawning so the tool server picks it up with
      // lastId='0-0' (same ordering rule as the other bypass tests).
      await redis!.xadd(
        toolCallsStream, '*',
        'requestId', requestId,
        'tool', 'bash',
        'input', JSON.stringify({ command }),
      );

      const testStartMs = Date.now();

      // Spawn via the orchestrator's spawn-tool-pod stream. category=bash makes
      // the watcher resolveTool('bash') against the helm catalog and spawn the
      // file-bridge sidecar (image alpine:latest, mount scratch).
      await redis!.xadd(
        'kubeclaw:spawn-tool-pod', '*',
        'agentJobId', agentJobId,
        'groupFolder', GROUP_FOLDER,
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      console.log(`bash echo: waiting for tool pod (agentJobId=${agentJobId})...`);

      // Hard assertion: the sidecar tool pod must appear within 90 s. Catalog
      // tools spawn via createSidecarToolPodJob, which labels the POD template
      // `app=kubeclaw-sidecar-tool` only; the sinceMs filter excludes prior pods.
      const podSelector = 'app=kubeclaw-sidecar-tool';
      const podName = await waitForToolPod(podSelector, 90_000, testStartMs);
      expect(
        podName,
        `No tool pod with selector "${podSelector}" appeared within 90 s after bash spawn`,
      ).not.toBeNull();
      console.log(`bash echo: tool pod appeared: ${podName}`);

      // Hard assertion: result stream entry must arrive within 120 s with the
      // correct requestId.
      const result = await pollToolResult(redis!, toolResultsStream, requestId, 120_000);

      expect(
        result.requestId,
        'result entry must carry the correct requestId field',
      ).toBe(requestId);

      const resultText = result.result ?? '';
      console.log(`bash echo result (first 300): ${JSON.stringify(resultText.slice(0, 300))}`);

      // Decisive assertion: the echoed marker must appear verbatim in the result.
      // This is the true end-to-end stdout round-trip — the command ran inside
      // the alpine sidecar and its output flowed back through the Redis stream.
      expect(
        resultText,
        `result must contain the echoed marker "${marker}" (proves echo executed and stdout round-tripped)`,
      ).toContain(marker);

      console.log(`bash echo: ✅ marker "${marker}" present in tool result (pod=${podName})`);
    },
    // Total budget: 90 s pod wait + 120 s result wait + headroom.
    300_000,
  );
});
