# Browser Tool → `cdp` Bridge Conversion — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-06-14
**Author:** Peter + Claude

## Problem & goal

`browser` is the last static in-process built-in tool. Today `toolAgentBrowser`
(`container/agent-runner/src/tool-server.ts`) shells out to the `agent-browser`
CLI (Playwright-backed, baked into the `kubeclaw-agent` image) with the entire
user instruction as a **single natural-language string**, one-shot per call —
stateless and architecturally inconsistent with agent-browser's real session
model. The goal: convert `browser` into a **catalog tool driven through a new
`cdp` bridge** against a **stock, operator-chosen chromium image**, with a
**stateful warm session** and a **primitive contract the channel LLM drives** —
no first-party image, no in-process tool logic.

This is the browser follow-on to the bash and web_fetch/web_search conversions.
It is the chosen approach after investigation rejected a Playwright-MCP-capability
alternative (KubeClaw's group-scoped MCP calls are one-shot per tool call, which
fights `@playwright/mcp`'s per-session browser model; the official image runs as
root against the capability's non-root security context; and it surfaces ~44
un-restrictable tools). The `cdp` bridge is a bounded, deterministic change that
reuses existing images and fits the catalog/sidecar model.

## Scope

**In scope (this spec):**
- A new `ToolSpec.pattern: 'cdp'` + validation.
- A new bridge mode `cdp-bridge` (`executeToolBridgeCdp`) in
  `container/agent-runner/src/tool-server.ts` that holds one persistent
  Playwright-over-CDP connection and dispatches primitive browser actions. Adds
  `playwright-core` as an agent-runner dependency.
- `createSidecarToolPodJob` wiring for `pattern: 'cdp'`: attach the
  operator-specified chromium image (`ToolSpec.image`) as a **native sidecar**
  (the proven `browserSidecar` init-container pattern, generalized), **skip the
  `user-tool` container**, add a 256Mi `/dev/shm` emptyDir, set
  `KUBECLAW_CDP_URL`.
- A single `browser` catalog baseline tool (Helm) on a **stock chromium-CDP
  image** (default `chromedp/headless-shell:latest`) with an `action`-dispatch
  primitive contract.
- Remove `browser` from the static built-in maps + `RESERVED_NAMES` + the
  channel `BUILTIN_CATEGORIES`; decouple `places_search` onto its own `places`
  category.
- Tests at all three levels + docs.

