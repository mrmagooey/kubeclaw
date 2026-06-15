# places_search → Catalog Tool Conversion — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Builds on:** the agent-runner catalog unification (shipped 2026-06-15) and the web-tools catalog conversion (`web_search` is the direct model for this work)

## Problem

`places_search` (Google Places search) is the last built-in tool that is NOT a
catalog tool, and the last thing keeping a pile of category-pod machinery alive.

Two facts established by investigation:

1. **`places_search` already runs in-process.** `channel-runner.ts`
   (`registerPlacesSearchTool`) registers it as a `DirectLLMRunner` `LocalTool`;
   calls execute `placesSearchHandler` (`src/runtime/places-search.ts`) directly in
   the channel pod. It never reaches a tool pod.
2. **The `'places'` tool-pod path is dead code.** `executeToolLocal`
   (`container/agent-runner/src/tool-server.ts`) has no `placesSearch` case, the
   `'places'` pod is given no Google credentials, and the in-process `LocalTool`
   short-circuits before `executeToolViaK8s`. `'places'` is the only remaining
   member of `BUILTIN_CATEGORIES`.

So converting `places_search` to a catalog tool both (a) finishes the "no per-tool
built-ins" goal and (b) empties `BUILTIN_CATEGORIES`, which lets the entire
category-pod path (`createToolPodJob`, `ToolPodJobSpec`, the builtin spawn branch,
and `executeToolLocal`) be deleted.

## Goal

`places_search` becomes a stock-image catalog `file`-bridge tool hitting Google's
`searchText` endpoint, returning raw JSON, with broker-injected credentials —
modeled exactly on the shipped `web_search` tool. The in-process handler and all
now-dead category-pod machinery are removed.

## Non-goals

- Preserving the current smart query→Google-types mapping and compact response
  reshaping. We deliberately switch to raw `searchText` JSON the LLM interprets
  (the `web_search` precedent). This is an accepted behavior change (see §5).
- Per-group Google key provisioning UX (the `google-places` broker entry already
  exists with `allowOperatorFallback: false`; provisioning a key is operational).
- Any change to the channel↔orchestrator catalog spawn path itself (it already
  carries `places_search` once it is a catalog tool).

## Confirmed current-state facts

| Fact | Location |
| --- | --- |
| `places_search` is an in-process `LocalTool` (`placesSearchHandler` + `PLACES_SEARCH_TOOL_DEF`) | `src/runtime/places-search.ts`; registered `src/channel-runner.ts` (`registerPlacesSearchTool`, called once in `main()`) |
| Static tool def + `TOOL_CATEGORY: {places_search:'places'}` + `TOOL_SERVER_NAME: {places_search:'placesSearch'}` | `src/runtime/direct-llm-runner.ts` (TOOLS ~343-372; maps ~387-394) |
| `BUILTIN_CATEGORIES = new Set(['places'])` — only `'places'` left | `src/k8s/ipc-redis.ts:279` |
| Builtin spawn branch → `createToolPodJob({category:'places'})` | `src/k8s/ipc-redis.ts` spawn-watcher (~1002-1017) |
| `createToolPodJob` callers: the spawn-watcher builtin branch + the `executeToolViaK8s` builtin else-block | `src/k8s/job-runner.ts` (`createToolPodJob` ~1604); `src/runtime/direct-llm-runner.ts` (~491-497) |
| `executeToolLocal` only has `task`/`taskOutput`/`taskStop` cases | `container/agent-runner/src/tool-server.ts` |
| `RESERVED_NAMES = new Set(['places_search','execution','places'])` | `src/tools/types.ts:72` |
| **`google-places` broker entry already exists** | `helm/kubeclaw/values.yaml` (~434-446): host `places.googleapis.com`, `credentialFields:[{name:api_key, envVar:GOOGLE_PLACES_API_KEY}]`, `baseUrlEnvs:{GOOGLE_PLACES_BASE_URL:"http://places.googleapis.com"}`, `allowOperatorFallback:false`, `allowedPositions:[header]`, `apiKeyShape:{prefix:"AIza",minLength:39}` |
| `web_search` is the model: `image: curlimages/curl:latest`, `pattern: file`, `mount: none`, `credentials:[brave-search]`, `run:` a curl that references the broker-injected env var | `helm/kubeclaw/values.yaml` (~534-545) |

