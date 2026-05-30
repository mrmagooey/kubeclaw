# Minikube-live Researcher specialist test — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first end-to-end minikube-live test for the `@mention`
specialist dispatch path, exercising the full HTTP channel → orchestrator →
specialist runner → tool-job pod → real `web_fetch` → real LLM → SSE →
conversation_history chain.

**Architecture:** One new test file in the existing `e2e/minikube-live-*.test.ts`
suite. The test sends `@Researcher Read https://en.wikipedia.org/wiki/Albert_Einstein
and tell me when Einstein was born.` to the helm-installed kubeclaw running
in the `kubeclaw-live` namespace, waits for an SSE reply tagged
`[@Researcher]`, and asserts both (a) the reply contains the substring
`1879`, and (b) the orchestrator log contains a `web_fetch` tool-call line
referencing the Einstein URL (catches the false-positive case where the LLM
answers from pretraining without ever invoking the tool).

**Tech Stack:** TypeScript, Vitest 4, Node fetch streaming SSE,
`kubectl logs` for log grep, OpenRouter (`google/gemma-4-31b-it:free`)
auto-loaded from `.env.test.local`.

**Spec:** `docs/superpowers/specs/2026-05-30-minikube-live-researcher-test-design.md`
(commit `bc4e963`).

---

## Pre-flight findings (resolved during plan-writing)

- `e2e/minikube-live-setup.ts` does **not** override `specialists`. The
  `Researcher` specialist from `helm/kubeclaw/values.yaml:447-465` is
  registered automatically by the live helm install. **No `--set-json`
  needed.**
- `helm/kubeclaw/templates/networkpolicies.yaml:113-144` shows tool pods
  (category `browser`) have egress allowed to TCP/443 and TCP/80 with no
  CIDR restriction. **Wikipedia is reachable; no NetworkPolicy override
  needed.**
- `minikube-live-setup.ts` does **not** export a `providerAvailable` flag.
  Other minikube-live tests assume the global setup succeeded. The new test
  adds its own lightweight `skipIf` based on a top-level provider probe (~15
  lines, copied from the working pattern in `e2e/live-llm.test.ts:94-140`).
- Reusable helpers `basicAuth(user, pass)` and `openSseStream(user, pass)`
  exist in `e2e/minikube-live-tasks.test.ts:43-124`. They are inlined into
  the new test file rather than extracted (one-test scope; YAGNI).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `vitest.minikube-live.config.ts` | Modify | Auto-load `.env.test.local` so `LIVE_LLM_*` env vars reach the suite |
| `e2e/minikube-live-researcher.test.ts` | Create | The new test file: SSE-based assertion that `@Researcher` fetched the Wikipedia URL and grounded the reply on it |

---

## Task 1: Auto-load `.env.test.local` from the minikube-live config

**Files:**
- Modify: `vitest.minikube-live.config.ts`

- [ ] **Step 1: Read the current config**

```bash
cat vitest.minikube-live.config.ts
```

Expected: a single `defineConfig({…})` export with no env-file handling. The
file imports only `defineConfig` from `vitest/config`.

- [ ] **Step 2: Add the dotenv loader at the top of the file (above
  `defineConfig`)**

Edit `vitest.minikube-live.config.ts` to match this exact shape. The loader
block is a verbatim copy of the one in `vitest.live-llm.config.ts` (which
is already proven against the OpenRouter key the user provided). Pre-existing
env vars win over file values so CLI overrides still work.

Use the Edit tool. The old `import` line and the leading docblock for the
file should be replaced with the following (do **not** remove the existing
docblock content — extend it with the auto-load note):

```typescript
import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'fs';

/**
 * Minikube-live suite — exercises a real helm-deployed kubeclaw in minikube
 * against a real LLM provider. Has its own globalSetup that installs into a
 * dedicated namespace (kubeclaw-live), so it does not interfere with the
 * regular e2e suite or any existing user install.
 *
 * Auto-loads `.env.test.local` (gitignored) so LIVE_LLM_API_KEY etc. can
 * live alongside the repo without sourcing manually each run. Pre-existing
 * environment variables take precedence over values in the file.
 *
 * Run: npm run test:minikube-live
 */
const ENV_FILE = '.env.test.local';
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
```

Leave the existing `export default defineConfig({…})` block untouched after
this prelude.

- [ ] **Step 3: Verify the file still type-checks**

Run:
```bash
npx tsc --noEmit vitest.minikube-live.config.ts --target es2022 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck
```

Expected: no output (clean). If there are errors in unrelated files due to
the user's in-progress merge (`src/runtime/places-search.ts`,
`src/runtime/tools/read-user-profile.ts`), they are pre-existing and not
introduced by this task — leave them alone.

- [ ] **Step 4: Sanity-check the loader picks up the file**

