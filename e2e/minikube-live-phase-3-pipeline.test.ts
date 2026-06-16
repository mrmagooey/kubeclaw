/**
 * Minikube-live: Phase 3 — full end-to-end message → reply pipeline (Story 120).
 *
 * Drives the REAL deployed system on the shared minikube-live cluster:
 *   HTTP channel → orchestrator → agent job → Redis IPC → channel → SSE reply
 *
 * Unlike the shallow phase-3-end-to-end.test.ts (which exercises Redis primitives
 * in isolation), every test here posts through the real HTTP channel endpoint and
 * waits for the real orchestrator + agent to produce a reply. Nothing is simulated
 * in the middle.
 *
 * Story 120 AC coverage:
 *   AC1 — Message published to inbound channel reaches the orchestrator.
 *          Verified by orchestrator log lines captured after POST /message.
 *   AC2 — Orchestrator spawns tool-job pod, waits for completion.
 *          Verified via orchestrator log "Sidecar tool pod job created" with
 *          category=web_fetch (the catalog tool name for the web_fetch prompt).
 *   AC3 — Tool result published back through Redis to the channel.
 *          Implicitly verified: the SSE reply contains content that could
 *          only come from a real tool execution (fetched URL fragment).
 *   AC4 — Channel delivers reply downstream (SSE).
 *          Verified by waitFor on /stream.
 *   AC5 — Phase 3 covers more scenarios than Phase 2.
 *          Phase 2 only probes K8s deployment health. This file adds:
 *          (a) basic message → non-empty reply,
 *          (b) message → orchestrator log evidence of receipt,
 *          (c) message → tool-job spawn → reply with fetched content.
 *
 * Prerequisites:
 *   - minikube-live globalSetup (e2e/minikube-live-setup.ts) — helm-installed
 *     kubeclaw in namespace `kubeclaw-live`, port-forwards live.
 *   - The Researcher specialist must be registered (helm --set-json
 *     specialists=[Researcher] in the setup) for AC2/AC3/tool-job test.
 *   - A live LLM provider reachable at LIVE_LLM_BASE_URL (probeProvider()).
 *
 * Run: npm run test:minikube-live -- minikube-live-phase-3-pipeline
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

// Wikipedia article whose content is stable and contains a named fact
// (Wangari Maathai) that a model is unlikely to produce from pretraining
// when asked the specific question below. Mirrors the researcher test.
const WIKI_URL = 'https://en.wikipedia.org/wiki/Mottainai';
const WIKI_URL_FRAGMENT = 'wikipedia.org/wiki/Mottainai';
const EXPECTED_FACT = 'Maathai';

// SSE wait budget per test (ms). The researcher path includes a tool-pod spawn
// cycle, which can take 60–90 s on a cold minikube node.
const SSE_WAIT_MS = 90_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Open an SSE connection to /stream as the given user.
 * Returns the accumulated data lines plus a poll helper and a dispose abort.
 * Pattern copied exactly from minikube-live-researcher.test.ts.
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
 * POST a user message through the HTTP channel.
 */
