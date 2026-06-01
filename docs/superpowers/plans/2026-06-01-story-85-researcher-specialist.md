# Story 85: @Researcher specialist grounds reply in web-fetched content — retrospective plan

**Goal:** Verify the full `@Researcher` specialist round-trip (HTTP channel → @mention parser → specialist runner → tool-job pod → real `web_fetch` → real LLM → SSE delivery) passes end-to-end against a live minikube cluster.

**Architecture:** A user message containing `@Researcher Use web_fetch on <URL> and tell me <question>` is detected by the @mention parser in `src/channel-runner.ts`. The parser routes the message to the specialist runner which dispatches a `DirectLLMRunner` invocation filtered to the Researcher's declared tools (`web_fetch`, `web_search`). The LLM calls `web_fetch`, which runs in a `browser`-category tool-job pod inside the `kubeclaw-live` namespace. The orchestrator spawns the pod, the tool result is fed back to the LLM, and the grounded reply is delivered as an SSE message prefixed `[@Researcher]`. The Researcher specialist is registered by injecting `--set-json specialists=[Researcher]` at helm install time (chart default `specialists: []`).

**Tech Stack:** TypeScript, Vitest 4, real LLM via OpenRouter (`openai/gpt-4o-mini`, `.env.test.local`), minikube cluster, helm, `kubectl logs --since-time` for log assertions, Node fetch streaming SSE.

---

## File structure

| Path | Role |
|---|---|
| `e2e/minikube-live-researcher.test.ts` | The test file (1 describe block, 1 it block, 5 assertions) |
| `src/channel-runner.ts` | @mention parser — detects `@Researcher` prefix, routes to specialist runner |
| `src/specialists.ts` | Specialist catalog — defines Researcher with `tools: ["web_search","web_fetch"]` and `llmProvider: openrouter` |
| `src/runtime/direct-llm-runner.ts` | TOOLS registry + tool-pod dispatch — `web_fetch` maps to `browser` category |
| `helm/kubeclaw/values.yaml` | Chart default `specialists: []`; runtime override `--set-json specialists=[Researcher]` registers the specialist |
| `e2e/minikube-live-setup.ts` | Global test setup — helm install with Researcher override, port-forwards, readiness waits |

---

## Tasks

### Task 1 — Implementation surfaces (already merged in 09a4617)

The following surfaces were implemented prior to this story being filed:

- **`src/specialists.ts`**: `Researcher` specialist entry with `tools: ["web_search", "web_fetch"]`, `llmProvider: openrouter`, and a grounded-research system prompt.
- **`src/channel-runner.ts`**: @mention parser regex detects `@<SpecialistName>` at the start of a message, looks up the specialist in the merged ConfigMap catalog, and dispatches via the specialist runner. Reply is prefixed `[@${specialistName}]` in the SSE stream.
- **`src/runtime/direct-llm-runner.ts`**: `web_fetch` is registered as a `browser`-category tool. The `toolFilter` from the specialist config constrains which tools the LLM may call. The orchestrator logs `Tool pod job created` with `"category":"browser"` when the pod is spawned.
- **`helm/kubeclaw/values.yaml`**: `specialists: []` (default). The live test overrides this with `--set-json specialists=[Researcher]` in `minikube-live-setup.ts`.
- **`e2e/minikube-live-researcher.test.ts`**: New test file implementing the 5-assertion round-trip (POST /message → SSE `[@Researcher]` → `Maathai` fact → orchestrator log `Tool pod job created` + `"category":"browser"` → URL citation `wikipedia.org/wiki/Mottainai`).

### Task 2 — Verification (this story)

Run the existing test against the live cluster and confirm all assertions pass:

```bash
npm run test:minikube-live -- minikube-live-researcher
```

Expected result: **1 passed / 1 total** (1 describe block, 1 it block). Test duration ~17 s (tool-job pod startup + LLM round-trip).

Actual result: **1 passed / 1 total** — confirmed on 2026-06-01.