**Out of scope (tracked follow-ons):**
- **Profile/login persistence across pod restarts** (`mount: group` →
  `--user-data-dir` on the chromium container). v1 is ephemeral (warm within a
  pod's life, fresh after idle-out).
- `screenshot` returning an image to the user, and `eval(js)` — deferred from the
  v1 action set.
- Converting `places_search` itself into a credential-injected catalog tool (now
  trivial given the credential-injection port) — this spec only does the minimal
  `places` category decoupling to unblock `browser`.
- Removing the in-process local path / retiring the legacy agent-runner — `browser`
  keeps its dual existence (still an in-process built-in in the legacy
  agent-runner, unchanged), exactly like bash/web_fetch/web_search.

## Decisions (from brainstorming)

1. **`cdp` bridge over a Playwright-MCP capability** — deterministic statefulness
   (one persistent connection in the long-lived bridge), reuses existing images,
   curated tool surface, fits the catalog model; ~150–200 lines vs the MCP route's
   session-model/root-image/builder friction.
2. **Stock operator-chosen chromium image via `ToolSpec.image`** (no first-party
   image). The existing `kubeclaw-browser-sidecar` is just stock chromium + CDP
   flags; a stock image (`chromedp/headless-shell`, `zenika/alpine-chrome`, …)
   does the same and is the default.
3. **One `browser` tool with an `action` enum** — forced by statefulness: a
   sidecar tool pod is keyed by `(agentJobId, toolName)`, so all primitives must
   share one tool name to share one warm pod/chromium.
4. **Snapshot + refs** element model — `snapshot` returns the accessibility tree
   with stable refs; `click`/`type` act on a ref. Robust, LLM-native (the
   Playwright-MCP / agent-browser model).
5. **Per-pod = per-group isolation; ephemeral v1** — warm within a pod's life,
   fresh after idle-out. Persistence deferred.
6. **`places_search` decoupled** onto its own `places` built-in category so
   removing `browser` from `BUILTIN_CATEGORIES` doesn't misroute it.

## Topology

```
┌──────────── browser cdp tool pod (per group, warm, ephemeral) ────────────┐
│  kubeclaw-tool-bridge                         chromium (native sidecar)    │
│  (tool-server.js, KUBECLAW_TOOL_MODE=cdp-bridge)  image = ToolSpec.image    │
│   Redis ◀─toolcalls──┐                            (stock chromium-CDP,      │
│        │             │  playwright-core            command = chromium flags,│
│        ▼             │  connectOverCDP             CDP on ToolSpec.port,    │
│   executeToolBridgeCdp ── http://localhost:{port} ─▶ restartPolicy:Always,  │
│   (1 persistent Browser/Page,                       /dev/shm 256Mi emptyDir)│
│    ref map from last snapshot)◀── page state ──────                         │
│   Redis ─toolresults▶                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

No `user-tool` container. Bridge image = `kubeclaw-agent` (already present).

## Component 1 — `ToolSpec.pattern: 'cdp'` (`src/tools/types.ts`)

- Extend the `pattern` union to `'http' | 'file' | 'acp' | 'cdp'`; add `'cdp'` to
  the `PATTERNS` set; update the validation error message.
- **Validation** for `pattern === 'cdp'`: `image` required (the chromium image);
  `port` required (the CDP port); `requestMapping`/`run`/`mount`-group are not
  meaningful (no new guards required, but `run` stays `file`-only and
  `requestMapping` stays `http`-only as today). `command` carries the chromium
  launch flags.
- `ToolSpec.parameters` for the browser tool is operator-authored (the `action`
  enum schema — see Component 4); no new ToolSpec field is needed for the action
  set.

## Component 2 — `cdp-bridge` mode (`container/agent-runner/src/tool-server.ts`)

Add `playwright-core` to `container/agent-runner/package.json`.

- Extend the `KUBECLAW_TOOL_MODE` type to include `'cdp-bridge'`; add the dispatch
  branch in `executeTool`: `if (toolMode === 'cdp-bridge') return executeToolBridgeCdp(tool, input)`.
- Add a CDP readiness wait (poll `http://localhost:{port}/json/version` until
  ready or timeout) before the first action, reusing/mirroring `ensureToolReady`.
