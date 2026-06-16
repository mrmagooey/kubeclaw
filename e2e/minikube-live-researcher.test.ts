/**
 * Minikube-live: Researcher specialist grounds reply in fetched URL.
 *
 * First end-to-end coverage of the @mention specialist dispatch path
 * against a real helm-installed kubeclaw + real LLM:
 *
 *   HTTP channel → @mention parser → specialist runner →
 *     tool-job pod → real web_fetch (Wikipedia) →
 *     LLM grounding → SSE delivery → conversation_history
 *
 * Spec: docs/superpowers/specs/2026-05-30-minikube-live-researcher-test-design.md
 *
 * The Researcher specialist is injected by minikube-live-setup.ts via
 * `--set-json specialists=[Researcher]` at helm install time. The chart
 * default values.yaml ships `specialists: []` (empty), so the override is
 * required for this test to register the specialist. The override declares
 * the `web_search` and `web_fetch` tools and `llmProvider: openrouter`.
 *
 * Approach A from the brainstorming: give the URL directly in the user
 * prompt so the specialist goes straight to `web_fetch`, bypassing
 * `web_search` and the infrastructure that would be needed to stub it.
 *
 * NetworkPolicy egress for `browser` category tool pods (where web_fetch
 * runs) is set to allow TCP/443 with no CIDR restriction
 * (helm/kubeclaw/templates/networkpolicies.yaml:113-144), so the pod can
 * reach en.wikipedia.org out of the box.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// "Mottainai" — a Japanese concept of regret over waste. The Wikipedia
// article is short, stable, and contains a specific named connection (the
// Kenyan environmentalist Wangari Maathai championed the term at the UN in
// 2005) that even capable free-tier models like google/gemma-4-31b-it:free
// reliably miss when asked from pretraining alone. That makes a correct
// answer strong evidence of an actual web_fetch round-trip.
const WIKI_URL = 'https://en.wikipedia.org/wiki/Mottainai';
const WIKI_URL_FRAGMENT = 'wikipedia.org/wiki/Mottainai';
// "Maathai" appears in the article as part of the named link to Wangari
// Maathai. Backstop if this ever flakes: change to "Wangari" (same lead
// paragraph, slightly weaker because the model could guess "Wangari Maathai"
// is a Kenyan environmentalist).
const EXPECTED_FACT = 'Maathai';

const SSE_WAIT_MS = 90_000;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Probe the LLM provider exactly the way e2e/live-llm.test.ts does (modulo
 * the chat-completions body size). Returns ok=true when both /models is
 * reachable and a tiny /chat/completions request produces a string response.
 * Runs at module load via top-level await so describe.skipIf sees the right
 * value.
 */