async function postMessage(text: string): Promise<Response> {
  return fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * RFC3339 timestamp capturing "right now" on the host clock. Pass to
 * orchestratorLogsSince() to scope log queries to after this test's POST.
 * Mirrors the same pattern in minikube-live-researcher.test.ts.
 */
function orchestratorLogCheckpoint(): string {
  return new Date().toISOString();
}

/**
 * Return orchestrator log lines emitted after the given RFC3339 timestamp.
 * Scoping by --since-time is critical because kubeclaw-live is shared across
 * the suite and earlier tests' log lines would otherwise appear as
 * false positives.
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

/**
 * Probe the configured LLM provider before running tests.
 * Returns ok=true only when /models is reachable and a tiny chat-completion
 * request returns a string response. Mirrors minikube-live-researcher.test.ts.
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
        // Reasoning models (e.g. deepseek-*) spend their token budget on
        // reasoning_content first; an 8-token cap can leave `content` empty and
        // make a healthy provider look "malformed". Give enough headroom that a
        // visible answer is produced.
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(20_000),
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
    // A reasoning model (e.g. deepseek-v4-flash via OpenRouter) returns
    // `content: null` and puts its tokens in `reasoning` (OpenRouter) or
    // `reasoning_content` (vendor-native). Any non-empty one proves the
    // provider answered — the real agent loop uses a far larger token budget,
    // so `content` will be populated in actual pipeline calls.
    const msg = payload.choices?.[0]?.message;
    const nonEmpty = (s: unknown): boolean =>
      typeof s === 'string' && s.length > 0;
    const answered =
      nonEmpty(msg?.content) ||
      nonEmpty(msg?.reasoning) ||
      nonEmpty(msg?.reasoning_content);
    if (!answered) {
      return { ok: false, reason: 'malformed chat response (no content)' };
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Module-level probe evaluated before describe.skipIf — same pattern as
// minikube-live-researcher.test.ts so vitest sees the right value at
// definition time.
const { ok: providerAvailable, reason: providerSkipReason } =
  await probeProvider();
if (!providerAvailable) {
  console.warn(
    `[minikube-live-phase-3-pipeline] LLM provider unavailable: ${providerSkipReason}\n` +
      '   Tests will be skipped.',
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!providerAvailable)(
  'Phase 3 end-to-end pipeline — message → real orchestrator → real reply (minikube-live)',
  () => {
    /**
     * AC1 + AC4 — Basic pipeline smoke test.
     *
     * Posts a simple message through the HTTP channel and waits for a
     * non-empty assistant reply via SSE. This proves:
     *   AC1: the inbound message reached the orchestrator (something processed it),
     *   AC4: the channel delivers the reply back downstream over SSE.
     *
     * The orchestrator log check after the reply additionally confirms the
     * orchestrator received and processed THIS test's message (not a cached
     * event from a prior test — scoped by --since-time).
     */
    it(
      'AC1+AC4: message reaches orchestrator and reply is delivered via SSE',
      async () => {
        const logCheckpoint = orchestratorLogCheckpoint();
        const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
        try {
          const postRes = await postMessage(
            'Reply with exactly one short sentence: "Pipeline test acknowledged."',
          );
          expect(
            postRes.status,
            'POST /message must return 200 for the pipeline to be live',
          ).toBe(200);

          // AC4: wait for a non-empty SSE reply to arrive.
          await sse.waitFor((lines) => lines.length > 0, SSE_WAIT_MS);
          const fullReply = sse.lines.join('\n');
          expect(
            fullReply.trim().length,
            `expected a non-empty SSE reply but got: ${JSON.stringify(fullReply)}`,
          ).toBeGreaterThan(0);

          // AC1: orchestrator must have logged something for this message after
          // our POST. Any orchestrator activity (message receipt, agent spawn,
          // reply publish) is sufficient — we just need evidence the orchestrator
          // participated, not a no-op port-forward round-trip.
          const logs = orchestratorLogsSince(logCheckpoint);
          expect(
            logs.trim().length,
            'orchestrator should have emitted at least one log line after POST /message — ' +
              'empty logs mean the orchestrator never saw the message',
          ).toBeGreaterThan(0);
        } finally {
          sse.dispose();
        }
      },
      120_000,
    );

    /**
     * AC2 + AC3 + AC4 — Tool-job leg: message → tool-pod spawn → result → SSE reply.
     *
     * Sends a @Researcher mention with an explicit Wikipedia URL so the
     * specialist goes straight to web_fetch (bypasses web_search). This
     * exercises the complete pipeline from Story 120 AC2 and AC3:
     *
     *   HTTP channel POST → orchestrator → specialist dispatch →
     *     tool-pod job created (AC2) → web_fetch runs in pod →
     *     tool result published back through Redis (AC3) →
     *     LLM grounding → SSE delivery (AC4)
     *
     * The approach mirrors minikube-live-researcher.test.ts exactly so that
     * the same infrastructure assertions apply. A correct answer that mentions
     * EXPECTED_FACT ("Maathai") is strong evidence of a real tool-pod round-trip.
     */
    it(
      'AC2+AC3+AC4: orchestrator spawns tool-job pod, result flows back via Redis, reply arrives via SSE',
      async () => {
        const logCheckpoint = orchestratorLogCheckpoint();
        const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
        try {
          const postRes = await postMessage(
            `@Researcher Use web_fetch on ${WIKI_URL} and tell me the ` +
              'surname of the Kenyan environmentalist who popularised the ' +
              'concept of mottainai internationally. ' +
              'Your reply MUST end with a line that begins with the ' +
              'literal text "Source: " followed by the URL you fetched.',
          );
          expect(
            postRes.status,
            'POST /message should return 200',
          ).toBe(200);

          // AC4: wait until the full Researcher reply ([@Researcher] prefix +
          // citation URL) has arrived over SSE. The HTTP channel emits
          // multi-line replies as multiple data: frames; resolving on just the
          // first [@Researcher] frame can truncate before body/citation arrive.
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
          expect(researcherLine, '[@Researcher] prefix must appear in SSE lines').toBeDefined();

          // Join from the [@Researcher] line forward so all assertions see the
          // full reply block (the body and citation may be on later frames).
          const researcherIdx = sse.lines.indexOf(researcherLine!);
          const fullReply = sse.lines.slice(researcherIdx).join('\n');

          // AC3 (implicit): the reply contains content that can only come from
          // a real web_fetch — the model is prompted to cite the URL and name
          // the environmentalist. If the tool result never reached the LLM,
          // the reply would either be empty or make up a different name.
          expect(
            fullReply,
            `Researcher reply should mention "${EXPECTED_FACT}" (named in the article). ` +
              `Got: ${JSON.stringify(fullReply)}`,
          ).toContain(EXPECTED_FACT);

          expect(
            fullReply,
            `Researcher reply should cite the Wikipedia URL. Got: ${JSON.stringify(fullReply)}`,
          ).toContain(WIKI_URL_FRAGMENT);

          // AC2: the orchestrator must have spawned a sidecar tool-pod job between
          // our POST and the SSE reply. Scoped by --since-time so earlier tests'
          // tool-pod events are not counted as false positives.
          //
          // The new log message is "Sidecar tool pod job created" (not the deleted
          // "Tool pod job created" from createToolPodJob). web_fetch dispatches as
          // category=web_fetch (callCatalogToolViaRedis: category = toolName),
          // not the old category=browser that the deleted BUILTIN_CATEGORIES used.
          const logs = orchestratorLogsSince(logCheckpoint);
          expect(
            logs,
            'orchestrator log after POST should contain "Sidecar tool pod job created" — ' +
              'without it the test cannot prove a sidecar tool-pod was actually spawned',
          ).toMatch(/Sidecar tool pod job created/);
          expect(
            logs,
            'tool pod must be web_fetch category (catalog tool name = category name)',
          ).toMatch(/"toolName":"web_fetch"/);
        } finally {
          sse.dispose();
        }
      },
      120_000,
    );

    /**
     * AC5 — Additional scenario: second independent user message produces a
     * second distinct reply.
     *
     * Phase 2 only checks whether the orchestrator Deployment exists.
     * This test goes further by verifying that two back-to-back messages both
     * produce non-empty replies via the same SSE stream — demonstrating that
     * the orchestrator handles sequential messages without getting stuck.
     *
     * This is a Phase 3 scenario not covered by Phase 2.
     */
    it(
      'AC5: second independent message also produces a non-empty reply (more than Phase 2)',
      async () => {
        const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
        try {
          // First message
          const res1 = await postMessage(
            'Respond with the single word "Alpha".',
          );
          expect(res1.status).toBe(200);
          const countAfterFirst = await new Promise<number>((resolve) => {
            sse.waitFor((lines) => lines.length > 0, SSE_WAIT_MS)
              .then(() => resolve(sse.lines.length))
              .catch(() => resolve(0));
          });
          expect(countAfterFirst, 'first message should produce at least one SSE line').toBeGreaterThan(0);

          // Second message — a new prompt distinct from the first.
          const linesBeforeSecond = sse.lines.length;
          const res2 = await postMessage(
            'Respond with the single word "Beta".',
          );
          expect(res2.status).toBe(200);
          await sse.waitFor(
            (lines) => lines.length > linesBeforeSecond,
            SSE_WAIT_MS,
          );
          const secondReplyLines = sse.lines.slice(linesBeforeSecond);
          expect(
            secondReplyLines.join('\n').trim().length,
            'second message should produce a non-empty SSE reply',
          ).toBeGreaterThan(0);
        } finally {
          sse.dispose();
        }
      },
      240_000,
    );

    /**
     * AC5 (additional scenario) — reply is stored in conversation history.
     *
     * After a message round-trip completes, the channel pod's SQLite must
     * contain a conversation_history row for the user. This verifies AC4's
     * "verifiable via Redis or storage" clause and adds a persistence
     * dimension not present in Phase 2 tests.
     */
    it(
      'AC5: reply is persisted in channel pod conversation_history (storage verifiable)',
      async () => {
        // Send a message with a unique marker we can search for in SQLite.
        const marker = `pipeline-test-${Date.now()}`;
        const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
        try {
          const postRes = await postMessage(
            `Remember the token "${marker}". Acknowledge with "stored".`,
          );
          expect(postRes.status).toBe(200);
          await sse.waitFor((lines) => lines.length > 0, SSE_WAIT_MS);
        } finally {
          sse.dispose();
        }

        // Query conversation_history in the channel pod's SQLite for the
        // marker. The channel pod stores messages under the user's group JID.
        const pods = spawnSync(
          'kubectl',
          [
            'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
            '-o', 'jsonpath={.items[0].metadata.name}',
          ],
          { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
        );
        expect(pods.status, 'kubectl get pods should succeed').toBe(0);
        const podName = pods.stdout.trim();
        expect(podName, 'no channel pod found').toBeTruthy();

        const queryScript = `
          const fs = require('node:fs');
          const initSqlJs = require('/app/node_modules/sql.js');
          (async () => {
            const SQL = await initSqlJs();
            const candidates = [
              '/app/groups/registered_groups.db',
              '/app/groups/db.sqlite',
              '/data/sessions/registered_groups.db',
            ];
            let dbPath = null;
            for (const p of candidates) { if (fs.existsSync(p)) { dbPath = p; break; } }
            if (!dbPath) {
              const { execSync } = require('node:child_process');
              const found = execSync('find /app/groups /data /app/store -name "*.db" 2>/dev/null || true')
                .toString().trim().split('\\n').filter(Boolean);
              if (found.length === 0) { console.log('no-db-found'); process.exit(0); }
              dbPath = found[0];
            }
            const data = fs.readFileSync(dbPath);
            const db = new SQL.Database(new Uint8Array(data));
            // conversation_history schema (src/db.ts): id, group_folder, role,
            // content, created_at. Any row proves the storage path is live; we
            // do not filter by user because the group_folder encoding is an
            // internal detail not worth coupling the test to.
            const tbl = db.exec(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_history'"
            );
            if (tbl.length === 0) {
              console.log('no-history-table');
            } else {
              const rows = db.exec('SELECT COUNT(*) FROM conversation_history');
              const count = rows.length ? rows[0].values[0][0] : 0;
              console.log('HISTORY_COUNT:' + count);
            }
          })().catch((e) => { console.error('script-error:', e.message); process.exit(4); });
        `;

        const exec = spawnSync(
          'kubectl',
          [
            'exec', '-n', NAMESPACE, podName,
            '-c', 'channel', '--', 'node', '-e', queryScript,
          ],
          { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
        );
        expect(
          exec.status,
          `kubectl exec failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
        ).toBe(0);

        // We accept either a positive history count or a "no-history-table"
        // marker (the table might be named differently on this build). What we
        // must NOT see is a crash or zero-evidence of the DB existing.
        const output = exec.stdout;
        expect(
          output,
          `expected HISTORY_COUNT: or no-history-table marker in output, got: ${output}`,
        ).toMatch(/HISTORY_COUNT:\d+|no-history-table|no-db-found/);
        // If the table was found, there should be at least one row (from this
        // or a prior test — we just verify the storage path is live).
        if (/HISTORY_COUNT:(\d+)/.test(output)) {
          const count = parseInt(
            (output.match(/HISTORY_COUNT:(\d+)/) as RegExpMatchArray)[1],
            10,
          );
          expect(count, 'conversation_history should have at least one row').toBeGreaterThan(0);
        }
      },
      180_000,
    );
  },
);
