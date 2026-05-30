# Minikube-live Researcher specialist test — design

**Status:** approved
**Date:** 2026-05-30
**Author:** brainstormed with the user via `superpowers:brainstorming`

## Problem

The `e2e/minikube-live-*.test.ts` suite has 15 files covering admin shell,
browser, capabilities, RAG, tasks, tool-pods, etc., but **zero coverage of
the specialist (`@mention`) dispatch path** end-to-end against a real cluster
and real LLM. The specialist subsystem is a major user-facing feature: a user
addresses `@Researcher` (or any registered specialist) and the orchestrator
spawns a tool-capable agent run with that specialist's prompt and tool
filter. Today's regression net catches none of this against a live cluster.

## Goal

Add **one** new minikube-live test that exercises the full chain:

```
HTTP channel → @mention parser → specialist runner →
  tool-job pod → real web_fetch (Wikipedia) →
  LLM grounding (OpenRouter / gemma-4-31b-it:free) →
  SSE delivery → conversation_history
```

A passing test proves every link in that chain is wired up against a real
helm-installed kubeclaw.

## Non-goals

- Coverage of `web_search` round-trip. (Skipped in this test by giving the
  URL directly in the prompt — `web_search` already has dedicated coverage in
  `src/runtime/direct-llm-runner.integration.test.ts`. A separate test for
  the `web_search` path can come later.)
- Coverage of other specialists (only Researcher).
- Coverage of multi-turn specialist conversations.
- Testing model quality / answer accuracy beyond a single substring check.

## Architecture

### File

New: `e2e/minikube-live-researcher.test.ts` (~80-120 lines).

Picked up automatically by `vitest.minikube-live.config.ts`'s
`include: ['e2e/minikube-live*.test.ts']`.

### Setup it reuses

From the existing `e2e/minikube-live-setup.ts` global setup:

- helm-installed kubeclaw in the `kubeclaw-live` namespace
- port-forwards: channel HTTP on `KUBECLAW_LIVE_HTTP_LOCAL_PORT=14081`,
  Redis on `KUBECLAW_LIVE_REDIS_LOCAL_PORT=16381`
- credentials: `KUBECLAW_LIVE_USER='alice'`, `KUBECLAW_LIVE_PASS='livepass'`
- `providerAvailable` module-level flag set by the suite's OpenRouter probe
- LLM provider config via `LIVE_LLM_BASE_URL`, `LIVE_LLM_API_KEY`,
  `LIVE_LLM_MODEL` env vars (passed into the helm install)

### Two infrastructure preconditions (changes outside the test file)

1. **`.env.test.local` auto-loader for the minikube-live config.** Mirror
   the loader already present in `vitest.live-llm.config.ts` into
   `vitest.minikube-live.config.ts` so the OpenRouter key (already stored
   in `.env.test.local`, gitignored via `.env*.local`) reaches the suite
   without manual `source`-ing.

2. **Researcher specialist visible in the live install.** The default
   `helm/kubeclaw/values.yaml:447-465` defines Researcher with prompt +
   `web_search` / `web_fetch` tools + `llmProvider: openrouter`. If
   `minikube-live-setup.ts` overrides `specialists` to an empty list (to be
   verified at plan time), add a `--set-json specialists=[…Researcher…]` to
   the helm invocation.

### Test scenario

```ts
describe.skipIf(!providerAvailable)(
  'Researcher specialist grounds reply in fetched URL (minikube-live)',
  () => {
    it(
      '@Researcher reads a Wikipedia URL and answers from its content',
      async () => {
        // 1. Open SSE stream as alice on KUBECLAW_LIVE_HTTP_LOCAL_PORT.
        // 2. POST /message:
        //    "@Researcher Read https://en.wikipedia.org/wiki/Albert_Einstein
        //     and tell me when Einstein was born."
        // 3. Wait <=90 s for an SSE frame whose text starts with [@Researcher].
        // 4. Assert reply contains "1879".
        // 5. Poll orchestrator logs for a tool_call line referencing
        //    web_fetch + the Einstein URL.
      },
      120_000,
    );
  },
);
```

### Why the URL-in-prompt shape

