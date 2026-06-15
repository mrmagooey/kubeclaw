# LLM Credential Broker — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Builds on:** the credential-broker + injection subsystem (Envoy ext_authz, per-group `catalog` substitution + operator `mappings`, sidecar/istio modes) already used for tool egress (`brave-search`, `google-places`).

## Problem

Channel pods and agent jobs hold raw LLM provider API keys as env vars
(`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` from `kubeclaw-secrets`).
The stated roadmap priority is to broker LLM traffic the way tool traffic is
brokered: the workload never holds the real key; Envoy stamps it at egress.

Investigation findings that shape this design:

1. **The broker machinery already supports this.** `catalog` entries (host →
   `credentialField{envVar}`, `allowOperatorFallback`, `allowedPositions`,
   `baseUrlEnvs`, `apiKeyShape`) drive per-group `KC_PH_…` placeholder substitution
   via the Envoy Lua filter; `allowOperatorFallback` covers the no-group case with a
   `KC_PH_FALLBACK_<id>` sentinel. Channel/agent/capability pods already attach the
   Envoy sidecar (sidecar mode) and get base-URL overrides (istio mode).
2. **Egress is TLS *origination*, not MITM (confirmed in the Envoy/Istio configs).**
   The workload emits cleartext HTTP to Envoy (loopback in sidecar; mesh-mTLS to the
   egress gateway in istio); the Lua substitution runs on the cleartext request; then
   Envoy originates TLS to the real upstream (`UpstreamTlsContext` / DestinationRule
   `tls: mode: SIMPLE`). This is why `http://` base URLs are used (e.g. `google-places`).
   The cleartext hop is loopback/mesh-mTLS, never the external wire. (MITM-with-installed-cert
   was considered and rejected: Istio has no turnkey external-TLS MITM; it would need a
   custom EnvoyFilter + per-SNI leaf certs. Origination is the supported, simpler,
   cross-mode pattern, and our providers honor their `*_BASE_URL` env.)
3. **The real blocker: Node `fetch`/undici does NOT honor `HTTPS_PROXY`.** Both the
   channel's OpenAI SDK (`src/runtime/llm-client.ts`) and the agent-runner's `pi-ai`
   use Node global `fetch`, which ignores the proxy env that sidecar mode sets. So in
   sidecar mode LLM egress bypasses Envoy entirely (and the key is already stripped) →
   it fails. istio mode is transparent (iptables) and unaffected.

## Goal

Route channel-pod and agent-job LLM egress (OpenAI / Anthropic / OpenRouter, plus
Voyage embeddings) through the broker via TLS origination, in **both** sidecar and
istio modes, so those workloads no longer carry raw LLM keys. Keys are operator-level
by default (via `allowOperatorFallback`) with per-group keys available to agent jobs.

## Decisions (answered)

- **Key model:** LLM providers become `catalog` entries with `allowOperatorFallback:
  true` — operator-wide key by default, per-group keys optional (agent jobs only; see
  the channel-pod nuance below).
- **Modes:** both sidecar and istio, fully (incl. e2e).
- **Workloads:** channel pods + agent jobs deprivileged; the orchestrator stays trusted
  (it is the control plane that provisions `kubeclaw-secrets`); Ollama unchanged
  (in-cluster, no egress key).

## Non-goals

- MITM of app-initiated HTTPS / custom EnvoyFilter cert plumbing (rejected above).
- Per-group LLM keys for **channel pods** (architecturally impossible cleanly — a
  channel pod multiplexes many groups, see §1).
- Brokering the orchestrator's direct-mode LLM calls.
- Replacing the broker's generic `mappings` mechanism for non-LLM uses.

## Design

### 1. Key ownership: channel pods = operator fallback; agent jobs = per-group-capable

