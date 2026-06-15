# places_search Catalog Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `places_search` from an in-process built-in into a stock-image catalog `file`-bridge tool (Google `searchText`, raw JSON, broker-injected credentials), then delete the now-empty category-pod machinery.

**Architecture:** `places_search` joins `web_search`/`web_fetch`/`bash` as a `file`-pattern catalog tool on `curlimages/curl`. Its `credentials: [google-places]` reuses the broker entry that already exists in `values.yaml`. Removing it from the in-process/`'places'`-category path empties `BUILTIN_CATEGORIES`, which lets `createToolPodJob`/`ToolPodJobSpec`/`executeToolLocal` be deleted.

**Tech Stack:** Helm values (tool catalog), TypeScript (ES2022/NodeNext), Redis-stream tool dispatch, Google Places API (searchText), vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-places-search-catalog-conversion-design.md`

---

## Key facts for the implementer

- **Two packages** (same as prior work): main app `src/**` (root `package.json`/`node_modules`); agent-runner `container/agent-runner/**` (own `node_modules`). Run all tests from repo root: `npx vitest run [file]`. Both `tsc`: `npx tsc --noEmit` and `cd container/agent-runner && npx tsc --noEmit && cd ../..`.
- **Node 24 on PATH before `git commit`** (husky/prettier): `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"`. Use explicit `git add <paths>` (never `git add -A` — avoids staging worktree artifacts like `node_modules` symlinks).
- **`web_search` is the model** (`helm/kubeclaw/values.yaml`, ~lines 534-545): `image: curlimages/curl:latest`, `pattern: file`, `mount: none`, `credentials:[brave-search]`, a `run` curl that references the broker-injected env var.
- **The `google-places` broker entry already exists** (`values.yaml` ~434-446): host `places.googleapis.com`, `credentialFields:[{name:api_key, envVar:GOOGLE_PLACES_API_KEY}]`, `baseUrlEnvs:{GOOGLE_PLACES_BASE_URL:"http://places.googleapis.com"}`, `allowOperatorFallback:false`, `allowedPositions:[header]`. So the tool's `run` should POST to `$GOOGLE_PLACES_BASE_URL/v1/places:searchText` and send `X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY` (Envoy substitutes the real key at egress).
- **`file`-bridge contract:** the bridge writes each declared parameter to `$INPUT_DIR/<paramName>` and runs the tool's `run` string in a shell with `$INPUT_DIR` set (see `web_search` reading `$(cat "$INPUT_DIR/query")`). `curlimages/curl` is Alpine/busybox — `sh`, `sed`, `tr`, `printf` are available; `jq` is NOT.
- **The rendered-baseline regression test** `src/tools/baseline-parse.test.ts` feeds the real `values.yaml` `tools:` through `parseToolCatalog`; it will fail if `places_search` stays in `RESERVED_NAMES` while present in the catalog. Use it as a guard.

## File structure

| File | Change | Task |
| --- | --- | --- |
| `helm/kubeclaw/values.yaml` | Add `places_search` catalog tool | 1 |
| `src/tools/types.ts` | Remove `'places_search'` from `RESERVED_NAMES` | 1 |
| `src/tools/baseline-parse.test.ts` | Assert `places_search` parses & is present | 1 |
| `src/runtime/direct-llm-runner.ts` | Remove `places_search` from `TOOLS`, `TOOL_CATEGORY`, `TOOL_SERVER_NAME`; simplify | 1 |
| `src/channel-runner.ts` | Delete `registerPlacesSearchTool` + its call | 1 |
| `src/runtime/places-search.ts` (+ 2 tests) | Delete (after grep proves no other importer) | 1 |
| `src/runtime/direct-llm-runner.test.ts` | Update assertions referencing in-process `places_search` | 1 |
| `src/k8s/ipc-redis.ts` | Delete `BUILTIN_CATEGORIES` + builtin spawn branch | 2 |
| `src/k8s/job-runner.ts` | Delete `createToolPodJob` | 2 |
| `src/k8s/types.ts` | Delete `ToolPodJobSpec` | 2 |
| `src/runtime/direct-llm-runner.ts` | Delete the builtin else-block in `executeToolViaK8s` | 2 |
| `container/agent-runner/src/tool-server.ts` | Delete `executeToolLocal`/`toolTask` (gated); fix no-bridge fallback | 2 |
| `src/k8s/ipc-redis.test.ts`, `src/k8s/job-runner.test.ts` | Update/remove tests for deleted machinery | 2 |
| `src/runtime/direct-llm-runner.ts` (RECOMMENDATION_CONTRACT) | Update places_search prompt text | 3 |
| `e2e/minikube-live-places-search.test.ts` (new) | E2E via file-bridge against mocked Google | 4 |

---

## Task 1: Convert places_search to a catalog tool (add + remove in one coherent change)

**Why one task:** adding the catalog entry while the in-process tool still exists would expose `places_search` to the LLM twice (static TOOLS + catalog). Add-and-remove together so every commit is coherent.

**Files:** as in the table (Task 1 rows).

- [ ] **Step 1: Confirm nothing else imports the places-search module**

Run: `grep -rn "places-search\|placesSearchHandler\|PLACES_SEARCH_TOOL_DEF\|PlacesResultSchema" src --include=*.ts | grep -v -E "places-search\.(test|integration\.test)\.ts|/places-search\.ts:"`
Expected: matches only in `src/channel-runner.ts` (the registration) and `src/runtime/direct-llm-runner.ts` (if any). If anything ELSE imports it, note it and adapt (don't delete the file in Step 9; just remove the handler usages). Record the output.

- [ ] **Step 2: Write/extend the baseline-parse assertion (failing)**

In `src/tools/baseline-parse.test.ts`, add to the existing `it('parses cleanly via parseToolCatalog', ...)` (after the existing `toContain('browser')`/`toContain('bash')` asserts):

```typescript
    expect(names).toContain('places_search');
```

Run: `npx vitest run src/tools/baseline-parse.test.ts`
Expected: FAIL — `places_search` is not yet in the catalog (and, once added but still reserved, the parse would fail). This guards both halves of the change.

- [ ] **Step 3: Remove `'places_search'` from RESERVED_NAMES**

In `src/tools/types.ts` (~line 72):

```typescript
const RESERVED_NAMES = new Set(['places_search', 'execution', 'places']);
```
becomes:
```typescript
// 'places_search' is now itself a catalog tool, so it must not be reserved.
// 'execution'/'places' are retired spawn categories kept reserved defensively.
const RESERVED_NAMES = new Set(['execution', 'places']);
```

- [ ] **Step 4: Add the `places_search` catalog tool to `values.yaml`**

In `helm/kubeclaw/values.yaml`, under the top-level `tools:` list (alongside `web_search`), add:

```yaml
  - name: places_search
    description: >-
      Search for local places (restaurants, cafés, shops, attractions) by free-text
      query via the Google Places API. Put the location in the query text, e.g.
      "ramen in Melbourne CBD". Returns the raw Google Places searchText JSON.
    parameters:
      type: object
      properties:
        query: { type: string }
      required: [query]
    image: curlimages/curl:latest
    pattern: file
    mount: none
    credentials: [google-places]
    run: >-
      q=$(tr -d '\n\r' < "$INPUT_DIR/query" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g');
      curl -sS -X POST
      -H "Content-Type: application/json"
      -H "X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY"
      -H "X-Goog-FieldMask: places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.types,places.regularOpeningHours.openNow,places.userRatingCount"
      --data "{\"textQuery\":\"$q\"}"
      "$GOOGLE_PLACES_BASE_URL/v1/places:searchText"
```

NOTE: the exact YAML/shell escaping is the riskiest part — Step 5 verifies it. Adjust the `run` scalar until Step 5 passes. The contract: arbitrary `query` text → a valid JSON body `{"textQuery":"…"}`. (Realistic queries have no quotes/backslashes, but the `sed` escaping defends against them; `tr` flattens newlines.)

- [ ] **Step 5: Verify the run-command escaping locally (no cluster needed)**

The `run` string's shell logic must produce valid JSON for a tricky query. Verify it directly with `sh` + `node`:

```bash
mkdir -p /tmp/kc-places && printf 'a "quoted" \\ backslash query\nsecond line' > /tmp/kc-places/query
INPUT_DIR=/tmp/kc-places sh -c 'q=$(tr -d "\n\r" < "$INPUT_DIR/query" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/\"/\\\\\"/g"); printf "%s" "{\"textQuery\":\"$q\"}"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s);console.log("VALID JSON:",s)})'
```
Expected: prints `VALID JSON: {"textQuery":"a \"quoted\" \\ backslash query second line"}` (no `JSON.parse` throw).
If it throws, fix the escaping in the `run` scalar AND in this verification until both match and JSON is valid. The YAML `run:` scalar and the `sh -c '…'` you verify must use the same shell logic (mind one extra layer of escaping the YAML block scalar removes — verify by extracting the rendered value: `helm template helm/kubeclaw | grep -A1 'places:searchText'` is noisy, so instead trust the YAML `>-` folded scalar reproduces the multi-line `run` as a single line; confirm with a quick `node -e` that reads the rendered ConfigMap if unsure).

- [ ] **Step 6: Run the baseline-parse test (passing)**

Run: `npx vitest run src/tools/baseline-parse.test.ts`
Expected: PASS — the rendered catalog now parses and includes `places_search`.

- [ ] **Step 7: Remove `places_search` from DirectLLMRunner's static TOOLS + maps**

In `src/runtime/direct-llm-runner.ts`:
- Delete the `places_search` object from the static `TOOLS` array (~343-372).
- `TOOL_SERVER_NAME` (~387-389) and `TOOL_CATEGORY` (~392-394) become empty. Either delete them and inline their uses in `executeToolViaK8s`, or set them to `{}`. Preferred: delete both maps and simplify `executeToolViaK8s`:
  - `const isCustomTool = !TOOL_CATEGORY[toolName];` → since there are no builtin categories anymore, every tool is a catalog tool. Replace with `const category = toolName;` and `const serverToolName = toolName;` and drop `isCustomTool` (see Task 2 for the matching else-block removal — if doing Task 1 alone leaves a reference, keep `TOOL_CATEGORY = {}` minimally so it compiles, and Task 2 finishes the simplification). Keep the file compiling and tests green at the end of this task.
- Also remove the `toolCategoryForTest`/`TOOL_SERVER_NAME` test-export hooks (~1540-1541) if they reference the deleted maps, and update the corresponding test (Step 11).

- [ ] **Step 8: Delete the in-process registration**

In `src/channel-runner.ts`: delete `registerPlacesSearchTool` (~3240-3248) and its call site (~3304), plus the import of `placesSearchHandler`/`PLACES_SEARCH_TOOL_DEF`.

- [ ] **Step 9: Delete the places-search module + its tests**

If Step 1 proved no other importer: delete `src/runtime/places-search.ts`, `src/runtime/places-search.test.ts`, `src/runtime/places-search.integration.test.ts`. (If Step 1 found another importer, instead remove only the now-unused exports and report.)

- [ ] **Step 10: Grep for stragglers**

Run: `grep -rn "places_search\|placesSearch\|PLACES_SEARCH" src --include=*.ts | grep -v -E "RECOMMENDATION_CONTRACT|baseline-parse"`
Resolve every remaining non-prompt reference (a leftover in a test, a comment, the `TOOL_*` maps). The RECOMMENDATION_CONTRACT text is updated in Task 3 — leave it.

- [ ] **Step 11: Update DirectLLMRunner tests**

Read `src/runtime/direct-llm-runner.test.ts` and `src/runtime/direct-llm-runner.integration.test.ts`. Remove/adjust any assertion that `places_search` is in `TOOLS`, is a `LocalTool`, or routes to category `'places'` / server name `'placesSearch'`. If a test asserted `toolCategoryForTest('places_search') === 'places'`, delete it. Keep the suite meaningful.

- [ ] **Step 12: Full suite + typechecks**

Run:
```bash
npx vitest run
npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit && cd ../..
helm template helm/kubeclaw >/dev/null && echo HELM_OK
```
Expected: all green / HELM_OK.

- [ ] **Step 13: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add helm/kubeclaw/values.yaml src/tools/types.ts src/tools/baseline-parse.test.ts src/runtime/direct-llm-runner.ts src/runtime/direct-llm-runner.test.ts src/runtime/direct-llm-runner.integration.test.ts src/channel-runner.ts
git rm src/runtime/places-search.ts src/runtime/places-search.test.ts src/runtime/places-search.integration.test.ts
git commit -m "feat(tools): convert places_search to a catalog tool (Google searchText)"
```
(Adjust `git rm` if Step 1/9 found another importer.)

---

## Task 2: Delete the now-dead category-pod machinery (gated)

**Why:** `BUILTIN_CATEGORIES` is now empty (only `'places'` was in it). Nothing spawns a builtin/category pod anymore — every tool is catalog-by-name.

**Files:** as in the table (Task 2 rows).

- [ ] **Step 1: GATE — prove no live caller of the builtin path / createToolPodJob**

Run:
```bash
grep -rn "createToolPodJob\|BUILTIN_CATEGORIES" src --include=*.ts | grep -v '\.test\.'
grep -rn "executeToolLocal\|toolTask\|'task'\|\"task\"\|taskOutput\|taskStop" container/agent-runner/src --include=*.ts | grep -v '\.test\.'
```
Expected for the first: `createToolPodJob` defined in `job-runner.ts`, referenced only in `ipc-redis.ts` (builtin spawn branch) and `direct-llm-runner.ts` (builtin else-block); `BUILTIN_CATEGORIES` only in `ipc-redis.ts`. For the second: confirm whether `task`/`taskOutput`/`taskStop` are dispatched anywhere live (a tool def exposed to an LLM, a category that reaches `executeToolLocal`). Record both outputs. If `createToolPodJob` has any OTHER caller, or `task` is wired to a live path, STOP and report — adjust scope accordingly.

- [ ] **Step 2: Failing test — builtin path is gone**

In `src/k8s/ipc-redis.test.ts`, add/adjust an assertion. If `BUILTIN_CATEGORIES` is exported, assert it's empty or removed; simplest robust form is a behavior assertion that an unknown category (e.g. `'places'`) on the spawn stream is treated as a catalog lookup (resolves via `resolveTool`, errors as unknown tool) rather than creating a pod. Reuse the existing spawn-watcher harness. Run it; expect FAIL while the builtin branch still exists.

- [ ] **Step 3: Remove the builtin spawn branch + `BUILTIN_CATEGORIES`**

In `src/k8s/ipc-redis.ts`: delete `BUILTIN_CATEGORIES` (~279) and the `if (BUILTIN_CATEGORIES.has(category)) { … createToolPodJob … } else { … }` structure in the spawn-watcher (~1002-1017) — keep only the catalog-resolve body (the former `else`), so every spawn resolves the tool by name. Remove now-unused imports.

- [ ] **Step 4: Remove the `executeToolViaK8s` builtin else-block**

In `src/runtime/direct-llm-runner.ts` `executeToolViaK8s` (~477-503): delete the `else { … createToolPodJob … }` branch so only the `createSidecarToolPodJob` path remains; finish the `category = toolName` / `serverToolName = toolName` simplification started in Task 1 (drop `isCustomTool`/`directSpec` plumbing that only existed to choose between sidecar and builtin pods — keep whatever the channel still needs for `resolveToolByName` in non-channel mode).

- [ ] **Step 5: Delete `createToolPodJob` + `ToolPodJobSpec`**

In `src/k8s/job-runner.ts`: delete the `createToolPodJob` method (~1604-1696). In `src/k8s/types.ts`: delete the `ToolPodJobSpec` interface. Fix any now-dangling imports/types surfaced by `tsc`.

- [ ] **Step 6: (Gated) Delete `executeToolLocal`/`toolTask` in tool-server**

Only if Step 1 proved `task`/`taskOutput`/`taskStop` unreachable: in `container/agent-runner/src/tool-server.ts`, delete `executeToolLocal` and `toolTask`, and change the dispatcher's no-bridge fallback (the `return executeToolLocal(...)` after the bridge-mode checks) into an explicit error, e.g. `throw new Error(\`No tool bridge mode set (KUBECLAW_TOOL_MODE missing); tool=${tool}\`)` — every tool pod now runs a bridge mode. If Step 1 found a live `task` path, SKIP this step and report.

- [ ] **Step 7: Update/remove tests for deleted machinery**

Update `src/k8s/job-runner.test.ts` (remove `createToolPodJob` tests) and `src/k8s/ipc-redis.test.ts` (the builtin-branch tests). Remove `container/agent-runner/src/*` tests that exercised `executeToolLocal`/`toolTask` if those were deleted. Keep coverage of the surviving sidecar/catalog path.

- [ ] **Step 8: Full suite + typechecks + helm**

```bash
npx vitest run
npx tsc --noEmit
cd container/agent-runner && npx tsc --noEmit && cd ../..
helm template helm/kubeclaw >/dev/null && echo HELM_OK
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/k8s/ipc-redis.ts src/k8s/ipc-redis.test.ts src/k8s/job-runner.ts src/k8s/job-runner.test.ts src/k8s/types.ts src/runtime/direct-llm-runner.ts container/agent-runner/src/tool-server.ts
# add any agent-runner test files you changed
git commit -m "refactor: delete dead category-pod machinery (BUILTIN_CATEGORIES/createToolPodJob)"
```

---

## Task 3: Update the places_search prompt text

**Files:** `src/runtime/direct-llm-runner.ts` (the `RECOMMENDATION_CONTRACT` / system-prompt text referencing `places_search`, ~lines 79-89).

- [ ] **Step 1: Read the current contract text**

Read the `RECOMMENDATION_CONTRACT` (or equivalent) block in `src/runtime/direct-llm-runner.ts` that mentions `places_search` and its old compact result shape.

- [ ] **Step 2: Update the wording**

Reword so it no longer promises the old compact `{name,address,rating,...}` array; instead state that `places_search` returns raw Google Places `searchText` JSON which the assistant should read and summarize. Keep the surrounding recommendation guidance intact. (No test asserts this text verbatim — confirm with `grep -rn "places_search" src --include=*.test.ts`; if a test does assert it, update that test.)

- [ ] **Step 3: Suite + commit**

```bash
npx vitest run
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/runtime/direct-llm-runner.ts
git commit -m "docs(prompt): places_search now returns raw Google searchText JSON"
```

---

## Task 4: End-to-end test

**Files:** `e2e/minikube-live-places-search.test.ts` (new).

- [ ] **Step 1: Study the sibling e2e + the new agent-catalog e2e**

Read `e2e/minikube-live-tool-pods.test.ts`, `e2e/minikube-live-agent-catalog.test.ts`, `vitest.minikube-live.config.ts`, and `e2e/minikube-live-setup.ts`. Note the `provisioned` gate, how a tool is invoked by NAME via `kubeclaw:spawn-tool-pod` + `kubeclaw:toolcalls`/`toolresults`, and how `web_search`-style external-API tools are exercised (mock vs real). Mirror exactly.

- [ ] **Step 2: Write the e2e**

Create `e2e/minikube-live-places-search.test.ts` following that harness. It must:
1. Use the standard `provisioned` gate (consistent with siblings — a missing cluster fails clearly, never silently passes).
2. Invoke `places_search` by name through the file-bridge sidecar path (write call to `kubeclaw:toolcalls:<id>:places_search`, XADD `kubeclaw:spawn-tool-pod` with `category: places_search`), and assert a result comes back on `kubeclaw:toolresults:<id>:places_search`.
3. Because a real Google key/egress isn't available in CI, point the tool at a **mocked** `searchText` endpoint OR assert graceful behavior without a key (mirror whatever the existing external-API e2e does — if there's no mock harness, assert the tool pod spawns and returns a structured error/empty result rather than requiring a live key; do not hardcode a real key). If the existing harness has no way to mock egress, write the test to assert the spawn + bridge round-trip with a deterministic stub image/endpoint, and document the limitation in a comment.

- [ ] **Step 3: Run (or confirm clean skip/gate) + tsc**

Run it via the minikube config the siblings use; expect PASS against a cluster, or the standard `provisioned`-gate failure when absent (an acceptable non-run in this environment). Run `npx tsc --noEmit` to ensure it compiles.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add e2e/minikube-live-places-search.test.ts
git commit -m "test(e2e): places_search via file-bridge sidecar"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run` → all green.
- [ ] `npx tsc --noEmit` and `cd container/agent-runner && npx tsc --noEmit && cd ../..` → clean.
- [ ] `helm template helm/kubeclaw >/dev/null && echo OK`.
- [ ] `grep -rn "createToolPodJob\|BUILTIN_CATEGORIES\|placesSearchHandler\|registerPlacesSearchTool" src container/agent-runner/src --include=*.ts | grep -v '\.test\.'` → no matches.
- [ ] The rendered baseline still parses with `places_search` present (`npx vitest run src/tools/baseline-parse.test.ts`).

## Self-review notes (author)

- **Spec coverage:** §1 catalog tool → Task 1 (Steps 3-6); §2 credentials → Task 1 (the `credentials:[google-places]` + run env refs; no code, broker entry pre-exists); §3 remove in-process → Task 1 (Steps 7-11); §4 dead-code → Task 2; §5 behavior/prompt → Task 3; testing §6 → Tasks 1-4. All sections mapped.
- **Type consistency:** `executeToolViaK8s` simplification is split across Task 1 (Step 7, keep-compiling) and Task 2 (Step 4, finish) — the plan flags that Task 1 must leave it compiling+green even if the full simplification lands in Task 2.
- **Gated deletions:** Task 2 Steps 1/6 require grep proof before removing `createToolPodJob` and `executeToolLocal`/`task`.
- **Escaping risk:** Task 1 Step 5 is a concrete, runnable verification of the `run` JSON-escaping (no cluster needed), so a bad escape fails locally rather than only in production.