- **`executeToolBridgeCdp(tool, input)`** — a long-lived stateful handler:
  - Lazily `chromium.connectOverCDP(KUBECLAW_CDP_URL)` once; cache the `Browser`
    and a single `Page` (create one if none). Reconnect if the connection is
    closed (chromium restart).
  - Dispatch on `input.action`:
    - `navigate({url})` → `page.goto(url)`; return the new URL + title.
    - `snapshot()` → the accessibility tree with element refs + current URL +
      title (the LLM's "eyes"). **Ref mechanism:** use Playwright's aria snapshot
      with ref targeting (the `aria-ref=` locator engine Playwright-MCP uses);
      **fallback** (if that internal API is unstable): inject `data-kc-ref="eN"`
      attributes onto interactive elements during snapshot and target by
      `[data-kc-ref="eN"]`. The plan pins the exact API + fallback. Truncate to
      `MAX_TOOL_OUTPUT_BYTES`.
    - `click({ref})` → resolve ref → `locator.click()`.
    - `type({ref, text, submit?})` → resolve ref → `locator.fill(text)` (+
      `Enter` if `submit`).
    - `press({key})` → `page.keyboard.press(key)`.
    - `back()` → `page.goBack()`.
    - `wait({for})` → wait for a selector/text/timeout.
  - All actions wrapped: Playwright errors → concise error strings (never thrown
    into the loop). Stale/unknown `ref` → "ref not found — call snapshot first".
    Unknown action → error listing valid actions.

The `http`/`file`/`acp`/local paths are untouched.

## Component 3 — `createSidecarToolPodJob` cdp wiring (`src/k8s/job-runner.ts`)

- Detect `isCdpBridge = toolSpec.pattern === 'cdp'`; map to `toolMode = 'cdp-bridge'`.
- **Chromium native sidecar**: attach `toolSpec.image` (operator's stock chromium
  image) as a K8s native sidecar (init-container, `restartPolicy: 'Always'`),
  generalizing the existing `browserSidecar` block (lines ~1079–1104) — its
  `command` = `toolSpec.command` (chromium flags), CDP port = `toolSpec.port`,
  readiness on `/json/version`, resources from `toolSpec` (default ~512Mi/1Gi).
  Add a `dshm` `emptyDir{ medium: Memory, sizeLimit: 256Mi }` volume mounted at
  `/dev/shm` on the chromium container.
- **No `user-tool` container** when `isCdpBridge` (the bridge talks to chromium
  over localhost; there is no third-party REST/file tool).
- Bridge env gains `KUBECLAW_CDP_URL = http://localhost:{port}` and
  `KUBECLAW_TOOL_MODE = cdp-bridge`.
- The shared emptyDir / tool-wrapper ConfigMap (file-bridge wiring) is **not**
  added for cdp.
- A longer default idle timeout for the browser pod (browsing spans turns) via
  `ToolSpec.timeout`.
- Credential injection (`ToolSpec.credentials`) remains available and orthogonal
  — a browser tool that needs an authed egress could declare it, but the v1
  `browser` baseline declares none.

## Component 4 — `browser` catalog baseline (Helm) + the action schema

A single Helm `tools:` baseline entry:

```yaml
  - name: browser
    description: Drive a real web browser (Chromium). Use snapshot to see the page (it returns an accessibility tree with element refs), then click/type using a ref.
    parameters:
      type: object
      properties:
        action:
          type: string
          enum: [navigate, snapshot, click, type, press, back, wait]
        url:    { type: string }   # navigate
        ref:    { type: string }   # click, type
        text:   { type: string }   # type
        submit: { type: boolean }  # type
        key:    { type: string }   # press
        for:    { type: string }   # wait (selector/text/ms)
      required: [action]
    image: chromedp/headless-shell:latest
    pattern: cdp
    port: 9222
    command: ['/headless-shell/headless-shell', '--headless', '--no-sandbox', '--remote-debugging-address=0.0.0.0', '--remote-debugging-port=9222', '--disable-dev-shm-usage']
    memoryRequest: 512Mi
    memoryLimit: 1Gi
    cpuRequest: 250m
    cpuLimit: "1"
    timeout: 600000
```

(The exact `command`/entrypoint depends on the chosen image; the plan verifies
`chromedp/headless-shell`'s binary path/flags and the `/json/version` readiness.
`--disable-dev-shm-usage` complements the 256Mi `/dev/shm`. The `image`/`command`
are operator-swappable for any stock chromium-CDP image.)

## Component 5 — Remove from the static surface + routing decouple

- `src/runtime/direct-llm-runner.ts`: remove `browser` from `TOOLS`,
  `TOOL_SERVER_NAME`, `TOOL_CATEGORY`. Change `TOOL_CATEGORY['places_search']`
  from `'browser'` to `'places'`.
- `src/tools/types.ts`: remove `'browser'` from `RESERVED_NAMES` (keep
  `places_search`, `execution`; web_fetch/web_search already removed).
- `src/k8s/ipc-redis.ts`: `BUILTIN_CATEGORIES` — remove `'browser'`, add
  `'places'` (so `places_search` still routes to a built-in pod via
  `createToolPodJob`; the channel path now routes the name `browser` to the
  catalog).
- The legacy agent-runner (`container/agent-runner/src/index.ts`) keeps its
  `agent_browser`/web built-ins (dual existence) — its `tool_pod_request` path
  calls `createToolPodJob` directly and never consults `BUILTIN_CATEGORIES`, so
  it is unaffected.

## Error handling

| Condition | Behavior |
|---|---|
| Chromium/CDP not ready | Bridge readiness-waits on `/json/version`; timeout → tool error. |
| Chromium crashes (sidecar restarts it) | Bridge detects the closed CDP connection and reconnects on the next call; page state lost on a crash (surfaced, not hidden). |
| `ref` stale/unknown | `ref not found — call snapshot first`. |
| Unknown `action` | Error listing valid actions. |
| Navigation timeout / element not found / type on non-input | Playwright throws → caught → concise error string (loop survives). |
| Output too large | snapshot/result truncated to `MAX_TOOL_OUTPUT_BYTES`. |

## Testing (three levels)

**Unit:**
- `validateTool`: `pattern: 'cdp'` accepted; cdp requires `image` + `port`.
- `createSidecarToolPodJob` (cdp): chromium native sidecar present with the
  operator image/command/port + `restartPolicy: Always` + `/json/version`
  readiness; `/dev/shm` 256Mi emptyDir; **no** `user-tool` container; bridge env
  has `KUBECLAW_CDP_URL` + `toolMode=cdp-bridge`; no shared/tool-wrapper volumes.
- `executeToolBridgeCdp` action dispatch + ref resolution + error strings, with a
  mocked Playwright `page`/`locator`.

**Integration** (real compiled bridge in `cdp-bridge` mode + a real stock chromium
exposing CDP — e.g. `chromedp/headless-shell` or a local chromium — driven against
a local static HTML page, gated on chromium availability like the live tests):
`navigate → snapshot` (assert aria tree + refs + URL/title) `→ click(ref) → type →
snapshot` proving state persists across calls on the same persistent connection; a
non-zero/invalid action surfaces a clean error.

**End-to-end (manifest, minikube-live-gated):** `createSidecarToolPodJob` with a
cdp `browser` spec → real Job has the chromium native sidecar (operator image),
no `user-tool`, the `/dev/shm` emptyDir, `KUBECLAW_CDP_URL`, `cdp-bridge` mode.

## Key files

| File | Change |
|---|---|
| `src/tools/types.ts` | `pattern: 'cdp'` + `PATTERNS` + validation; unreserve `browser` |
| `container/agent-runner/package.json` | add `playwright-core` |
| `container/agent-runner/src/tool-server.ts` | `cdp-bridge` dispatch + `executeToolBridgeCdp` (persistent connectOverCDP, action dispatch, snapshot+refs, reconnect) + CDP readiness |
| `src/k8s/job-runner.ts` | `createSidecarToolPodJob` cdp: chromium native sidecar (operator image/command/port), no user-tool, `/dev/shm`, `KUBECLAW_CDP_URL`/`cdp-bridge` env |
| `src/runtime/direct-llm-runner.ts` | remove `browser` from the three maps; `places_search` → `places` category |
| `src/k8s/ipc-redis.ts` | `BUILTIN_CATEGORIES`: remove `browser`, add `places` |
| `helm/kubeclaw/values.yaml` | `browser` catalog baseline (pattern cdp, stock chromium image, action schema) |
| `docs/TOOL_BRIDGE.md` | document the `cdp` pattern + the browser tool |
| Tests | unit (types/job-runner/bridge), integration (real chromium CDP), e2e (manifest) |

## Backward compatibility / migration

- `pattern: 'cdp'` is additive; http/file/acp tools and the credential-injection
  port are unaffected.
- `browser` keeps its dual existence — still an in-process built-in in the legacy
  agent-runner (unchanged); only the channel/`DirectLLMRunner` path moves it to
  the catalog. `places_search` keeps working (now on the `places` category).
- The first-party `kubeclaw-browser-sidecar` image is **untouched** — it remains
  for the legacy agent-job `browserSidecar` feature. The browser *tool* uses a
  stock operator-chosen image instead.
- No Redis-protocol change; `cdp` reuses the sidecar-tool spawn/stream model
  (one tool name → one warm pod).