Researcher's default prompt instructs "search for relevant, current
information using available search tools" — by default it would call
`web_search` first. Giving the URL directly in the user message lets the
specialist skip straight to `web_fetch`, removing the need to stub
`web_search` infrastructure. This is the deliberate "Approach A" chosen
during brainstorming over two alternatives (custom stub browser-tool image,
host-side stub HTTP server) because it adds zero new infrastructure while
exercising every link in the chain that matters for this test's goal.

### Why "1879"

`1879` (Einstein's birth year) appears 12+ times on the
[Wikipedia article](https://en.wikipedia.org/wiki/Albert_Einstein) — infobox,
lead paragraph, "Early life" section, etc. An article rewrite drastic enough
to lose all of them is implausible. Backup substring if the assertion ever
flakes: `Albert Einstein` (article's own subject name — guaranteed present).

### Why the secondary tool-call log assertion

`1879` is a famous fact in the LLM's pretraining data, so the model could
"answer correctly" without ever calling `web_fetch` — a false positive.
Polling orchestrator logs for a `tool_call` line referencing `web_fetch`
plus the Einstein URL proves the tool actually fired. Implementation: shell
out to `kubectl logs deploy/kubeclaw-orchestrator -n kubeclaw-live --since=120s`
and grep for `web_fetch` + `wikipedia.org/wiki/Albert_Einstein`.

## Failure modes & how they are handled

| Failure | Handling |
|---|---|
| OpenRouter unreachable or 429 | `describe.skipIf(!providerAvailable)` — inherits the suite's existing probe. Suite logs a skip banner instead of failing. |
| Wikipedia content drift | `1879` is extraordinarily stable. Backstop: swap to `Albert Einstein`. |
| LLM skips tool call (answers from pretraining) | Secondary assertion: tool_call log line must exist. Without it, the test fails with a clear "specialist did not invoke web_fetch" error. |
| Browser tool pod fails to start (ImagePullBackOff / OOM) | Test fails with `kubectl get pods` output included. No silent retry. |
| Egress NetworkPolicy blocks `*.wikipedia.org:443` | Verified during plan-writing via `helm/kubeclaw/templates/networkpolicies.yaml`. Fallback: add explicit egress allowlist via helm override in the live setup. |
| SSE drops mid-stream | 90 s wait + EventSource auto-reconnect (same pattern as `orchestrator-restart-resilience.test.ts`). |

## Retry policy

`retry: 0` for this test. Live LLM + real network: retries hide real flakes
rather than fix them. The only "expected" flake (provider down) is handled
by `skipIf`, not by retry.

## Timeouts

- vitest `testTimeout`: 120_000 ms (the existing minikube-live suite default)
- internal SSE-wait window: 90_000 ms
- log-grep poll interval: 2_000 ms, deadline 30 s after SSE reply arrives

## Cost

One OpenRouter call against `google/gemma-4-31b-it:free` (free tier, no
charge). One Wikipedia GET (zero cost).

## Coverage gained

First end-to-end exercise, against a real helm-installed cluster and a real
LLM, of:

- `@mention` parsing in the HTTP channel
- specialist dispatch (`channel-runner.ts:2623-2688`)
- specialist's `[@Name]` reply prefix wrapping (`channel-runner.ts:2733`)
- tool-job pod spawn for the `browser` category
- `web_fetch` tool execution path through the tool pod
- LLM grounding on returned tool output
- SSE delivery of a specialist reply
- conversation_history persistence of a specialist reply

## Out of scope (deferred)

- A second test exercising `web_search` round-trip (requires Approach B's
  custom stub browser-tool image — separate spec).
- Multi-specialist mention in one message.
- Specialist failure-UX with a real provider (covered by
  `e2e/specialist-failure-ux.test.ts` with a mock provider already).
- Per-specialist `llmProvider` override testing (out of scope; this test
  uses whatever provider the chart picks up).

## Open questions resolved during brainstorming

| Question | Decision |
|---|---|
| Test in live-llm suite or minikube-live suite? | minikube-live (user wants in-cluster behaviour) |
| Real web tools or stubbed? | Hybrid — real `web_fetch`, `web_search` skipped via URL-in-prompt |
| Assertion strength? | Reply contains a known fact (`1879`) + tool actually invoked |
| Which specialist? | Researcher (only one in the default chart) |

## Implementation plan reference

Implementation plan will be written into
`docs/superpowers/plans/2026-05-30-minikube-live-researcher-test-plan.md`
by the `superpowers:writing-plans` skill after the user reviews and approves
this spec.
