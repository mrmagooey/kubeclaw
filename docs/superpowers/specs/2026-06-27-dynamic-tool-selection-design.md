# Dynamic Tool Selection — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan
**Branch:** `feature/dynamic-tool-selection`

## 1. Problem & Goal

Today a channel LLM can only call tools that already exist in the live tool
catalog. When a user asks for something the installed tools cannot do — e.g.
"find a photo of a cat, save it, extract its metadata, and report back" — the
operator must manually register the missing tools (image search, EXIF
extraction) via the admin shell before the workflow is possible.

**Goal:** a capability that lets the assistant *find, configure, verify, and
expose* an appropriate tool container on demand, driven by the user's request,
**without the user touching the mechanics of container selection or
configuration**. It preferentially reuses already-trusted tools and escalates
to open discovery only when necessary, with selection and provisioning handled
as a **privileged** activity inside the orchestrator.

### Motivating workflow (acceptance scenario)

A user, in a channel, asks the assistant to find a photo of a cat, save it
locally, run a tool to extract metadata, and report the metadata back. The
assistant accomplishes this end to end by dynamically acquiring an image-fetch
tool and an EXIF-metadata tool, with no human configuration of either
container — the only possible human touchpoint being an in-channel yes/no if a
secret must be used.

## 2. Key Decisions

1. **Three-tier search space:** live catalog → curated library → open discovery
   from external registries.
2. **Trigger:** the channel LLM gets a `find_tools(task_description)` tool. The
   actual search/select/provision work runs in a **privileged subagent forked
   inside the orchestrator** (the Tool Selection Agent, "TSA"), because the
   orchestrator is the only tier with Kubernetes API and secret access.
3. **Trust line:** select-and-run is **autonomous** in a locked-down sandbox.
   The single human gate is **credential binding**, and that approval is given
   **in-channel by the user** (no admin), as a yes/no.
4. **Contract synthesis for discovered images:** convention + LLM draft, then a
   **sandboxed probe** to verify before exposure; fall back down the tiers on
   failure.
5. **Persistence:** verified tools are promoted into the catalog tagged
   `auto-acquired` with `lastUsedAt`/TTL garbage collection; discovered tools
   additionally carry explicit **provenance** so their origin is clear.
6. **ACL scope:** tier-dependent — catalog/library tools are global; discovered
   (tier-3) tools default to the **discovering group only**, broadened to global
   only by explicit human promotion.
7. **Network containment:** per-tool `allowedEgress` allowlist, default-deny,
   rendered to the strongest substrate the cluster supports (Cilium `toFQDNs`
   or Istio egress gateway). **Tier-3 discovery is hard-gated**: it is disabled
   unless a hard egress-enforcement substrate is present.

## 3. Architecture

### 3.1 Three-tier search space

| Tier | Source | Trust | Notes |
| ---- | ------ | ----- | ----- |
| 1. Live catalog | Registered, active `ToolSpec`s (`src/tools/catalog-loader.ts`) | Vetted | Zero friction; first choice. |
| 2. Curated library | Vetted `ToolSpec`s authored in Helm values, marked inactive until needed | Vetted | Auto-activatable. Seeded with image-fetch + EXIF tools so the motivating workflow hits tier-2 on a fresh install. |
| 3. Open discovery | External registries (Docker Hub etc.); LLM-drafted `ToolSpec`, probe-verified | Untrusted | Safety net. Hard-gated on egress enforcement (see §3.6). |

### 3.2 Components

| Component | Location | Role |
| --------- | -------- | ---- |
| `find_tools(task_description)` tool | channel LLM TOOLS array (`src/runtime/direct-llm-runner.ts`) | Only new surface the channel sees. Sends a request over Redis IPC, blocks for the result with a generous timeout. |
| `find-tools` IPC stream + watcher | `src/k8s/ipc-redis.ts` (mirrors `startToolPodSpawnWatcher`) | Orchestrator receives the request and forks the TSA. |
| **Tool Selection Agent (TSA)** | orchestrator-forked privileged subagent (reuses `src/runtime`, narrow toolset) | The brain. Runs a bounded agent loop, returns resolved tool name(s) + human-readable summary (or a `pending_credential` / `unavailable` status). Never touches user conversation. |
| TSA tools | orchestrator-side | `search_catalog`, `search_library`, `search_registry`, `draft_toolspec`, `probe_tool`, `register_tool` (existing `src/skills/orchestrator/tool-registry.ts`), `request_credential_binding` (gated). |
| Promotion / reconcile | existing reconciler + SQLite overrides (tools analog of `src/specialists/reconciler.ts`) | Persists verified tools into the catalog ConfigMap with provenance + TTL metadata. |
| TTL sweep | `src/task-scheduler.ts` | Prunes stale auto-acquired tools. |

