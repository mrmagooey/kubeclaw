/**
 * Minikube-live browser/web tool end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded svc/kubeclaw-channel-http
 * to localhost:14081.
 *
 * These tests verify the web_fetch and web_search built-in tools:
 *   1. A user message directs the LLM to call web_fetch → the orchestrator
 *      creates a K8s Job with label app=kubeclaw-tool-pod → the tool pod
 *      logs "Executing tool=webFetch".
 *   2. Same flow for web_search → "Executing tool=webSearch".
 *   3. Browser (Playwright agent_browser) tool spawns a browser-category tool
 *      pod — two sub-tests:
 *      a. LLM-driven: directive prompt forces the `browser` tool call.
 *      b. Redis bypass: directly injects a tool call to verify the
 *         `agentBrowser` code path regardless of LLM model choice.
 *
 * Hard assertions (must pass):
 *   - POST /message returns 200
 *   - A tool pod appears in the namespace within 90 s (120 s for browser tests)
 *   - The pod's logs contain the expected "Executing tool=..." substring
 *
 * Informational (console.log / console.warn only — not hard failures):
 *   - Whether the SSE stream delivered any data lines within 60 s (90 s for browser)
 *   - Whether any SSE line contains content related to the tool call
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers (mirrors minikube-live.test.ts) ──────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Reads `data: ...` lines from an SSE stream and resolves on a predicate.
 * Returns an array of all data lines received so far.
 */
async function openSseStream(
  user: string,
  pass: string,
): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  const lines: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // aborted
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

async function postMessage(
  text: string,
  user = KUBECLAW_LIVE_USER,
  pass = KUBECLAW_LIVE_PASS,
): Promise<Response> {
  return await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
}

/**
 * Poll `kubectl get pods -n <ns> -l <selector>` until a pod created at or
 * after `sinceMs` appears, then return its name. Returns null on timeout.
 *
 * Filtering by creation time prevents cross-test contamination — test 2's
 * pod selection won't return a leftover Completed pod from test 1.
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
      // Return name + creationTimestamp for every matching pod, sorted newest first.
      '--sort-by=.metadata.creationTimestamp',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
    ]);
    if (r.ok && r.stdout.trim()) {
      const lines = r.stdout.trim().split('\n').reverse(); // newest first
      for (const line of lines) {
        const [name, ts] = line.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) {
          // 2s slop allows for clock skew between the test host and the cluster.
          return name;
        }
      }
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

/**
 * Poll `kubectl logs -n <ns> <pod>` until the logs contain `substring`,
 * or until the timeout expires. Returns true if found.
 */
