# Capability Base Generalization (SP1) — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Builds on:** the unified capability subsystem (`src/capabilities/*`): a `CapabilitySpec`
discriminated union (`mcp` / `http` / `rag`), thin per-kind builders over the shared
`renderDeploymentAndService` in `builders/common.ts`, a reconciler that applies
Deployment + Service + optional PVC, and channel discovery via `specToDiscoveryEntry`.

## Where this fits (decomposition)

This is the first of a sequenced set of sub-projects that generalize the capability
system so RAG backends are optional/installable and other capability shapes (voice
transcription, document parsing, databases) become first-class. Each sub-project is
its own spec → plan → implement → review cycle.

```
SP1  Capability base generalization      ← THIS SPEC (foundation, no RAG/LLM-path changes)
       probes (http|tcp + timing/startup)
       endpoint scheme/protocol
       scheduling (GPU / nodeSelector / tolerations)
       pod security overrides (fsGroup / runAsUser)
SP2  Config-driven RAG + Qdrant install + retrieval wiring   (the original ask)
SP3  Inbound-preprocessor framework + voice transcription
SP4  Capability composition (doc-parse → rag)   (optional, later)
```

SP1 deliberately changes **only the deployment/infra layer**. It does not touch RAG,
providers, the preprocessor seam, Qdrant relocation, or the LLM path.

## Problem

The capability deployment layer hardcodes assumptions that block whole classes of
capability the project wants to support:

1. **HTTP-only health checks.** `renderDeploymentAndService` emits `httpGet` readiness
   and liveness probes with fixed timings (readiness `initialDelaySeconds: 5` /
   `periodSeconds: 10`; liveness `initialDelaySeconds: 15` / `periodSeconds: 30`). The
   spec exposes only `healthPath`. A TCP service such as **Postgres** (wire protocol on
   5432, no HTTP endpoint) can never pass a probe, so it can never become `Ready`.
2. **Fixed probe timing.** A capability that loads a large model at startup (Whisper,
   layout-detection document parsers) can take minutes to become serviceable; the fixed
   liveness probe will restart-loop it before it finishes warming.
3. **`http://`-only discovery endpoints.** `endpointFor` hardcodes the `http` scheme, so
   a non-HTTP consumer cannot be handed a correctly-schemed endpoint.
4. **No scheduling controls.** `CapabilityBase` has no `nodeSelector`, `tolerations`,
   `runtimeClassName`, or GPU resource. GPU-backed capabilities (transcription, ML
   document parsing) cannot be placed on accelerated nodes.
5. **No pod-level security overrides.** `common.ts` hardcodes a container security
   context (`runAsUser: 1000`, `runAsNonRoot: true`) and sets **no pod-level `fsGroup`**.
   A stateful image cannot own its mounted PVC volume without `fsGroup` — the existing
   Helm Qdrant template had to set `fsGroup: 1000` for exactly this reason — and some
   official images (e.g. Postgres) run as a fixed non-1000 UID.

## Goal

Make the capability deployment layer able to run **non-HTTP**, **scheduled/accelerated**,
**slow-starting**, and **stateful-with-volume** services, driven entirely by spec data,
with **zero behavioural change** to any capability that does not opt in. Success
criterion: a `tcp`-probed, slow-warming capability declared in a spec reaches `Ready`
in-cluster, and a GPU/scheduling-annotated spec renders the correct pod placement.

## Decisions (answered during brainstorming)

- **`healthPath` retained as a deprecated alias.** When the new `probe` block is absent,
  behaviour is byte-for-byte identical to today using `healthPath`. No migration of
  existing persisted specs.
- **GPU as a dedicated `gpu?: number`** on `CapabilityResources` (renders
  `nvidia.com/gpu`), not a generic `extendedResources` map. The narrow, ergonomic field
  covers the real need; a generic map can be added later if a second accelerator type
  appears.
- **`podSecurity` / `fsGroup` is in SP1 scope.** It was not in the original gap list but
  Postgres (and any stateful capability with a PVC) cannot function without it, so it
  belongs in the foundation.

## Design

All field additions are **optional** on `CapabilityBase` / `CapabilityResources`. When
omitted, the rendered YAML is identical to today (guarded by regression tests).

### 1. Probes — `CapabilityBase` + `builders/common.ts`

New optional `probe` block:

```ts
interface ProbeConfig {
  type?: 'http' | 'tcp';          // default 'http'
  path?: string;                   // http only; default '/health'
  port?: number;                   // default = container port
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  timeoutSeconds?: number;
  startup?: {                      // optional startupProbe — guards liveness during warm-up
    initialDelaySeconds?: number;
    periodSeconds?: number;
    failureThreshold?: number;
  };
}
```

Rendering rules in `renderDeploymentAndService`:

- `type: 'http'` (default) → `httpGet` readiness + liveness, as today.
- **Timing semantics:** a supplied timing field (`initialDelaySeconds`, `periodSeconds`,
  `failureThreshold`, `timeoutSeconds`) applies to **both** the readiness and liveness
  probes. Any field left unset retains its current per-probe default (readiness
  `initialDelaySeconds: 5` / `periodSeconds: 10`; liveness `initialDelaySeconds: 15` /
  `periodSeconds: 30`) — so the two probes only diverge when untouched. Slow warm-up is
  better handled by `startup` than by inflating these.