### 3.3 End-to-end flow (motivating workflow)

```
Channel LLM: find_tools("search the web for a photo of a cat and download it")
   → Redis: kubeclaw:find-tools  →  Orchestrator forks TSA
TSA: search_catalog → web_search exists but is text-only; no image-download match
     search_library → image-fetch ToolSpec found (tier-2) [or → tier-3 discovery]
     prefers a credential-free path (drive browser/web_fetch) → no gate
     register_tool(scope per tier, provenance recorded)
   → returns "image_fetch is ready" to the channel
Channel LLM: image_fetch(...) → writes cat.jpg to the group PVC (mount: group)
Channel LLM: find_tools("extract EXIF metadata from an image file")
TSA: no catalog match → library/discovery → exiftool image, pattern:file, mount:group,
     allowedEgress: [] (no external egress) → probe-verify → no credentials → autonomous
     register_tool(group-scoped if discovered)
   → returns "extract_metadata is ready"
Channel LLM: extract_metadata("cat.jpg") → reads same group PVC → reports metadata to user
```

The two acquired tools share the **group PVC** (`mount: group`,
`src/k8s/job-runner.ts`), giving the save-then-read handoff the workflow needs.

### 3.4 Tool Selection Agent loop

The TSA is short-lived, privileged, and forked per `find_tools` request. It
reuses the existing runtime but with a selection-only toolset and a system
prompt encoding the tier preference. Descending preference:

1. **`search_catalog`** — LLM reasoning over live `ToolSpec` name + description +
   params (catalog is small; no embedding index needed at this scale). Confident
   match → return. Done.
2. **`search_library`** — same matching over the curated library. Match →
   `register_tool` to activate (global scope, already vetted) → return.
3. **`search_registry`** (tier-3, only when 1–2 miss and egress gate satisfied):
   - Query the registry (Docker Hub search API) for candidate images.
   - **`draft_toolspec`** — LLM reads OCI labels / registry description / README
     and drafts a `ToolSpec`: image (digest-pinned), bridge pattern
     (`http`/`file`/`acp`/`cdp`), param mapping, run command, and derived
     `allowedEgress`. Prefers a credential-free design.
   - **`probe_tool`** — spawn the drafted tool as a sidecar job in the tightest
     sandbox (§3.6) with a synthetic smoke input; assert a well-formed result and
     no off-allowlist egress.
   - Probe success → `register_tool` (scope: discovering group, provenance
     `discovered`). Failure → bounded revise/retry, else fall back down the tiers
     and report `unavailable` rather than expose something broken.

A hard cap on TSA rounds plus a wall-clock timeout bound the work. The
channel's `find_tools` call blocks with a generous timeout (the discovery path
can legitimately take a while) and receives a clear failure if exceeded.

### 3.5 Security / credential gate

- **Selection + execution are autonomous.** Any image (including discovered) can
  be drafted, probed, and registered without a human, because the sandbox is the
  safety boundary: no privilege, hardened securityContext, default-deny egress,
  digest pinning, resource caps, group-scoped ACL.
- **Credential binding is the one gate, approved in-channel by the user.** When
  the TSA determines a selected tool needs a broker credential, `find_tools`
  returns a **`pending_credential`** result describing what is needed and why
  ("the image-search tool needs your Brave Search API key — allow it?"). The
  channel LLM relays it; on the user's "yes" the channel calls a follow-up
  (`approve_tool_credential` / re-invoke with an approval token), and the
  orchestrator then binds the credential and completes registration.
- **The raw secret never reaches the tool.** Approval authorizes the existing
  credential broker (`src/credential-broker/`, Envoy `ext_authz`) to *stamp* that
  credential's header on the tool's egress. The user approves *use*; the tool pod
  never sees the key.
- **Scope of approval:** binding a credential the broker **already holds**
  (catalog entries like `brave-search`) is an in-channel yes/no. Supplying a
  brand-new secret the system does not have remains an **admin task** — out of
  scope for the autonomous path (documented boundary, not a feature).

### 3.6 Network containment

- **Per-tool egress allowlist:** new `allowedEgress` field on `ToolSpec` (list of
  FQDNs/ports). A tool may only reach hosts it declares; everything else is
  **default-deny**, including DNS exfiltration. The TSA derives the allowlist when
  drafting a `ToolSpec` (an EXIF tool declares none; an image-fetch tool declares
  its one search host); the probe verifies it.
- **Egress ↔ credential coherence (enforced):** if a tool binds credential `X`
  (catalog host `api.search.brave.com`), its `allowedEgress` must be a subset of
  that host. The TSA cannot open egress to an arbitrary host *and* stamp a
  credential — closing the exfil-with-credentials path.