Run a one-shot script that uses the same parser logic to confirm the key
loads:

```bash
node -e "
const { existsSync, readFileSync } = require('fs');
const ENV_FILE = '.env.test.local';
if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith(\"\\\"\") && value.endsWith(\"\\\"\")) ||
      (value.startsWith(\"'\") && value.endsWith(\"'\"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
console.log('LIVE_LLM_BASE_URL =', process.env.LIVE_LLM_BASE_URL);
console.log('LIVE_LLM_MODEL    =', process.env.LIVE_LLM_MODEL);
console.log('LIVE_LLM_API_KEY  =', process.env.LIVE_LLM_API_KEY ? '<set>' : '<unset>');
"
```

Expected:
```
LIVE_LLM_BASE_URL = https://openrouter.ai/api/v1
LIVE_LLM_MODEL    = google/gemma-4-31b-it:free
LIVE_LLM_API_KEY  = <set>
```

- [ ] **Step 5: Commit**

```bash
git add vitest.minikube-live.config.ts
git commit -m "$(cat <<'EOF'
chore(test): auto-load .env.test.local from vitest.minikube-live.config

Mirrors the loader already in vitest.live-llm.config.ts so LIVE_LLM_*
env vars (OpenRouter key, model, base URL) reach the minikube-live suite
without requiring callers to `set -a && source .env.test.local` each run.
Pre-existing env vars win over file values, so CLI overrides still work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: a single commit touching only `vitest.minikube-live.config.ts`.

---

## Task 2: Add the Researcher minikube-live test

**Files:**
- Create: `e2e/minikube-live-researcher.test.ts`

- [ ] **Step 1: Write the test file**

Create `e2e/minikube-live-researcher.test.ts` with exactly the content below.
This file is self-contained: imports, helpers, provider probe, the single
`it` block, and assertions are all here. The pattern mirrors
`e2e/minikube-live-tasks.test.ts` (already in the suite) for SSE handling
and `e2e/live-llm.test.ts:94-140` for the provider probe.

```typescript
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
 * The Researcher specialist is defined in helm/kubeclaw/values.yaml (default
 * chart values — not overridden by minikube-live-setup.ts). It declares the
 * `web_search` and `web_fetch` tools and llmProvider: openrouter.
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

const WIKI_URL = 'https://en.wikipedia.org/wiki/Albert_Einstein';
// "1879" appears 12+ times on the Wikipedia Einstein article (infobox, lead
// paragraph, Early life section). Backstop substring if it ever flakes:
// "Albert Einstein" (article subject name — guaranteed present).
const EXPECTED_FACT = '1879';

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
      choices?: { message?: { content?: string } }[];
    };
    if (typeof payload.choices?.[0]?.message?.content !== 'string') {
      return { ok: false, reason: 'malformed chat response' };
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
 * Return orchestrator log lines emitted in the last `sinceSeconds` seconds.
 * Used to confirm the specialist actually invoked web_fetch (catches the
 * false-positive case where the LLM answers from pretraining).
 */
function orchestratorLogs(sinceSeconds: number): string {
  const r = spawnSync(
    'kubectl',
    [
      'logs',
      'deploy/kubeclaw-orchestrator',
      '-n',
      NAMESPACE,
      `--since=${sinceSeconds}s`,
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
          const postRes = await fetch(`${HTTP_URL}/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
            },
            body: JSON.stringify({
              text:
                `@Researcher Read ${WIKI_URL} and tell me when Einstein ` +
                'was born. Cite the URL in your reply.',
            }),
            signal: AbortSignal.timeout(15_000),
          });
          expect(postRes.status, 'POST /message should return 200').toBe(200);

          // 2. Wait for an SSE frame whose text starts with [@Researcher].
          //    channel-runner.ts:2733 wraps specialist replies with that tag.
          await sse.waitFor(
            (lines) => lines.some((l) => l.includes('[@Researcher]')),
            SSE_WAIT_MS,
          );

          const researcherLine = sse.lines.find((l) =>
            l.includes('[@Researcher]'),
          );
          expect(researcherLine).toBeDefined();

          // 3. Primary assertion: reply contains the known fact from the page.
          expect(
            researcherLine,
            `Researcher reply should mention "${EXPECTED_FACT}" (Einstein's birth year). ` +
              `Got: ${JSON.stringify(researcherLine)}`,
          ).toContain(EXPECTED_FACT);

          // 4. Secondary assertion: the orchestrator logged a web_fetch
          //    tool_call for the Einstein URL. Proves the specialist actually
          //    invoked the tool rather than answering from pretraining.
          //    --since=180s window covers the SSE wait plus generous slack.
          const logs = orchestratorLogs(180);
          expect(
            logs,
            'orchestrator log should contain a web_fetch tool call line ' +
              'referencing the Einstein Wikipedia URL — without it the test ' +
              'cannot prove the specialist actually grounded its reply.',
          ).toMatch(/web_fetch/);
          expect(logs).toContain('en.wikipedia.org/wiki/Albert_Einstein');
        } finally {
          sse.dispose();
        }
      },
      120_000,
    );
  },
);
```

- [ ] **Step 2: Verify the file type-checks**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -v "src/runtime/places-search\|src/runtime/tools/read-user-profile\|src/runtime/direct-llm-runner" | head -10
```