- `type: 'tcp'` → `tcpSocket: { port }` for readiness + liveness; `path` ignored.
- `startup` present → render a K8s `startupProbe` (same probe target as readiness) so
  liveness/readiness do not begin counting failures until warm-up completes.
- **Back-compat:** `probe` absent → derive an HTTP probe from `healthPath` exactly as
  today. `healthPath` is marked `@deprecated` in favour of `probe.path` but continues to
  work indefinitely.

### 2. Endpoint scheme — `CapabilityBase` + `registry.ts`

Add `endpointScheme?: string` (default `'http'`). `endpointFor` becomes
`${scheme}://${deploymentName(name)}:${port}`. The discovery entry's `endpoint` string
then carries the correct scheme (e.g. `postgresql://kubeclaw-cap-maindb:5432`). No
changes to the discovery-entry union shape — the scheme lives inside the existing
`endpoint` string. Existing capabilities default to `http` and are unaffected.

### 3. Scheduling — `CapabilityBase` + `CapabilityResources` + `common.ts`

```ts
// CapabilityBase
scheduling?: {
  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, unknown>>;  // raw K8s toleration objects
  runtimeClassName?: string;                       // e.g. 'nvidia'
};

// CapabilityResources
gpu?: number;   // renders nvidia.com/gpu: N into BOTH requests and limits
```

`renderDeploymentAndService` emits `spec.template.spec.nodeSelector`, `.tolerations`,
and `.runtimeClassName` blocks only when present; `nvidia.com/gpu` is added to the
container `resources.requests` and `.limits` only when `gpu` is set. All blocks are
absent (no diff) when the fields are omitted.

### 4. Pod security overrides — `CapabilityBase` + `common.ts`

```ts
podSecurity?: {
  runAsUser?: number;
  runAsGroup?: number;
  fsGroup?: number;
  runAsNonRoot?: boolean;
};
```

- `fsGroup` renders a pod-level `securityContext.fsGroup` (enables PVC volume ownership
  for stateful images).
- `runAsUser` / `runAsGroup` / `runAsNonRoot` override the container-level defaults
  (currently hardcoded `1000` / `1000` / `true`).
- Omitted → exactly today's hardcoded container security context, no pod-level
  `securityContext`.

### 5. Builder threading — `builders/common.ts`, `mcp.ts`, `http.ts`, `rag-qdrant.ts`, `rag-lightrag.ts`

`CommonRenderArgs` gains `probe`, `scheduling`, `podSecurity`, and `gpu` (the last via
the existing `resources` arg). Each per-kind builder forwards the new fields from its
spec. The builders remain thin pass-throughs; SP2 will collapse the near-identical
builders, so SP1 leaves their structure alone to stay scoped.

## Back-compat & migration

- No persisted-spec migration. Existing `mcp`/`http`/`rag` specs in SQLite render
  identically because every new field is optional and defaults reproduce current output.
- `healthPath` continues to work as a deprecated alias.
- No Helm or discovery-shape changes (the scheme is carried inside the existing endpoint
  string).

## Tests (three levels)

**Unit — `builders/common.test.ts` and per-kind builder tests:**
- `type: 'tcp'` renders `tcpSocket` (not `httpGet`) for readiness + liveness.
- `startup` renders a `startupProbe`.
- Probe timing overrides apply; defaults unchanged when omitted.
- `gpu: N` renders `nvidia.com/gpu: N` in both requests and limits.
- `nodeSelector` / `tolerations` / `runtimeClassName` render when set, absent when not.
- `podSecurity.fsGroup` renders pod-level `securityContext.fsGroup`; `runAsUser` etc.
  override container defaults.
- **Regression:** a `healthPath`-only spec (no `probe`) renders byte-identical to the
  pre-change output (snapshot), and a fully-default spec is unchanged.
- `endpointFor` returns the scheme-prefixed endpoint; defaults to `http://`.

**Integration — reconciler + registry:**
- Installing specs with `tcp` probe + `gpu` + `scheduling` + `podSecurity` through the
  reconciler produces YAML that parses into valid K8s `Deployment` / `Service` /
  `PersistentVolumeClaim` objects (parse with the k8s yaml loader; assert structure).
- Discovery round-trips the scheme-prefixed endpoint for a non-`http` `endpointScheme`.

**E2E — minikube:**
- Deploy a minimal **TCP** capability (a small Postgres or Redis image) via the install
  path and assert the pod reaches `Ready` through the `tcpSocket` probe — proving
  non-HTTP capabilities work end to end. No LLM/agent path is involved (that begins in
  SP2); this e2e validates the deployment layer only.

## Out of scope (deferred to later sub-projects)

- RAG generalization, provider adapters, embedding-on-spec (SP2).
- Removing the Helm-baked Qdrant StatefulSet and installing Qdrant as a capability (SP2).
- Wiring retrieval (`augmentPrompt`) into the agent loop (SP2).
- The general inbound-preprocessor framework and voice transcription (SP3).
- Capability-feeds-capability composition, e.g. doc-parse → rag (SP4).
- Credential brokering for non-HTTP services (Postgres uses `envFromSecrets` /
  `credentialsFrom: 'secret'`; the HTTP-only Envoy ext_authz broker does not apply).
- Collapsing the near-identical per-kind builders (SP2).
