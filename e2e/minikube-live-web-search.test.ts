/**
 * Minikube-live e2e: Story 167 — web_search tool job dispatched via the live LLM.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded svc/kubeclaw-channel-http
 * to localhost:14081.
 *
 * Test strategy
 * ─────────────
 * POST a message with a "current/latest" framing to steer the LLM toward the
 * web_search tool (not web_fetch). The directive prompt names web_search
 * explicitly so small models also pick it reliably.
 *
 * The query uses a stable topic so the search backend returns non-empty results
 * regardless of the exact news cycle: "kubernetes ingress-nginx CVE".
 *
 * Hard assertions (must pass):
 *   - POST /message returns HTTP 200.
 *   - A tool pod labelled app=kubeclaw-tool-pod appears within 90 s.
 *   - The pod's logs contain "Executing tool=webSearch".
 *
 * Informational (console.log / console.warn only — not hard failures):
 *   - Whether the SSE reply contains a fully-qualified URL (AC4 proxy).
 *   - Whether SSE delivered any data within 60 s.
 *
 * ACs not fully coverable:
 *   AC3 (JSON array shape of tool-job stdout) — would require capturing the
 *       tool pod's stdout and parsing it, which is brittle over kubectl logs
 *       when the pod may still be running. Covered structurally by the
 *       existing tool-server contract tests.
 *   AC4 (reply URL grounding) — informational: small models may not cite URLs.
 *   AC5 (NetworkPolicy egress block) — requires kubectl apply/delete of a
 *       NetworkPolicy and a second LLM call; kept out-of-scope for this file
 *       to avoid leaving a deny policy active (user_stories.md Notes: "do not
 *       leave it active across tests because Story 166 reuses the same
 *       browser-category egress").
 *
 * Run: npm run test:minikube-live -- minikube-live-web-search
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
      throw new Error(`SSE waitFor timed out after ${ms}ms`);
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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: Story 167 — web_search tool job dispatched via LLM directive', () => {
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
      console.warn(`Port-forward to ${HTTP_URL} not reachable — globalSetup may have failed.`);
    }
  });

  afterAll(() => { /* tool pods are self-cleaning via TTL */ });

  // ── web_search: LLM directive → browser-category tool pod → webSearch execution ──

  it(
    'web_search tool call → browser-category tool pod executes webSearch',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

      // "latest" framing plus explicit tool name to steer the LLM reliably.
      // The query topic is stable enough not to be time-sensitive.
      const postPromise = postMessage(
        'You MUST call the web_search tool with query="kubernetes ingress-nginx CVE latest". ' +
        'Do not call any other tool. Do not respond with any text — only ' +
        'call web_search with query="kubernetes ingress-nginx CVE latest" right now.',
      );

      const testStartMs = Date.now();
      let podName: string | null = null;
      try {
        // AC1 proxy: POST /message returns 200.
        const res = await postPromise;
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // AC2 proxy: a browser-category tool pod appears within 90 s.
        // Both web_fetch and web_search map to category=browser; the pod label
        // app=kubeclaw-tool-pod is the reliable selector (category is on the Job
        // metadata, not the pod template — see minikube-live-tool-pods.test.ts).
        podName = await waitForToolPod('app=kubeclaw-tool-pod', 90_000, testStartMs);
        expect(
          podName,
          'No kubeclaw-tool-pod appeared within 90 s after web_search directive (Story 167 AC2)',
        ).not.toBeNull();

        // AC2 proxy: pod logs must contain the webSearch execution marker.
        // tool-server.ts emits: `Executing tool=webSearch requestId=...`
        const logFound = await waitForPodLog(podName!, 'Executing tool=webSearch', 90_000);
        expect(
          logFound,
          `Pod ${podName} logs did not contain "Executing tool=webSearch" within 90 s`,
        ).toBe(true);
      } finally {
        // AC4 (informational): does the SSE reply contain a URL?
        let sseDelivered = false;
        let sseHasUrl = false;
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
          // A grounded reply should contain at least one https:// link.
          sseHasUrl = sse.lines.some((l) => /https?:\/\/[a-zA-Z0-9.-]+/.test(l));
        } catch {
          // LLM did not produce SSE output within budget.
        }
        console.log(
          `web_search (Story 167) observability: SSE delivered=${sseDelivered}, ` +
          `SSE contains URL=${sseHasUrl}, ` +
          `tool pod name=${podName ?? 'none'}`,
        );
        if (!sseDelivered) {
          console.warn(
            'web_search (Story 167): SSE stream delivered no data within 60 s. ' +
            'Small model may not have responded yet — informational only.',
          );
        }
        sse.dispose();
      }
    },
    300_000,
  );
});