A **channel pod multiplexes many groups**, so it has no single owner-group the broker
can key on at request time. Therefore channel pods send the **operator-fallback
sentinel** `KC_PH_FALLBACK_<id>`; the broker resolves the operator key (no group
context). **Agent jobs are group-scoped** (`kubeclaw.io/owner-group` annotation), so
they send the per-group placeholder if the group registered an LLM key, else the same
fallback sentinel. `allowOperatorFallback: true` on each LLM catalog entry gives both
behaviors with no special-casing — `buildCatalogEnvs` already emits the per-group
placeholder vs `${FALLBACK_SENTINEL_PREFIX}${id}` correctly.

### 2. Broker catalog entries (`values.yaml` `credentialInjection.catalog`)

Add (mirroring `google-places`):

```yaml
- id: openai
  host: api.openai.com
  upstreamPort: 443
  credentialFields: [{ name: api_key, envVar: OPENAI_API_KEY }]
  baseUrlEnvs: { OPENAI_BASE_URL: "http://api.openai.com/v1" }
  allowOperatorFallback: true
  allowedPositions: [header]
  apiKeyShape: { prefix: "sk-", minLength: 20 }
- id: anthropic
  host: api.anthropic.com
  upstreamPort: 443
  credentialFields: [{ name: api_key, envVar: ANTHROPIC_API_KEY }]
  baseUrlEnvs: { ANTHROPIC_BASE_URL: "http://api.anthropic.com" }
  allowOperatorFallback: true
  allowedPositions: [header]
  apiKeyShape: { prefix: "sk-ant-", minLength: 20 }
- id: openrouter
  host: openrouter.ai
  upstreamPort: 443
  credentialFields: [{ name: api_key, envVar: OPENROUTER_API_KEY }]
  baseUrlEnvs: { OPENROUTER_BASE_URL: "http://openrouter.ai/api/v1" }
  allowOperatorFallback: true
  allowedPositions: [header]
  apiKeyShape: { prefix: "sk-or-", minLength: 20 }
- id: voyage   # embeddings (RAG); same mechanism, already an istio built-in destination
  host: api.voyageai.com
  upstreamPort: 443
  credentialFields: [{ name: api_key, envVar: VOYAGE_API_KEY }]
  baseUrlEnvs: { VOYAGE_BASE_URL: "http://api.voyageai.com" }
  allowOperatorFallback: true
  allowedPositions: [header]
```

Notes:
- The exact `baseUrlEnvs` paths must match what each SDK expects (OpenAI SDK appends
  paths to `OPENAI_BASE_URL`; confirm `/v1` vs bare host per SDK during implementation —
  this is a verification point, not a guess to ship blindly).
- Anthropic uses the `x-api-key` header (not `Authorization`); substitution is
  header-name-agnostic (`allowedPositions: [header]` scans all headers), so
  `ANTHROPIC_API_KEY=KC_PH_…` → `x-api-key: KC_PH_…` → substituted.

### 3. Operator-key resolution + retire legacy LLM `mappings`

- The operator fallback reads `operatorSecretReader(entry.id)` → `kubeclaw-secrets[<id>]`.
  Today the operator OpenAI key lives at `kubeclaw-secrets['openai-api-key']`. Wire the
  chart to also write the operator keys under the **catalog-id keys** (`openai`,
  `anthropic`, `openrouter`, `voyage`), populated from the existing Helm `secrets.*`
  values — so operator UX is unchanged but the broker can resolve by id. (Alternatively
  teach `operatorSecretReader` an id→key map; the chart-key approach is simpler and
  keeps the broker generic.)
- **Retire the built-in LLM `mappings`** (anthropic/openai/openrouter) in the broker
  config. The ext_authz checks `mappings` *before* `catalog`; leaving an LLM mapping in
  place would shadow the new catalog entry (operator-only, no per-group), so the catalog
  path would never run. Removing them lets the catalog entries take over (with operator
  fallback preserving the operator-key behavior). Keep `mappings` for any non-LLM use.

### 4. Egress model: TLS origination via `http://` base URLs (both modes)