async function probeProvider(): Promise<{ ok: boolean; reason: string }> {
  const baseUrl =
    process.env.LIVE_LLM_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = process.env.LIVE_LLM_API_KEY || 'no-key';
  const model = process.env.LIVE_LLM_MODEL || 'google/gemma-4-31b-it:free';
  try {
    const modelsRes = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!modelsRes.ok) {
      return { ok: false, reason: `GET /models → HTTP ${modelsRes.status}` };
    }
    const chatRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => '');
      return {
        ok: false,
        reason: `POST /chat/completions → HTTP ${chatRes.status}: ${body.slice(0, 200)}`,
      };
    }
    const payload = (await chatRes.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
        };
      }[];
    };
    // Some reasoning models (e.g. Kimi k2.5, Nemotron via OpenRouter) leave
    // `content` null and put the answer in `reasoning`/`reasoning_content` —
    // and under the tiny max_tokens probe the reasoning budget can leave
    // `content` empty. Accept a non-empty string in any of these fields, which
    // mirrors how the runtime extracts the answer (DirectLLMRunner) and the
    // phase-3 / specialist-mention-routing probes.
    const msg = payload.choices?.[0]?.message;
    const nonEmpty = (s: unknown): boolean =>
      typeof s === 'string' && s.length > 0;
    if (
      !nonEmpty(msg?.content) &&
      !nonEmpty(msg?.reasoning) &&
      !nonEmpty(msg?.reasoning_content)
    ) {
      return { ok: false, reason: 'malformed chat response (no content/reasoning field)' };
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Stream /stream as the given user. Returns an array of SSE `data: …` lines
 * the consumer can poll, plus a waitFor poll helper and a dispose abort.
 * Mirrors the helper in e2e/minikube-live-tasks.test.ts:67-124.
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
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (last lines: ${JSON.stringify(lines.slice(-5))})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

/**
 * RFC3339 timestamp marking "right now" on the host clock. Use this BEFORE
 * the test's POST so that orchestratorLogsSince() returns only lines emitted
 * after this point. Scoping by timestamp prevents false positives from
 * earlier tests sharing the kubeclaw-live namespace.
 *
 * (Note: the host clock and the cluster's clock may drift by a few seconds
 * on a sleepy laptop. That's acceptable: the window only needs to start
 * AFTER this test's POST, not exactly at the wall-clock instant of the POST.
 * If clock drift ever becomes a real problem, switch to using a pod's
 * status.startTime from kubectl and offset forward.)
 */
function orchestratorLogCheckpoint(): string {
  return new Date().toISOString();
}

/**
 * Return orchestrator log lines emitted after the given RFC3339 timestamp.
 * Used to confirm THIS test's request invoked web_fetch — the kubeclaw-live
 * namespace is shared across the suite, so an unscoped `--since=Ns` query
 * would match earlier tests' tool-pod-creation events as false positives.
 */
function orchestratorLogsSince(rfc3339: string): string {
  const r = spawnSync(
    'kubectl',
    [
      'logs',
      'deploy/kubeclaw-orchestrator',
      '-n',
      NAMESPACE,
      `--since-time=${rfc3339}`,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 },
  );
  return (r.stdout ?? '') + (r.stderr ?? '');
}

// Module-level probe so describe.skipIf sees the right value at definition
// time (vitest evaluates the second argument BEFORE beforeAll runs).
const { ok: providerAvailable, reason: providerSkipReason } =
  await probeProvider();
if (!providerAvailable) {
  console.warn(
    `[minikube-live-researcher] LLM provider unavailable: ${providerSkipReason}\n` +
      '   Test will be skipped.',
  );
}

describe.skipIf(!providerAvailable)(
  'Researcher specialist grounds reply in fetched URL (minikube-live)',
  () => {
    it(
      '@Researcher reads a Wikipedia URL and answers from its content',
      async () => {
        const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
        try {
          // 1. Send the @Researcher mention with an explicit URL so the
          //    specialist goes straight to web_fetch (skips web_search).
          const logCheckpoint = orchestratorLogCheckpoint();
          const postRes = await fetch(`${HTTP_URL}/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
            },
            body: JSON.stringify({
              text:
                `@Researcher Use web_fetch on ${WIKI_URL} and tell me the ` +
                'surname of the Kenyan environmentalist who popularised the ' +
                'concept of mottainai internationally. ' +
                'Your reply MUST end with a line that begins with the ' +
                'literal text "Source: " followed by the URL you fetched.',
            }),
            signal: AbortSignal.timeout(15_000),
          });
          expect(postRes.status, 'POST /message should return 200').toBe(200);

          // 2. Wait until the full Researcher reply has arrived: both the
          //    [@Researcher] prefix and the Source: <url> citation must be in
          //    the buffer. The HTTP channel splits multi-line replies across
          //    multiple SSE `data:` frames; resolving on just the [@Researcher]
          //    frame can truncate the reply before the body/citation arrive.
          //    channel-runner.ts wraps specialist replies with that tag in
          //    its dispatch path (search for `[@${run.specialistName}]`).
          await sse.waitFor(
            (lines) => {
              const start = lines.findIndex((l) => l.includes('[@Researcher]'));
              if (start === -1) return false;
              return lines.slice(start).some((l) => l.includes(WIKI_URL_FRAGMENT));
            },
            SSE_WAIT_MS,
          );

          const researcherLine = sse.lines.find((l) =>
            l.includes('[@Researcher]'),
          );
          expect(researcherLine).toBeDefined();

          // The HTTP channel emits multi-line replies as multiple SSE `data:`
          // frames; only the FIRST frame carries the [@Researcher] prefix.
          // Asserting against just that first frame misses any content the
          // model puts on a later line (intro sentence + body, citations, etc).
          // Join everything from the [@Researcher] line forward so all three
          // assertions see the full reply block.
          const researcherIdx = sse.lines.indexOf(researcherLine!);
          const fullReply = sse.lines.slice(researcherIdx).join('\n');

          // 3. Primary assertion: reply contains the known fact from the page.
          expect(
            fullReply,
            `Researcher reply should mention "${EXPECTED_FACT}" (the surname ` +
              `of the environmentalist named on the article). ` +
              `Got: ${JSON.stringify(fullReply)}`,
          ).toContain(EXPECTED_FACT);

          // 4. Secondary assertion: the orchestrator spawned a browser-category
          //    tool pod AFTER our POST. The cluster-level orchestrator info
          //    log emits `Tool pod job created` with `category: browser` for
          //    any web_fetch/web_search/browser tool dispatch. Scoping by
          //    --since-time (captured immediately before our POST) is critical
          //    because kubeclaw-live is shared across the suite; an unscoped
          //    --since=Ns window would match earlier tests' tool pods as
          //    false positives.
          const logs = orchestratorLogsSince(logCheckpoint);
          expect(
            logs,
            'orchestrator log between POST and SSE reply should record a ' +
              'Tool pod job created entry — without it, the test cannot ' +
              'prove the specialist invoked a tool rather than answering ' +
              'from pretraining.',
          ).toMatch(/Tool pod job created/);
          expect(
            logs,
            'the tool pod should be browser-category — the only category ' +
              'that contains web_fetch (the tool the Researcher must call ' +
              'to read the Wikipedia URL).',
          ).toMatch(/"category":"browser"/);

          // 5. Tertiary assertion: the SSE reply itself echoes back the
          //    Wikipedia URL. The prompt instructed citation in a specific
          //    `Source: <url>` format; a model that didn't actually fetch
          //    the page has no reason to produce this exact substring.
          //    Asserts on a fragment (wikipedia.org/wiki/Mottainai) rather
          //    than the full URL so a trailing slash or fragment doesn't
          //    flake the check.
          expect(
            fullReply,
            `Researcher should cite the Wikipedia URL in its reply. ` +
              `Got: ${JSON.stringify(fullReply)}`,
          ).toContain(WIKI_URL_FRAGMENT);
        } finally {
          sse.dispose();
        }
      },
      120_000,
    );
  },
);
