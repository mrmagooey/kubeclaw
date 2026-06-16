/**
 * Minikube-live e2e: Story 166 — web_fetch tool job dispatched via the live LLM.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded svc/kubeclaw-channel-http
 * to localhost:14081.
 *
 * Test strategy
 * ─────────────
 * POST a message asking the assistant to summarize a stable Wikipedia article.
 * The directive prompt names `web_fetch` explicitly so that even small/quantised
 * models (Gemma-4-E4B-it-Q4_0) reliably pick the correct tool.
 *
 * Hard assertions (must pass):
 *   - POST /message returns HTTP 200.
 *   - A sidecar tool pod labelled app=kubeclaw-sidecar-tool appears within 90 s.
 *   - The pod's logs contain "Executing tool=web_fetch".
 *     (The catalog tool name is "web_fetch"; the sidecar tool-server logs the
 *     `tool` field verbatim from the toolcalls Redis stream.)
 *
 * Informational (console.log / console.warn only — not hard failures):
 *   - Whether the SSE stream delivered any data within 60 s.
 *   - Whether the SSE reply mentions "Mottainai" or "Maathari" (AC4 proxy).
 *
 * ACs that are informational only:
 *   AC1 (channel-pod log line tool_call name=web_fetch) — hard to assert without
 *       streaming the orchestrator logs in CI; the pod-log "Executing tool=web_fetch"
 *       is an equivalent observable signal.
 *   AC4 (distinctive proper noun in SSE reply) — marked informational because
 *       small models may produce truncated summaries. Covered by the SSE check.
 *   AC5 (Prometheus counter increment) — requires a running port-forward to the
 *       metrics service that is not set up by the global setup; marked not-coverable
 *       without additional harness work. See Notes section in user_stories.md.
 *
 * Target URL: https://en.wikipedia.org/wiki/Mottainai
 * Distinctive phrase: "Maathai" (appears in the article body, not in the URL).
 *
 * Run: npm run test:minikube-live -- minikube-live-web-fetch
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

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
 * Reads `data: ...` lines from an SSE stream and resolves on a predicate.
 * Returns an object with the accumulated lines, a waitFor helper, and dispose.
 */
async function openSseStream(
  user: string,
  pass: string,
): Promise<{
  lines: string[];
  waitFor: (pred: (lines: string[]) => boolean, ms: number) => Promise<void>;
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
    waitFor: async (pred, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (pred(lines)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`SSE waitFor timed out after ${ms}ms (lines: ${JSON.stringify(lines)})`);
    },
    dispose: () => controller.abort(),
  };
}

async function postMessage(
  text: string,
  user = KUBECLAW_LIVE_USER,
  pass = KUBECLAW_LIVE_PASS,
): Promise<Response> {
  return fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
}

/**
 * Poll kubectl for a pod matching `labelSelector` created at or after `sinceMs`.
 * Returns the pod name or null on timeout.
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

/**
 * Poll kubectl logs for a pod until `substring` appears or timeout expires.
 */
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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: Story 166 — web_fetch tool job dispatched via LLM directive', () => {
  let provisioned = false;

  beforeAll(async () => {
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(`Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`);
    }
  });

  afterAll(() => { /* nothing to teardown — tool pods are self-cleaning (TTL) */ });

  // ── web_fetch: LLM directive → sidecar tool pod → web_fetch execution ──

  it(
    'web_fetch tool call → sidecar tool pod executes web_fetch',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // Directive prompt: name the tool and URL explicitly. This maximises
      // the chance that even Gemma-4-E4B-it-Q4_0 picks web_fetch.
      // Target: https://en.wikipedia.org/wiki/Mottainai — a stable article
      // containing the distinctive phrase "Maathai" (AC4 proxy).
      const postPromise = postMessage(
        'You MUST call the web_fetch tool with url=https://en.wikipedia.org/wiki/Mottainai. ' +
        'Do not call any other tool. Do not respond with any text — only ' +
        'call web_fetch with url=https://en.wikipedia.org/wiki/Mottainai right now.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      try {
        // AC1 proxy: POST returns 200 (the channel pod accepted the message).
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // AC2 proxy: a browser-category sidecar tool pod appears within 90 s.
        // The primary label on pod template is app=kubeclaw-sidecar-tool.
        podName = await waitForToolPod('app=kubeclaw-sidecar-tool', 90_000, testStartMs);
        expect(
          podName,
          'No kubeclaw-sidecar-tool pod appeared within 90 s after web_fetch directive (Story 166 AC2)',
        ).not.toBeNull();

        // AC2 proxy: pod logs must contain the web_fetch execution marker.
        // tool-server.ts emits: `Executing tool=web_fetch requestId=...`
        // (The catalog tool name is "web_fetch", not the old camelCase "webFetch" —
        // the sidecar tool-server logs the `tool` field verbatim from the toolcalls
        // Redis stream, and callCatalogToolViaRedis writes tool=<toolName>.)
        const logFound = await waitForPodLog(podName!, 'Executing tool=web_fetch', 90_000);
        expect(
          logFound,
          `Pod ${podName} logs did not contain "Executing tool=web_fetch" within 90 s`,
        ).toBe(true);
      } finally {
        // AC4 (informational): did SSE reply mention the distinctive phrase "Maathai"?
        let sseDelivered = false;
        let sseHasPhrase = false;
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
          sseHasPhrase = sse.lines.some((l) => /Maathai|Mottainai|mottainai/i.test(l));
        } catch {
          // LLM did not produce SSE output within budget — expected for small models.
        }
        console.log(
          `web_fetch (Story 166) observability: SSE delivered=${sseDelivered}, ` +
          `SSE mentions distinctive phrase=${sseHasPhrase}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'web_fetch (Story 166): SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — this is informational only.',
          );
        }
        sse.dispose();
      }
    },
    // Total budget: 90 s pod wait + 90 s log wait + 60 s SSE + headroom.
    300_000,
  );
});