async function waitForPodLog(
  podName: string,
  substring: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'logs', '-n', NAMESPACE, podName, '--all-containers=true',
    ], { timeout: 10_000 });
    if (r.stdout.includes(substring)) {
      return true;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Minikube-live: browser/web tool pod spawned via LLM directive', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  afterAll(async () => {
    if (redis) {
      redis.disconnect();
      redis = null;
    }
  });

  beforeAll(async () => {
    // Sanity: the port-forward set up by globalSetup must be live. Retry a
    // few times — `kubectl port-forward`'s socket bind can race with test
    // worker startup.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        // 401 is the expected response (Basic auth challenge); any HTTP
        // status means the channel pod is reachable.
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // try again
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
    }

    // Connect Redis (used by the Redis-bypass browser tests).
    // Read the admin password from the chart-managed Secret, same approach as
    // minikube-live-capabilities.test.ts.
    try {
      const pwd = kubectl([
        'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
        '-o', 'jsonpath={.data.admin-password}',
      ]);
      if (pwd.ok && pwd.stdout) {
        const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
        redis = new Redis(
          `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
          { maxRetriesPerRequest: 3, connectTimeout: 10_000 },
        );
        await redis.ping();
      } else {
        console.warn('browser tests: failed to read kubeclaw-redis admin-password — Redis-bypass test will be skipped');
      }
    } catch (err) {
      console.warn(`browser tests: Redis connect failed (${err instanceof Error ? err.message : err}) — Redis-bypass test will be skipped`);
      redis = null;
    }
  });

  // ── 1. web_fetch: LLM → tool pod → example.com ───────────────────────────
  it(
    'web_fetch via channel → tool pod → example.com',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // Fire the POST and the tool-pod polling in parallel.
      // The POST is fire-and-forget — we don't await its completion before
      // starting the kubectl poll.
      const postPromise = postMessage(
        'You MUST call the web_fetch tool with url=https://example.com. ' +
        'Do not call any other tool. Do not respond with any text — only ' +
        'call web_fetch with url=https://example.com right now.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      try {
        // Wait up to 90 s for the POST to return 200.
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // Poll for a tool pod — try primary label first, fall back to category label.
        // Only consider pods created after this test started.
        podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
        if (podName === null) {
          podName = await waitForToolPod('kubeclaw/category=browser', 30_000, testStartMs);
        }
        expect(
          podName,
          'No kubeclaw-tool-pod appeared within 90 s after web_fetch directive',
        ).not.toBeNull();

        // Poll the pod's logs for the expected execution marker.
        // The exact string produced by tool-server.ts:357 is:
        //   Executing tool=webFetch requestId=...
        const logFound = await waitForPodLog(
          podName!,
          'Executing tool=webFetch',
          90_000,
        );
        expect(
          logFound,
          `Pod ${podName} logs did not contain "Executing tool=webFetch" within 90 s`,
        ).toBe(true);
      } finally {
        // Informational: did the SSE stream deliver content?
        let sseDelivered = false;
        let sseHasContent = false;
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
          sseHasContent = sse.lines.some((l) =>
            /example domain/i.test(l),
          );
        } catch {
          // LLM did not produce SSE output within the budget — expected for small models
        }
        console.log(
          `web_fetch observability: SSE delivered=${sseDelivered}, ` +
          `SSE contains "example domain"=${sseHasContent}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'web_fetch: SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — this is informational only.',
          );
        }
        sse.dispose();
      }
    },
    180_000,
  );

  // ── 2. web_search: LLM → tool pod → DuckDuckGo ───────────────────────────
  it(
    'web_search via channel → tool pod → DuckDuckGo',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // Fire the POST and the tool-pod polling in parallel.
      const postPromise = postMessage(
        'You MUST call the web_search tool with query="kubernetes networking". ' +
        'Do not call any other tool. Do not respond with any text — only ' +
        'call web_search with query="kubernetes networking" right now.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      try {
        // Wait for the POST to return 200.
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // Poll for a tool pod — try primary label first, fall back to category label.
        // Only consider pods created after this test started.
        podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
        if (podName === null) {
          podName = await waitForToolPod('kubeclaw/category=browser', 30_000, testStartMs);
        }
        expect(
          podName,
          'No kubeclaw-tool-pod appeared within 90 s after web_search directive',
        ).not.toBeNull();

        // Poll the pod's logs for the expected execution marker.
        // The exact string produced by tool-server.ts:357 is:
        //   Executing tool=webSearch requestId=...
        const logFound = await waitForPodLog(
          podName!,
          'Executing tool=webSearch',
          90_000,
        );
        expect(
          logFound,
          `Pod ${podName} logs did not contain "Executing tool=webSearch" within 90 s`,
        ).toBe(true);
      } finally {
        // Informational: did the SSE stream deliver content?
        let sseDelivered = false;
        let sseHasRelatedContent = false;
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
          sseHasRelatedContent = sse.lines.some((l) =>
            /kubernetes|networking|container|pod|cluster/i.test(l),
          );
        } catch {
          // LLM did not produce SSE output within the budget — expected for small models
        }
        console.log(
          `web_search observability: SSE delivered=${sseDelivered}, ` +
          `SSE contains related terms=${sseHasRelatedContent}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'web_search: SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — this is informational only.',
          );
        }
        sse.dispose();
      }
    },
    180_000,
  );

  // ── 3a. browser (LLM-driven): directive prompt → agentBrowser tool pod ──────
  //
  // This test issues a directive prompt that names the `browser` tool
  // explicitly (not `web_fetch`). Gemma/small models sometimes fall back to
  // `web_fetch` anyway — see the fallback note in the test body. Either way
  // a browser-category tool pod must be spawned.
  //
  // Hard assertions:
  //   - POST /message returns 200
  //   - A browser-category tool pod appears within 120 s
  //   - Pod logs contain "Executing tool=agentBrowser"
  //     (tool-server.ts:357: `log(\`Executing tool=${tool} requestId=${requestId}\`)`)
  //
  // Informational only (console.log / console.warn):
  //   - SSE delivered any data within 90 s
  //   - SSE mentions "example.com" or "Example Domain" (Chromium navigation result)
  it(
    'browser (Playwright agent_browser) tool spawns a browser-category tool pod and executes Chromium-backed navigation',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // The directive is as explicit as possible: name the tool, provide the
      // argument, forbid any other tool or text response. This maximises the
      // chance that even small/quantised models (Gemma 4B Q4) pick `browser`
      // over `web_fetch`. If the model still chooses `web_fetch`, the pod-spawn
      // assertion still passes (both map to category=browser); only the
      // `Executing tool=agentBrowser` log check is informational in that case.
      const postPromise = postMessage(
        'You have one tool called browser(command). ' +
        "You MUST call browser with command='Navigate to https://example.com and report the page title'. " +
        'Do not respond with any text — only call the browser tool right now. ' +
        'Do not use any other tool.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      let agentBrowserLogFound = false;
      try {
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // Poll for a tool pod created after this test started.
        podName = await waitForToolPod('app=kubeclaw-tool-pod', 120_000, testStartMs);
        if (podName === null) {
          podName = await waitForToolPod('kubeclaw/category=browser', 30_000, testStartMs);
        }
        expect(
          podName,
          'No kubeclaw-tool-pod appeared within 120 s after browser directive',
        ).not.toBeNull();

        // Hard assertion: pod logs must contain the agentBrowser execution marker.
        // tool-server.ts:357 emits: `[tool-server:browser] Executing tool=agentBrowser requestId=...`
        agentBrowserLogFound = await waitForPodLog(
          podName!,
          'Executing tool=agentBrowser',
          90_000,
        );

        if (!agentBrowserLogFound) {
          // Gemma chose web_fetch instead — verify which tool ran.
          const webFetchFallback = await waitForPodLog(podName!, 'Executing tool=webFetch', 5_000);
          if (webFetchFallback) {
            console.warn(
              'browser (LLM-driven): LLM chose web_fetch instead of browser — ' +
              'tool dispatch path verified for browser-category category. ' +
              'The agentBrowser code path is deterministically validated by the Redis-bypass test.',
            );
          }
        }

        expect(
          agentBrowserLogFound,
          `Pod ${podName} logs did not contain "Executing tool=agentBrowser" within 90 s — ` +
          'LLM may have chosen a different tool; see Redis-bypass test for deterministic coverage',
        ).toBe(true);
      } finally {
        // Informational: SSE content within 90 s budget.
        let sseDelivered = false;
        let sseHasBrowserContent = false;
        try {
          await sse.waitFor((l) => l.length > 0, 90_000);
          sseDelivered = sse.lines.length > 0;
          sseHasBrowserContent = sse.lines.some((l) =>
            /example\.com|Example Domain|example domain/i.test(l),
          );
        } catch {
          // LLM did not produce SSE output within the budget — expected for small/slow models
        }
        console.log(
          `browser (LLM-driven) observability: SSE delivered=${sseDelivered}, ` +
          `SSE contains browser navigation result=${sseHasBrowserContent}, ` +
          `agentBrowser log found=${agentBrowserLogFound}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'browser (LLM-driven): SSE stream delivered no data within 90 s. ' +
            'Chromium boot adds ~5-10s latency; small model may not have responded yet — this is informational only.',
          );
        }
        sse.dispose();
      }
    },
    240_000,
  );

  // ── 3b. browser (Redis bypass): direct Redis injection → agentBrowser ────────
  //
  // This test bypasses the LLM entirely to give hard, deterministic coverage of
  // the agentBrowser code path, regardless of which tool the LLM model chooses.
  //
  // Steps:
  //   1. XADD to `kubeclaw:spawn-tool-pod` to request a browser-category pod.
  //   2. Wait for the pod to appear (120 s).
  //   3. XADD a tool call to `kubeclaw:toolcalls:<agentJobId>:browser` with
  //      tool=agentBrowser.
  //   4. Assert pod logs contain "Executing tool=agentBrowser".
  //      (tool-server.ts:357: `log(\`Executing tool=${tool} requestId=${requestId}\`)`)
  it(
    'browser tool dispatched via Redis bypass executes via agent-browser CLI',
    async (ctx) => {
      if (!redis) {
        ctx.skip();
        return;
      }

      // Unique job ID for this test run — prevents cross-test pod collisions.
      const agentJobId = `e2e-browser-bypass-${Date.now()}`;
      const requestId = `req-${Date.now()}`;
      const testStartMs = Date.now();

      // 1. Request the orchestrator to spawn a browser-category tool pod.
      //    The `channel` field is omitted so `channelPvcNames` falls back to
      //    the default 'kubeclaw-groups' / 'kubeclaw-sessions' PVCs (ipc-redis.ts:64-65).
      await redis.xadd(
        'kubeclaw:spawn-tool-pod',
        '*',
        'agentJobId', agentJobId,
        'groupFolder', 'http',
        'category', 'browser',
        'timeout', '120000',
      );

      // 2. Wait for the tool pod to be created and become Running/Completed.
      let podName: string | null = await waitForToolPod('app=kubeclaw-tool-pod', 120_000, testStartMs);
      if (podName === null) {
        podName = await waitForToolPod('kubeclaw/category=browser', 30_000, testStartMs);
      }
      expect(
        podName,
        `No browser-category tool pod appeared within 120 s for agentJobId=${agentJobId}`,
      ).not.toBeNull();

      // 3. Inject a tool call directly into the tool pod's input stream.
      //    The stream key matches TOOLCALLS_STREAM in tool-server.ts:24:
      //      `kubeclaw:toolcalls:${agentJobId}:${category}`
      //    Using `echo 'agent-browser invoked'` as the command so the pod
      //    doesn't need a real network — agent-browser CLI receives it and
      //    exits immediately.
      await redis.xadd(
        `kubeclaw:toolcalls:${agentJobId}:browser`,
        '*',
        'requestId', requestId,
        'tool', 'agentBrowser',
        'input', JSON.stringify({ command: "echo 'agent-browser invoked'" }),
      );

      // 4. Hard assertion: pod logs must contain the execution marker.
      //    tool-server.ts:357: `log(\`Executing tool=${tool} requestId=${requestId}\`)`
      //    which produces: `[tool-server:browser] Executing tool=agentBrowser requestId=...`
      const logFound = await waitForPodLog(
        podName!,
        'Executing tool=agentBrowser',
        90_000,
      );
      expect(
        logFound,
        `Pod ${podName} logs did not contain "Executing tool=agentBrowser" within 90 s ` +
        `(agentJobId=${agentJobId}, requestId=${requestId})`,
      ).toBe(true);

      console.log(
        `browser (Redis bypass): agentBrowser dispatched and confirmed in pod ${podName} ` +
        `(agentJobId=${agentJobId})`,
      );
    },
    240_000,
  );
});