## Design

### 1. New catalog tool (`helm/kubeclaw/values.yaml` `tools:`)

```yaml
- name: places_search
  description: >-
    Search for local places (restaurants, cafés, shops, attractions) by free-text
    query via the Google Places API. Include the location in the query text, e.g.
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
    sh -c 'q=$(sed -e ":a" -e "N" -e "$!ba" -e "s/\\\\/\\\\\\\\/g" -e "s/\"/\\\\\"/g" -e "s/\n/ /g" "$INPUT_DIR/query");
    curl -sS -X POST
    -H "Content-Type: application/json"
    -H "X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY"
    -H "X-Goog-FieldMask: places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.types,places.regularOpeningHours.openNow,places.userRatingCount"
    --data "{\"textQuery\":\"$q\"}"
    "$GOOGLE_PLACES_BASE_URL/v1/places:searchText"'
```

Notes (the implementer must verify the exact escaping against the `file`-bridge
contract and a real run):
- Single param `query` — matches `web_search`'s single-`query` shape. `searchText`
  accepts free text, so no lat/lng parsing or keyword→types mapping is needed.
- The `run` JSON-escapes the query (backslash, double-quote) and flattens newlines
  before embedding it in the `{"textQuery": "..."}` body, using only busybox tools
  present on `curlimages/curl` (`sh`, `sed`). The implementer should pick the
  simplest escaping that is correct and verify it (a small wrapper or `awk` is fine
  if `sed` proves awkward); the contract is: arbitrary query text must produce valid
  JSON.
- Hits `$GOOGLE_PLACES_BASE_URL` (the broker `baseUrlEnvs` value
  `http://places.googleapis.com`; the broker upgrades to HTTPS at egress), not a
  hardcoded URL.
- `X-Goog-FieldMask` is required by `searchText`; the listed fields mirror what the
  old in-process handler extracted.

### 2. Credentials

`credentials: [google-places]` is all that is needed — the broker entry already
exists. The orchestrator's `buildCatalogEnvs` stamps `GOOGLE_PLACES_API_KEY` (a
`KC_PH_…` placeholder) and `GOOGLE_PLACES_BASE_URL` on the tool pod; Envoy
substitutes the real key into the `X-Goog-Api-Key` header for `places.googleapis.com`
at egress. `allowOperatorFallback: false` → a group without a registered Google key
gets the fail-closed placeholder and the call fails cleanly (operational
prerequisite, documented; not a code task).

### 3. Remove the in-process tool

- Delete `placesSearchHandler` and `PLACES_SEARCH_TOOL_DEF` (and the whole
  `src/runtime/places-search.ts` if nothing else imports it — verify), plus its
  tests `src/runtime/places-search.test.ts` and `places-search.integration.test.ts`.
- Delete `registerPlacesSearchTool` and its call site in `src/channel-runner.ts`.
- Remove the `places_search` entry from `DirectLLMRunner`'s static `TOOLS`, and the
  `TOOL_CATEGORY` / `TOOL_SERVER_NAME` maps (both become empty → simplify
  `executeToolViaK8s` accordingly: `category = toolName`, `serverToolName = toolName`).
- **Remove `'places_search'` from `RESERVED_NAMES`** (`src/tools/types.ts`).
  Mandatory: otherwise the new catalog tool named `places_search` fails
  `parseToolCatalog`. (The `baseline-parse` regression test will catch a miss.)
  Leave `'execution'`/`'places'` reserved or drop them — they are now vestigial
  category names; dropping `'places'` is fine since it is no longer a category.

### 4. Dead-code removal (each gated on a grep proving no remaining caller)

- `BUILTIN_CATEGORIES` becomes empty → delete it and the `if (BUILTIN_CATEGORIES.has(category))`
  builtin branch in the `ipc-redis.ts` spawn-watcher (every spawn is now catalog-by-name).