`baseUrlEnvs` set each provider's base URL to `http://<host>`. The SDK sends a cleartext
HTTP request carrying the placeholder in its auth header to the in-pod Envoy (sidecar)
or egress gateway (istio); Envoy substitutes the real key and originates TLS upstream.
One config serves both modes. **Document that this is not plaintext-to-the-internet** —
Envoy does real TLS to the provider; the cleartext hop is loopback/mesh-mTLS only.

### 5. The enabler: make Node honor the egress proxy (sidecar mode)

Add a tiny startup shim that, when `HTTP_PROXY`/`HTTPS_PROXY` is set, installs undici's
`EnvHttpProxyAgent` as the global dispatcher so Node `fetch` routes through Envoy:

```ts
// installed at process startup, before any LLM/HTTP call
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
export function installProxyDispatcher(): void {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent()); // honors HTTP(S)_PROXY + NO_PROXY
  }
}
```

- Call it at the entrypoints of **both** runtimes: the channel/orchestrator runtime
  (`src/`) and the agent-runner (`container/agent-runner/src/index.ts`).
- `undici` becomes an explicit dependency in both packages (Node 24 bundles undici, but
  the package's `setGlobalDispatcher` is what wires the global `fetch`; pin a version
  with `EnvHttpProxyAgent`). Node honors `NODE_EXTRA_CA_CERTS` natively for the
  Envoy→upstream chain validation; with `http://` base URLs the app→Envoy hop needs no
  TLS, so the egress CA is not on the LLM path (it remains for any HTTPS-MITM tool path).
- istio mode sets no proxy env, so the shim is a no-op there (transparent iptables).

### 6. `NO_PROXY` completeness (the main correctness hazard)

The global dispatcher proxies **all** `fetch` in the process. Any in-cluster HTTP
destination the runtime/agent calls (capability MCP pods, Ollama `http://ollama:11434`,
the RAG/embeddings store e.g. Qdrant, embedding endpoints, etc.) would be wrongly routed
to Envoy unless `NO_PROXY` excludes it. (Redis is ioredis/TCP, not `fetch`, so it is
unaffected.) Today `NO_PROXY` is only `localhost,127.0.0.1,kubeclaw-redis,credential-broker`.

The implementation must **enumerate every in-process HTTP destination** and set a
complete `NO_PROXY` covering them, using cluster-internal suffixes plus explicit
short-names, e.g.:

```
NO_PROXY=localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,
         <rag/qdrant host>,<capability service prefix/host>,.svc,.svc.cluster.local,.cluster.local
```

`EnvHttpProxyAgent` honors `NO_PROXY` suffix matching. This list lives in
`workload-env.ts` (`workloadEnvForSidecar`) and the Helm `kubeclaw.credentialSidecarEnv`
helper — keep them in sync. A unit test must assert the in-cluster destinations are
covered; an integration test must prove an in-cluster `fetch` bypasses the proxy while an
external one uses it.

### 7. Per-workload wiring

- **Channel pods** (`helm/kubeclaw/templates/channel-pods.yaml`): when injection mode
  != off (and not audit-only), emit `OPENAI_API_KEY=KC_PH_FALLBACK_openai` (+ anthropic/
  openrouter/voyage) and the `http://` base URLs — for **both** sidecar and istio modes
  (replacing the istio-only base-URL helper and the off/audit-gated raw-key injection).
  The sentinel value must match the TS `FALLBACK_SENTINEL_PREFIX` (`KC_PH_FALLBACK_`) —
  keep the Helm literal and the TS constant in sync (a render test guards this).
- **Agent jobs** (`src/k8s/job-runner.ts` `generateJobManifest`): include the LLM catalog
  entries in `spec.catalogEntries` (every agent makes LLM calls), so `buildCatalogEnvs`
  stamps the per-group-or-fallback placeholder + `http://` base URL and its
  `coveredEnvNames` filter strips the raw `secretKeyRef` LLM envs. The orchestrator
  passes the group's placeholders (already wired for tools) so a group with a registered
  LLM key gets per-group substitution.
