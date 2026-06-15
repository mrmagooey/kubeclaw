/**
 * Minikube-live e2e: places_search via file-bridge sidecar (Google searchText).
 *
 * ── Test strategy ─────────────────────────────────────────────────────────────
 * This test exercises the by-name catalog → sidecar → file-bridge round-trip
 * for `places_search` WITHOUT requiring a real Google Places API key or live
 * egress.
 *
 * Approach: Redis direct bypass (same as minikube-live-agent-catalog.test.ts
 * Stages 2-4 and minikube-live-tool-pods.test.ts).
 *
 *   1. Write a tool call to kubeclaw:toolcalls:<agentJobId>:places_search
 *   2. XADD kubeclaw:spawn-tool-pod with category=places_search
 *   3. Assert the sidecar tool pod (app=kubeclaw-sidecar-tool) appears within 90 s
 *   4. Assert kubeclaw:toolresults:<agentJobId>:places_search receives a result
 *      within 120 s — the result may be an auth error from Google (HTTP 403) or
 *      a valid JSON body, either proves the sidecar bridge executed curl and the
 *      result flowed back through the Redis round-trip.
 *
 * Why not LLM-directive (like minikube-live-web-search.test.ts)?
 *   The LLM-directive approach relies on the small local model reliably picking
 *   the right tool. That approach works for web_search because the test cluster
 *   has a real Brave API key and egress. For places_search there is no real
 *   Google key in CI, so even if the LLM picks the tool the test would need to
 *   assert on a curl auth-failure anyway. The direct bypass is more deterministic
 *   and follows the established pattern for catalog-tool sidecar verification.
 *
 * Why not a mock server?
 *   places_search uses GOOGLE_PLACES_BASE_URL (injected by the google-places
 *   credential broker via baseUrlEnvs in values.yaml). Overriding this would
 *   require either a helm upgrade mid-test or a running in-cluster HTTP server
 *   fixture. Neither exists in the current harness for this broker. Asserting
 *   on the deterministic round-trip (pod spawns, bridge runs, result returns)
 *   is the cleanest approach available without adding new infrastructure.
 *
 * Limitation: the test does NOT assert the contents of the Google Places JSON
 * response. It only asserts that the file-bridge sidecar ran and a result
 * (success or structured error) was returned on the results stream.
 *
 * Hard assertions:
 *   - POST /message (provisioned gate) — cluster is live
 *   - Sidecar tool pod (app=kubeclaw-sidecar-tool) appears within 90 s of spawn
 *   - kubeclaw:toolresults:<id>:places_search receives an entry within 120 s
 *   - The result entry has the correct requestId field
 *   - The result field is non-empty (curl produced output)
 *
 * Run: npm run test:minikube-live -- minikube-live-places-search
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const GROUP_FOLDER = 'http-http-alice';
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

/**
 * Poll kubectl for a pod matching `labelSelector` created at or after `sinceMs`
 * (with 2 s clock-skew slop). Returns the pod name or null on timeout.
 * Mirrors the helper in minikube-live-tool-pods.test.ts.
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
 * full field map or throws on timeout. Mirrors pollToolResult in
 * minikube-live-tool-pods.test.ts.
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

describe('Minikube-live: places_search via file-bridge sidecar (Google searchText)', () => {
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

    // 2. Connect to Redis using the orchestrator ACL password from the Secret —
    //    identical pattern to minikube-live-tool-pods.test.ts beforeAll.
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

  // ── places_search: Redis direct bypass → file-bridge sidecar → toolresults ──
  //
  // Writes a tool call directly to kubeclaw:toolcalls:<id>:places_search, then
  // publishes kubeclaw:spawn-tool-pod with category=places_search. Asserts that:
  //   1. The sidecar tool pod (app=kubeclaw-sidecar-tool) appears within 90 s.
  //   2. kubeclaw:toolresults:<id>:places_search receives an entry within 120 s.
  //   3. The result entry carries the correct requestId.
  //   4. The result field is non-empty (curl ran and produced output, whether that
  //      is a Google Places JSON body or a structured auth-error response).
  //
  // This proves the by-name catalog dispatch path:
  //   callCatalogToolViaRedis(places_search) →
  //   spawn-tool-pod(category=places_search) →
  //   curlimages/curl sidecar →
  //   toolresults round-trip.

  it(
    'places_search direct bypass — category=places_search spawns sidecar and returns result',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);
      expect(redis, 'Redis client not initialised').not.toBeNull();

      const rand = Math.random().toString(36).slice(2, 8);
      const agentJobId = `places-search-e2e-${Date.now()}-${rand}`;
      const requestId = `${agentJobId}-req`;
      const category = 'places_search';

      // Stream keys mirror getToolCallsStream / getToolResultsStream in
      // src/k8s/redis-client.ts: kubeclaw:toolcalls:<id>:<category>
      const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
      const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

      // Brief pause so the spawn watcher has settled past its initial startup.
      // Mirrors the same pause in minikube-live-agent-catalog.test.ts Stage 2.
      await new Promise((r) => setTimeout(r, 1000));

      // Write the tool call BEFORE spawning so the tool server picks it up with
      // lastId='0-0' (same ordering rule as minikube-live-tool-pods.test.ts).
      // The query is "pizza in Melbourne CBD" — deterministic content, no special
      // chars that could confuse the shell quoting in the places_search `run` script.
      await redis!.xadd(
        toolCallsStream, '*',
        'requestId', requestId,
        'tool', 'places_search',
        'input', JSON.stringify({ query: 'pizza in Melbourne CBD' }),
      );

      const testStartMs = Date.now();

      // Spawn via the orchestrator's spawn-tool-pod stream. category=places_search
      // is the per-name convention used by callCatalogToolViaRedis: the category
      // equals the tool name, so the orchestrator routes it to the curlimages/curl
      // image with the places_search `run` script (not the old "execution" category).
      await redis!.xadd(
        'kubeclaw:spawn-tool-pod', '*',
        'agentJobId', agentJobId,
        'groupFolder', GROUP_FOLDER,
        'category', category,
        'timeout', '120000',
        'channel', 'http',
      );

      console.log(`places_search: waiting for tool pod (agentJobId=${agentJobId})...`);

      // Hard assertion: the sidecar tool pod must appear within 90 s.
      // Catalog tools spawn via createSidecarToolPodJob, which labels the POD
      // template `app=kubeclaw-sidecar-tool` only (job-runner.ts ~1898). The
      // `kubeclaw/agent-job=<id>` label is on the JOB metadata, NOT the pod
      // template, so a pod query (waitForToolPod = `kubectl get pods`) must use
      // `app=kubeclaw-sidecar-tool` alone and rely on the sinceMs timestamp
      // filter to exclude prior pods. (The old `app=kubeclaw-tool-pod` category
      // pods were removed when createToolPodJob was deleted.)
      const podSelector = `app=kubeclaw-sidecar-tool`;
      const podName = await waitForToolPod(podSelector, 90_000, testStartMs);
      expect(
        podName,
        `No tool pod with selector "${podSelector}" appeared within 90 s after places_search spawn`,
      ).not.toBeNull();
      console.log(`places_search: tool pod appeared: ${podName}`);

      // Hard assertion: result stream entry must arrive within 120 s with the
      // correct requestId. The curl inside the sidecar hits GOOGLE_PLACES_BASE_URL
      // (set by the google-places credential broker via baseUrlEnvs). Without a
      // real API key the response will be a Google auth-error JSON (HTTP 401/403),
      // but the round-trip still completes and the result field is non-empty.
      const result = await pollToolResult(redis!, toolResultsStream, requestId, 120_000);

      expect(
        result.requestId,
        'result entry must carry the correct requestId field',
      ).toBe(requestId);

      const resultText = result.result ?? '';
      expect(
        resultText,
        'result field must be non-empty (curl produced output)',
      ).toBeTruthy();

      // Informational: log whether we got a Google Places body or an auth error.
      const looksLikePlaces = resultText.includes('"places"') || resultText.includes('displayName');
      const looksLikeAuthError =
        resultText.includes('UNAUTHENTICATED') ||
        resultText.includes('API_KEY_INVALID') ||
        resultText.includes('"error"');
      console.log(
        `places_search result (first 300): ${resultText.slice(0, 300)}`,
      );
      console.log(
        `places_search observability: ` +
        `looksLikePlacesBody=${looksLikePlaces}, ` +
        `looksLikeAuthError=${looksLikeAuthError}, ` +
        `pod=${podName ?? 'none'}`,
      );

      if (looksLikeAuthError) {
        console.warn(
          'places_search: curl returned an auth error (no real Google key in CI). ' +
          'The file-bridge sidecar round-trip is confirmed working. ' +
          'To get a Places JSON body, set a valid GOOGLE_PLACES_API_KEY credential.',
        );
      }
    },
    // Total budget: 90 s pod wait + 120 s result wait + headroom.
    300_000,
  );
});
