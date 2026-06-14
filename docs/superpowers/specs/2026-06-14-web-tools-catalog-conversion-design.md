# Web Tools → Catalog Conversion + Credential-Injection Port — Design

**Status:** Approved (brainstorming complete)
**Date:** 2026-06-14
**Author:** Peter + Claude

## Problem & goal

KubeClaw's `web_fetch` and `web_search` are still **static in-process built-ins**:
the channel runtime (`src/runtime/direct-llm-runner.ts`) declares them in `TOOLS`
and routes them (category `browser`) to a `kubeclaw-agent`-image tool pod whose
`tool-server.js` runs them in-process via `executeToolLocal`
(`toolWebFetch` / `toolWebSearch` in `container/agent-runner/src/tool-server.ts`).
The goal — continuing the bash conversion — is to make them ordinary **catalog
tools on stock images driven through the sidecar bridge**, so the channel path is
fully catalog-driven.

`web_fetch` is trivial (stock HTTP client, no secret). `web_search` is the
interesting one: it calls the Brave Search API with `BRAVE_API_KEY`, and a stock
image in a sidecar tool pod cannot make that authenticated call today, because
**`createSidecarToolPodJob` attaches none of the credential-injection machinery**
that the main agent pod (`generateJobManifest`) already has. This spec delivers
both conversions plus the enabling capability: **a per-tool credential-injection
port onto the sidecar tool-pod path**, which also unblocks any future
authenticated third-party catalog tool (the original "drop in an arbitrary tool
container" goal).

`browser` is explicitly **out of scope** (see Scope) — it grew into its own
design problem during brainstorming.

## Scope

**In scope (this spec):**
- A new optional `ToolSpec.credentials: string[]` field (broker-catalog ids the
  tool needs), with validation.
- A **credential-injection port** onto `createSidecarToolPodJob`: when the tool
  declares credentials and `CREDENTIAL_INJECTION_MODE != off`, attach the Envoy
  credential sidecar + proxy env + SA token + owner-group annotation + the
  scoped placeholder env(s) onto the **user-tool** container — reusing the
  existing machinery (`buildCatalogEnvs` / `sidecarContainerSpec` /
  `sidecarVolumes` / `workloadEnvForSidecar`), scoped per-tool.
- Two default catalog baseline tools on a stock HTTP-client image:
  `web_fetch` (no creds, direct egress) and `web_search` (`credentials:
  [brave-search]`, egress via the in-pod Envoy; returns **raw Brave JSON**).
- Removal of `web_fetch` / `web_search` from the static built-in maps in
  `direct-llm-runner.ts`; unreserve their names.
- A widened egress NetworkPolicy for `app: kubeclaw-sidecar-tool`.
- Tests at all three levels + docs.

**Out of scope (tracked follow-ons):**
- **`browser`.** It needs either a new `cdp` bridge transport + a primitive
  contract, or a Playwright MCP server via the existing MCP subsystem — its own
  spec. It stays a static in-process built-in for now (unchanged).
- **In-process local-path removal.** `executeToolLocal` and the
  `execution`/`browser`-category machinery remain — they are still used by the
  **legacy autonomous agent-runner** (`container/agent-runner/src/index.ts`),
  which is launched live for `execute_agent` sub-agents, non-`direct` groups,
  scheduled tasks, and bootstrap installs. Removing the local path is gated on
  retiring/replatforming that agent-runner — a separate, larger migration.
  Consequently `web_fetch`/`web_search` keep a **dual existence** (catalog tools
  in the channel path; in-process built-ins in the agent-job path), exactly like
  `bash` today.
- Per-call credential rotation, multi-credential precedence, form/multipart
  bodies — unchanged.

## Decisions (from brainstorming)

1. **Scope is web_fetch + web_search only.** browser splits to its own spec.
2. **Credential declaration: per-tool `ToolSpec.credentials`, wired through the
   existing `buildCatalogEnvs`/substitution machinery** ("A via C"). Per-tool is
   least-privilege and auditable (a tool only gets the placeholder env it
   declares, so a compromised tool cannot form a request that exfiltrates another
   host's secret); reusing the existing path avoids a second injection code path.
3. **Sidecar-attach policy: only when the tool declares credentials.** Most tool
   pods (bash, web_fetch) stay lean; only credential-needing tools pay the Envoy
   cost.
4. **web_search returns raw Brave JSON** (truncated to the output cap). No
   shaping logic — pure stock curl; the channel LLM parses the payload.
5. **Both tools use `pattern: file`** with the jq-free wrapper + a `run` template
   on a stock HTTP-client image (`curlimages/curl`-style). No first-party image.
6. **The secret never reaches the low-trust container.** `web_search`'s tool
   container holds only a `KC_PH_<placeholder>` value; the in-pod Envoy + broker
   substitute the real key at egress.

## Topology

```
┌───────────────── web_search sidecar tool pod ─────────────────┐
│  kubeclaw-tool-bridge      user-tool (stock curl)   credential-sidecar │
│  (tool-server.js)          run: curl -H "...:$BRAVE_API_KEY"   (Envoy)  │
│   Redis ◀─toolcalls──┐                                                  │
│        │             │  file-bridge (/shared)                           │
│        ▼             └── req/{id}/input/* ──▶ wrapper runs curl          │
│   executeToolBridgeFile ◀── resp/{id}/* ──── curl via HTTPS_PROXY ──▶ Envoy
│        │                                       (placeholder in header)  │ │
│   Redis ─toolresults▶                          Envoy ─ext_authz─▶ broker│ │
└────────────────────────────────────────────── Envoy ─▶ api.search.brave.com ┘
                                                 (Lua swaps KC_PH_… → real key)
```

`web_fetch` is the same pod **without** the credential sidecar — the user-tool
container curls the target URL directly.

## Component 1 — `ToolSpec.credentials`

New optional field (`src/tools/types.ts`):

```typescript
// on ToolSpec:
/** Broker-catalog ids whose credentials this tool needs injected at egress.
 *  Each id is resolved (orchestrator-side) to a placeholder env var stamped on
 *  the user-tool container; the in-pod Envoy + broker substitute the real value
 *  at egress. Presence of any id triggers credential-sidecar attachment. */
credentials?: string[];
```

- Add `'credentials'` to `ALLOWED_KEYS`.
- **Validation** (`validateTool`): if present, must be an array of non-empty
  strings. (Whether each id exists in the deployed broker catalog is **not**
  cross-checked at registration — the catalog is a deploy-time value; an unknown
  id simply injects no placeholder and the tool's authed call fails at runtime.
  This mirrors how `requestMapping` token validity is deferred to call time.)
- Valid for any `pattern` (an `http` or `file` tool may both need credentials).

## Component 2 — Credential-injection port onto `createSidecarToolPodJob`

Today `generateJobManifest` (the main agent pod) wires credential injection
(`src/k8s/job-runner.ts` ~1106–1121): appends `sidecarContainerSpec(...)` +
`sidecarVolumes()` when `injectionMode === 'sidecar'`, sets
`serviceAccountName: 'kubeclaw-tool-job'` when `injectionMode !== 'off'`, stamps
the `kubeclaw.io/owner-group` pod annotation, and injects catalog placeholder
envs via `buildCatalogEnvs(...)`. `createSidecarToolPodJob`
(`src/k8s/job-runner.ts` ~1714–1960) has **none** of this.

Port it, **gated on the tool declaring credentials**:

```typescript
// inside createSidecarToolPodJob, after resolving toolSpec
const injectionMode = getInjectionMode();
const wantsCreds = (toolSpec.credentials?.length ?? 0) > 0 && injectionMode !== 'off';
```

When `wantsCreds`:
1. **Resolve the declared ids → catalog entries.** Reuse the same catalog source
   the orchestrator already uses to feed `buildCatalogEnvs` for `generateJobManifest`,
   filtered to `toolSpec.credentials`. Each entry yields `{ host, envVar }` (e.g.
   `brave-search → { host: 'api.search.brave.com', envVar: 'BRAVE_API_KEY' }`).
   *(The exact in-orchestrator catalog accessor is pinned down in the plan's
   first task; it already exists for the agent-pod path.)*
2. **Placeholder env on the user-tool container.** Run the filtered entries
   through `buildCatalogEnvs(...)` (or its underlying helper) to produce
   `{ name: envVar, value: 'KC_PH_<placeholder>' }` entries, appended to
   `userEnv` (the `user-tool` container's env). In `istio` mode use whatever
   value form `generateJobManifest` uses for istio (the same helper governs it).
3. **Proxy env on the user-tool container.** Apply `workloadEnvForSidecar(...)` to
   the user-tool container env (`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`/
   `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) so a stock `curl` routes through the
   in-pod Envoy and trusts the egress CA.
4. **Envoy sidecar container + volumes.** Append `sidecarContainerSpec(...)` to
   the pod's containers and `sidecarVolumes()` to its volumes (these include the
   `egress-ca` Secret mount that `SSL_CERT_FILE` points at). The Envoy sidecar is
   a third container alongside `kubeclaw-tool-bridge` + `user-tool`.
5. **Pod identity.** Set `serviceAccountName: 'kubeclaw-tool-job'` and stamp the
   `kubeclaw.io/owner-group` annotation (value = the calling group) on the pod
   template, so the broker's identity → owner-group → policy resolution succeeds.

When `!wantsCreds`: behavior is **unchanged** — no Envoy sidecar, no proxy env,
no SA-token/owner-group, no placeholder env (full backward compatibility for
bash, the file-bridge, and existing catalog tools).

**Security boundary:** the placeholder env is scoped to the tool's *declared*
ids only. A tool without `credentials: [openai]` never receives the OpenAI
placeholder string, so it cannot construct a request the broker would substitute
an OpenAI key into — even though the broker still matches by host. The egress CA
and broker token come from `sidecarVolumes()` (projected SA token, audience
`kubeclaw-credential-broker`), never a long-lived secret in the image.

## Component 3 — web_fetch & web_search catalog entries (Helm)

Two default `tools:` baseline entries (`helm/kubeclaw/values.yaml`), alongside
the existing `bash`/`bash_persist`:

```yaml
  - name: web_fetch
    description: Fetch the raw content of a URL over HTTP(S).
    parameters:
      type: object
      properties:
        url: { type: string }
      required: [url]
    image: curlimages/curl:latest          # stock; operator may pin/override
    pattern: file
    mount: none
    run: 'curl -sSL -A "Mozilla/5.0 KubeClaw/1.0" "$(cat "$INPUT_DIR/url")"'
  - name: web_search
    description: Search the web via the Brave Search API. Returns the raw Brave JSON response (up to 10 results).
    parameters:
      type: object
      properties:
        query: { type: string }
      required: [query]
    image: curlimages/curl:latest
    pattern: file
    mount: none
    credentials: [brave-search]
    run: 'curl -sS -G -H "X-Subscription-Token: $BRAVE_API_KEY" --data-urlencode "q=$(cat "$INPUT_DIR/query")" --data-urlencode "count=10" "https://api.search.brave.com/res/v1/web/search"'
```

Notes:
- `web_search`'s `run` uses `curl --data-urlencode` for safe query encoding and
  places the placeholder `$BRAVE_API_KEY` (injected by Component 2) in the
  header; the in-pod Envoy swaps it for the real key at egress.
- The `brave-search` broker catalog entry already exists
  (`helm/kubeclaw/values.yaml`, `credentialFields: [{ name: api_key, envVar:
  BRAVE_API_KEY }]`, `allowOperatorFallback: true`). The operator still provisions
  the key (group-registered, or `kubeclaw-secrets[brave-search]` fallback) — this
  spec does not change where the key lives.
- Output is truncated to `MAX_TOOL_OUTPUT_BYTES` by the bridge, as for any
  file-bridge tool.

## Component 4 — Remove from the static surface

In `src/runtime/direct-llm-runner.ts`:
- Remove the `web_fetch` and `web_search` entries from `TOOLS`.
- Remove `web_fetch: 'webFetch'` and `web_search: 'webSearch'` from
  `TOOL_SERVER_NAME`.
- Remove `web_fetch: 'browser'` and `web_search: 'browser'` from `TOOL_CATEGORY`.
- **`browser` and `places_search` stay untouched.**

In `src/tools/types.ts`: remove `'web_fetch'` and `'web_search'` from
`RESERVED_NAMES` (keep `'browser'`, `'places_search'`, `'execution'`).

**No `BUILTIN_CATEGORIES` change.** Unlike `browser`, the names `web_fetch` /
`web_search` are not entries in `BUILTIN_CATEGORIES` (`src/k8s/ipc-redis.ts`), so
the channel spawn watcher already routes them to the catalog once they leave
`TOOL_CATEGORY`. (`browser` *is* a category name — a reason it is deferred.)

The legacy agent-runner (`container/agent-runner/src/index.ts`) and
`executeToolLocal` keep their `web_fetch`/`web_search` built-ins untouched — the
agent-job path is unchanged (dual existence, as with bash).

## Component 5 — Egress NetworkPolicy

The current `app: kubeclaw-sidecar-tool` NetworkPolicy permits broker egress but
not general internet egress. These tools need outbound HTTP(S):
- `web_fetch`: arbitrary destinations, **direct** from the user-tool container.
- `web_search`: the in-pod **Envoy** egresses to the broker (ext_authz) and to
  `api.search.brave.com`.

Widen the egress policy for `app: kubeclaw-sidecar-tool` to allow outbound 80/443
to the internet (excluding cluster-internal/link-local ranges per existing
convention), keeping the broker-egress allowance. *(If the project prefers a
tighter per-tool egress story, that is a follow-on; this spec grants the
sidecar-tool egress the same outbound posture the in-process browser-category
pods have today, so the conversion is behavior-preserving.)*

## Error handling

| Condition | Behavior |
|---|---|
| `web_search` with no broker key provisioned | Brave returns 401; curl prints the body; bridge returns it as the result (non-zero curl exit if `-f` were used — we do **not** use `-f`, so the 401 body surfaces as the tool result for the LLM to read). |
| Tool declares `credentials` but `CREDENTIAL_INJECTION_MODE=off` | No sidecar attached, no placeholder env; the authed call goes out with a literal/empty key and fails at the API. (Operator misconfiguration; documented.) |
| Unknown catalog id in `credentials` | No placeholder injected for it; other declared ids still injected; the call using the missing one fails at the API. |
| Non-cred tool (bash, web_fetch) | Unchanged — no credential machinery attached. |
| Egress blocked by NetworkPolicy | curl times out / connection refused; surfaced as the tool result. |

## Testing (three levels)

**Unit:**
- `validateTool`: `credentials` accepted as a string array; rejected when not an
  array or containing a non-string/empty entry.
- `createSidecarToolPodJob` (`src/k8s/job-runner.test.ts`): a tool with
  `credentials: ['brave-search']` (mode=sidecar) → pod has the Envoy
  `credential-sidecar` container, the user-tool container has the placeholder env
  (`BRAVE_API_KEY=KC_PH_…`) + `HTTPS_PROXY` + `SSL_CERT_FILE`, the pod has
  `serviceAccountName: kubeclaw-tool-job` + the `kubeclaw.io/owner-group`
  annotation; the `kubeclaw-tool-bridge` container does **not** get the
  placeholder/proxy env. A tool **without** `credentials` → none of that
  (unchanged). `mode=off` with `credentials` → none of that. Mock the injection
  helpers as `generateJobManifest`'s tests do.
- Confirm the existing `generateJobManifest` injection tests still pass
  (shared helpers untouched).

**Integration** (`e2e/sidecar-tool-pod.test.ts`, real compiled bridge + real
wrapper over a temp `/shared`): a `web_fetch`-style file tool whose `run` is
`curl`/`printf` against a tiny local HTTP server returns the body; a
`web_search`-style run that echoes the `X-Subscription-Token` header value proves
the `run` template + placeholder env flow end-to-end at the bridge/wrapper level
(credential *substitution* itself is broker/Envoy and is covered by the
credential-broker unit tests + the manifest assertions, not re-proven here).

**End-to-end (minikube-live):** assert at the manifest level (the deployed
orchestrator may predate this branch, so call `createSidecarToolPodJob` directly):
a `web_search` catalog spec (`credentials: ['brave-search']`) produces a real Job
with the Envoy `credential-sidecar`, the user-tool placeholder/proxy env, the SA
+ owner-group annotation, and the bridge container without those; a `web_fetch`
spec produces a Job with no credential sidecar. Clean up created Jobs.

## Key files

| File | Change |
|---|---|
| `src/tools/types.ts` | Add `credentials?: string[]` + `ALLOWED_KEYS` + validate |
| `src/k8s/job-runner.ts` | `createSidecarToolPodJob`: gated credential-injection port (sidecar container, proxy/placeholder env on user-tool, SA + owner-group) reusing `buildCatalogEnvs`/`sidecarContainerSpec`/`sidecarVolumes`/`workloadEnvForSidecar` |
| `src/runtime/direct-llm-runner.ts` | Remove `web_fetch`/`web_search` from TOOLS/TOOL_SERVER_NAME/TOOL_CATEGORY |
| `helm/kubeclaw/values.yaml` | `web_fetch` + `web_search` baseline catalog entries |
| `helm/kubeclaw/templates/networkpolicies-injection.yaml` (+ any k8s raw) | Widen `kubeclaw-sidecar-tool` egress to outbound 80/443 |
| `docs/TOOL_BRIDGE.md` | Document `ToolSpec.credentials` + the credential-injected sidecar tool pod + the web_fetch/web_search examples |
| Tests | unit (types + job-runner), integration (sidecar-tool-pod), e2e (minikube-live) |

## Backward compatibility / migration

- `ToolSpec.credentials` is optional; absent → unchanged behavior. The
  credential-injection port is fully gated on it + `mode != off`, so every
  existing catalog tool (bash, file-bridge, http/acp) is byte-for-byte
  unaffected.
- `web_fetch`/`web_search` keep working in the legacy agent-job path (in-process
  built-ins, unchanged); only the channel/`DirectLLMRunner` path moves them to
  the catalog. `browser`/`places_search` are untouched.
- No Redis-protocol or `SidecarToolPodJobSpec` shape change beyond reading
  `toolSpec.credentials` (already carried on the full `toolSpec`).
- The shared credential-injection helpers and `generateJobManifest` behavior are
  unchanged — the port reuses them, it does not modify them.