- **Enforcement substrate (substrate-agnostic):** `allowedEgress` renders to the
  strongest mechanism the cluster supports — Cilium `toFQDNs` (also mediates DNS)
  if `ciliumNetworkPolicy.enabled`, else Istio egress-gateway `ServiceEntry`/
  `Sidecar` in `istio` mode. Plain `NetworkPolicy` is CIDR-based (no FQDNs), so it
  is best-effort only.
- **Hard gate on tier-3:** open discovery of untrusted images is **disabled
  unless a hard egress-enforcement substrate (Cilium or Istio) is present**.
  Without it, `find_tools` falls back to vetted tiers and reports the limitation.
  Vetted tiers (catalog/library) still run under whatever substrate is available,
  as today.
- **Probe sandbox = tightest of all:** during `probe_tool` the pod runs
  default-deny egress except the single declared host, with full securityContext
  hardening. Any off-allowlist egress attempt fails the probe / flags for review —
  a behavioral check on untrusted images.
- **SecurityContext hardening:** auto-acquired tool pods get hardened defaults the
  repo does not currently apply to tool pods: `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` (with the
  existing `/work` + `/shared` mounts writable), `capabilities.drop: [ALL]`,
  `seccompProfile: RuntimeDefault` — matching the orchestrator/credential-broker.
- **Bug fix (prerequisite):** the `sidecar`/`istio` NetworkPolicies currently
  select a dead label `app: kubeclaw-tool-pod` instead of the real
  `app: kubeclaw-sidecar-tool` (`helm/kubeclaw/templates/networkpolicies-injection.yaml`,
  `networkpolicies-istio.yaml`). Those egress rules may not be binding the real
  pods. Fix as part of this work, since the feature relies on these policies
  actually applying.

## 4. Persistence & Lifecycle

- Verified tools are written to the catalog via the existing reconciler +
  SQLite-overrides path (tools analog of `src/specialists/reconciler.ts` →
  ConfigMap), surviving restarts and appearing as tier-1 next time.
- Per auto-acquired tool, store: `provenance` (`catalog` | `library` |
  `discovered`), source image digest, discovering group, `acquiredAt`,
  `lastUsedAt`, and the draft + probe transcript (for audit).
- **TTL / GC:** a periodic sweep (`src/task-scheduler.ts`) prunes auto-acquired
  tools whose `lastUsedAt` exceeds a configurable TTL. Baseline catalog and
  curated-library tools are exempt. Pruning removes the tool's ConfigMap entry.
- **Scope (tier-dependent):** catalog/library tools are global; `discovered`
  tools are scoped to the discovering group, broadened to global only by explicit
  human promotion.

## 5. Curated Library Authoring

- A new section in `helm/kubeclaw/values.yaml`, sibling to the baseline tool
  catalog, each entry a full `ToolSpec` marked `available: false` (inactive). The
  reconciler merges Helm baseline + SQLite overrides as today; "activation" flips
  it into the live catalog.
- Seed it with the gaps the motivating workflow needs — an image-fetch/search
  tool and an `exiftool`/ImageMagick metadata tool — so a fresh install reaches
  **tier-2**, not tier-3. Discovery remains the safety net.

## 6. Testing

Per repo policy, all three levels:

- **Unit:** tier-matching/ranking logic; `draft_toolspec` schema validation;
  provenance/TTL bookkeeping; credential-gate state machine (autonomous vs
  `pending_credential` vs approved); tier-dependent scope assignment;
  egress↔credential coherence check; `allowedEgress` → policy rendering per
  substrate. External registry + LLM stubbed.
- **Integration:** TSA loop against a real in-process catalog/reconciler + fake
  registry; `probe_tool` against a real sidecar job in a test namespace (smoke a
  known-good image; assert a known-bad draft is rejected and falls back; assert an
  off-allowlist egress attempt fails the probe); `find_tools` Redis
  request/result round-trip through the IPC watcher; in-channel credential
  approval round-trip (pending → user-approve → bound); tier-3 hard-gate (no
  Cilium/Istio → discovery disabled, falls back).
- **E2e:** full motivating workflow through a channel against minikube —
  `find_tools` → provision image-fetch (tier-2) → save to group PVC →
  `find_tools` → provision `exiftool` → read same PVC → metadata reported. Plus a
  discovery-path e2e (tiers 1–2 forced empty, hard egress substrate present) and a
  credential-gated path asserting the turn pauses for in-channel user approval.
  (Live e2e needs the 8Gi minikube — runs on CI, not the dev host, per the known
  memory constraint.)

## 7. Out of Scope / Boundaries

- Supplying brand-new secrets the broker does not already hold (remains an admin
  task).
- Global promotion of discovered tools (explicit human action, not automated).
- Tier-3 discovery on clusters without Cilium or Istio egress enforcement
  (disabled by design).
- Embedding/vector search for tool matching (LLM reasoning over the small catalog
  is sufficient at current scale; revisit if the library grows large).