Expected: no output. Any errors mentioning the three pre-existing
merge-conflict files in `src/runtime/` are not introduced by this task and
should be left alone.

- [ ] **Step 3: Verify the test file appears in the minikube-live glob**

Run:
```bash
npx vitest list --config vitest.minikube-live.config.ts 2>&1 | grep "minikube-live-researcher"
```

Expected: the file path is listed by vitest.

- [ ] **Step 4: Run the suite against minikube and verify the new test passes**

Pre-flight: confirm minikube is up and the kubeclaw-live namespace's
helm-installed kubeclaw is ready.

```bash
minikube status | head -3
kubectl get pods -n kubeclaw-live 2>/dev/null | head -5
```

If minikube isn't running, run `minikube start --wait=all`. If `kubeclaw-live`
is empty, the global setup will install it on first vitest invocation.

Now run only the new test file (skipping the rest of the suite to keep the
iteration loop short):

```bash
npx vitest run e2e/minikube-live-researcher.test.ts --config vitest.minikube-live.config.ts --retry 0 2>&1 | tail -40
```

Expected outcomes (in order of likelihood):

1. **Pass** — `Test Files 1 passed (1) | Tests 1 passed (1)`. Move on.
2. **Skipped because provider probe failed** — `[minikube-live-researcher]
   LLM provider unavailable: …`. Check `.env.test.local` is intact and
   OpenRouter is reachable; do not edit the test.
3. **Failure on the primary assertion (no "1879")** — Inspect the captured
   `researcherLine` in the error message. If the model fetched the page but
   didn't quote the year, the secondary log assertion will tell you whether
   `web_fetch` ran. Possible follow-ups:
   - Tighten the prompt: append "Quote the year as a four-digit number."
   - Swap `EXPECTED_FACT` to `'Albert Einstein'` as the backstop (still
     proves the LLM saw the page, weaker than a fact).
4. **Failure on the secondary assertion (no `web_fetch` in logs)** — The
   specialist didn't invoke the tool. Possible follow-ups:
   - Confirm the Researcher specialist is actually registered: `kubectl
     exec -n kubeclaw-live deploy/kubeclaw-orchestrator -- cat
     /etc/kubeclaw/specialists/specialists.json | head -20`
   - If `specialists.json` is empty, the spec's pre-flight finding was
     wrong; add a `--set-json specialists=…` to `minikube-live-setup.ts`
     and re-run global setup. Document the change in the commit.
5. **Failure on SSE timeout** — Check `kubectl get pods -n kubeclaw-live`
   for stuck browser tool pods (`kubectl describe pod <name>` to see why).
   Usual culprits: image pull, NetworkPolicy blocking egress (unlikely
   given the pre-flight finding), or OpenRouter being slow under load.

Do **not** mark Step 4 complete until the test passes against a real
minikube cluster.

- [ ] **Step 5: Commit**

```bash
git add e2e/minikube-live-researcher.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): minikube-live coverage for @Researcher specialist round-trip

First end-to-end test of the @mention specialist dispatch path against a
real helm-installed cluster + real LLM. Sends `@Researcher Read <wiki url>
and tell me when Einstein was born`, asserts the SSE reply contains "1879"
(extremely stable substring on the article), and grep the orchestrator
log for a web_fetch tool_call so an LLM-pretraining false positive can't
silently pass the test.

Implements Approach A from
docs/superpowers/specs/2026-05-30-minikube-live-researcher-test-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: a single commit creating one new file.

---

## Done

The plan is complete when:

- `vitest.minikube-live.config.ts` auto-loads `.env.test.local`.
- `e2e/minikube-live-researcher.test.ts` exists, type-checks, and passes
  against a real minikube cluster running an OpenRouter-configured kubeclaw.
- Both commits are on the branch the worktree was created from.

No follow-up tasks; no test infrastructure beyond the one config edit.

## Open items deferred to follow-up work

- A second test exercising the `web_search` round-trip — requires Approach
  B from the spec (custom stub browser-tool image). Out of scope here.
- Per-specialist `llmProvider` override coverage. Out of scope.
- Specialist failure-UX with a real provider (mock-provider coverage already
  exists in `e2e/specialist-failure-ux.test.ts`).