- **Orchestrator / Ollama:** unchanged.
- **auditOnly:** preserves existing behavior (keep real keys for observation; still add
  proxy env + base URLs so the broker can log would-stamp decisions).

## Data flow (channel pod, sidecar mode, operator key)

```
DirectLLMRunner → OpenAI SDK (OPENAI_BASE_URL=http://api.openai.com/v1,
                              OPENAI_API_KEY=KC_PH_FALLBACK_openai)
  → fetch (global dispatcher = EnvHttpProxyAgent) → HTTP_PROXY = in-pod Envoy
    → Envoy: ext_authz → resolver: host api.openai.com, no group → operator fallback
      → returns x-kubeclaw-substitutions: KC_PH_FALLBACK_openai=<b64 operator key>
      → Lua replaces it in the Authorization header
    → Envoy originates TLS to https://api.openai.com → response back
```

(istio mode: identical except iptables redirect to the egress gateway instead of
HTTP_PROXY; agent job with a registered group key: per-group placeholder instead of the
fallback sentinel.)

## Testing (three levels)

**Unit**
- Catalog entries parse via the broker config schema; `apiKeyShape`/`baseUrlEnvs` valid.
- `buildCatalogEnvs` for the LLM ids emits the per-group placeholder (when a group
  placeholder is present) or `KC_PH_FALLBACK_<id>` (when not) plus the `http://` base URL,
  and `coveredEnvNames` strips the raw key env.
- `installProxyDispatcher` installs `EnvHttpProxyAgent` only when proxy env is set
  (no-op otherwise).
- Channel-pod + agent-job manifests: raw LLM keys removed when injection on; placeholder
  + base-URL envs present; `NO_PROXY` includes the enumerated in-cluster destinations;
  Helm fallback sentinel literal equals the TS `FALLBACK_SENTINEL_PREFIX`.
- Broker: removing the LLM `mappings` makes the catalog path run for api.openai.com.

**Integration**
- A request carrying `KC_PH_FALLBACK_openai` (and a per-group `KC_PH_…`) in an auth
  header is substituted by the resolver+Lua path; the position policy is honored.
- With `HTTPS_PROXY` set + `installProxyDispatcher`, a `fetch` to an external host routes
  through a local stub proxy, while a `fetch` to a `NO_PROXY` host goes direct.

**E2E** (minikube-live, BOTH modes)
- Sidecar mode: a channel-pod LLM call and an agent-job LLM call are broker-stamped —
  verify via the broker **audit log** (a 200 with `keySource=operatorFallback`/`groupSecret`
  for `api.openai.com`) and/or a mock upstream that asserts the real key arrived and the
  placeholder did not. In-cluster calls (Ollama/RAG) still succeed (NO_PROXY).
- istio mode: same assertions through the egress gateway.

## Risks

- **`NO_PROXY` completeness (highest):** an omitted in-cluster HTTP destination breaks at
  runtime once the global dispatcher is installed. Mitigation: enumerate destinations
  from code, cluster-suffix matching, unit + integration tests, and a staged rollout
  (auditOnly first).
- **SDK base-URL path semantics:** `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` path expectations
  differ per SDK; verify the exact value (host vs host+`/v1`) against the OpenAI SDK and
  pi-ai during implementation.
- **undici global dispatcher reach:** confirm the installed `undici` package's
  `setGlobalDispatcher` actually governs Node's built-in global `fetch` (it does via the
  shared global-dispatcher symbol) — the integration test is the gate.
- **Mappings/catalog precedence:** must remove LLM `mappings` or the catalog never runs.

## Out of scope / follow-ups

- Per-group LLM-key registration UX (admin-shell / secret slash command for LLM ids) —
  the mechanism supports it (agent jobs), but the provisioning UX is a separate feature.
- Brokering the orchestrator's direct-mode LLM calls.
- The 3 residual dead `kubeclaw-tool-pod` NetworkPolicy labels (unrelated cleanup).