- After removing the two `createToolPodJob` call sites (spawn-watcher builtin branch
  and the `executeToolViaK8s` builtin else-block), delete `createToolPodJob`
  (`src/k8s/job-runner.ts`) and `ToolPodJobSpec` (`src/k8s/types.ts`).
- `executeToolViaK8s` STAYS (catalog tools use it) but loses its builtin else-block.
- `executeToolLocal` + `toolTask` (`tool-server.ts`): gated — confirm `task`/
  `taskOutput`/`taskStop` are not exposed to any LLM or dispatched by any live path;
  if dead, delete them and turn the tool-server's no-bridge fallback into an explicit
  error (every tool pod now runs a bridge mode). If a live `task` path is found,
  STOP and report rather than deleting.

### 5. Behavior change (explicit)

The smart query→types mapping and the compact reshaped result array are gone; the
tool now returns raw Google `searchText` JSON (verbose, but richer — includes
priceLevel/openNow/types/userRatingCount the LLM can filter on). This mirrors
`web_search` returning raw Brave JSON. Update the `RECOMMENDATION_CONTRACT` prompt
text in `direct-llm-runner.ts` that references `places_search` so it no longer
promises the old compact shape.

## Data flow (after conversion — identical to web_search)

```
LLM calls places_search(query) →
  DirectLLMRunner resolves it as a catalog tool (no longer a LocalTool) →
  executeToolViaK8s → XADD kubeclaw:spawn-tool-pod {category: 'places_search', ...} →
  orchestrator resolveTool('places_search') + ACL → createSidecarToolPodJob (curlimages/curl, file-bridge) →
  tool pod runs `run` curl to $GOOGLE_PLACES_BASE_URL/v1/places:searchText
    (Envoy injects X-Goog-Api-Key at egress) →
  raw JSON → kubeclaw:toolresults → LLM
```

## Testing (all three levels)

**Unit**
- `baseline-parse.test.ts` (the existing rendered-baseline guard) still passes with
  the new `places_search` tool present and `'places_search'` removed from
  `RESERVED_NAMES` (i.e. the rendered catalog parses and includes `places_search`).
- `DirectLLMRunner` no longer registers `places_search` as a `LocalTool` and it is
  absent from the static `TOOLS` array; `TOOL_CATEGORY`/`TOOL_SERVER_NAME` no longer
  reference it.
- Deletion regressions: `BUILTIN_CATEGORIES` is gone/empty; no live caller of
  `createToolPodJob`; `validateTool` accepts a tool named `places_search`.

**Integration**
- `places_search` resolves from the catalog and produces a sidecar tool-pod manifest
  carrying the `google-places` credential placeholder env (`GOOGLE_PLACES_API_KEY`,
  `GOOGLE_PLACES_BASE_URL`) — reuse the existing catalog-credential manifest tests
  (the pattern `web_search`/`brave-search` already has).
- The removed builtin/`tool_pod` path has no consumer (regression guard).

**E2E** (minikube-live, opt-in suite)
- `places_search` runs through the file-bridge sidecar end-to-end against a **mocked**
  Google `searchText` endpoint (or skips cleanly when no key/egress), asserting the
  raw JSON round-trips. Mirror the existing sidecar/web-tool e2e harness; do not
  require a real Google key in CI.

## Risks

- **Query JSON-escaping in shell.** The `run` command must produce valid JSON for
  arbitrary query text. Mitigation: keep escaping minimal but correct (backslash +
  double-quote + newline), stay on the stock `curlimages/curl` busybox tools, and
  verify with a query containing quotes. If shell escaping proves fragile, an
  acceptable fallback is a tiny `printf`/`awk` constructor — still stock image, no
  per-tool image.
- **`executeToolLocal`/`task` deletion.** Gated on a grep proof; if `task` is wired
  somewhere unexpected, leave it and report (the rest of the cleanup still stands).
- **Operator prerequisite.** With `allowOperatorFallback:false`, environments without
  a registered Google Places key will see `places_search` fail closed. Documented;
  not a code change.
