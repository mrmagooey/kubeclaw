# Per-group user-supplied credentials for the credential injection system

**Date:** 2026-05-16
**Status:** Design — awaiting spec-review gate before implementation plan
**Relates to:** `docs/CREDENTIAL_INJECTION.md`, `docs/superpowers/specs/2026-05-13-istio-tls-origination-and-egress-e2e-design.md`

## Problem

The credential injection system today serves a fixed, operator-provisioned set of upstream credentials. The four built-in destinations (Anthropic, OpenAI, OpenRouter, Voyage) have their API keys baked into `kubeclaw-secrets` via Helm values; their broker mappings are hard-coded in `helm/kubeclaw/templates/credential-broker-config.yaml`. Adding a new third-party API requires an operator to edit chart templates, run `helm upgrade`, and possibly restart pods.

End users interacting with the assistant through a channel (HTTP, IRC, oauth-webchat) have no way to bring their own credentials into the running system. The system can call only the APIs the operator has pre-keyed. A user who wants the assistant to use a new third-party API (Replicate, Mistral, a personal MCP, an internal corporate API) cannot make that happen without operator intervention.

Two further constraints shape the design:

1. **The "workload never holds the credential" invariant must be preserved.** The whole purpose of the credential injection subsystem is to prevent prompt-injected workloads from exfiltrating secrets via `cat $ANTHROPIC_API_KEY` and similar reads.
2. **Credentials don't all fit the `Authorization: Bearer <token>` mould.** Future use cases include HTTP Basic auth (Jenkins, internal services), custom header schemes (`X-API-Key:`), credentials that go in request bodies (form fields, JSON properties, signed payloads), and cookie-based authentication. The system should accommodate these without a per-scheme rewrite.

## Goal

End users can register API credentials for their group via a chat-resident slash command. Subsequent tool-job calls to authorized destinations transparently use those credentials. The user's cleartext credential traverses one pod (the channel-runner) for one IPC round trip and is never visible to any LLM, any tool-job, or any log. The credential's final injection mechanism is generalized: any string in the outbound HTTP request — header, body, URL, cookie — can be the substitution site, scoped to operator-curated destinations.

## Non-goals

- No support for browser-form login or any flow that requires a real browser engine in v1. The substitution mechanism is forward-compatible with such a flow (Playwright tool-jobs would use placeholders in form fields) but the Playwright tool-job kind and its dependencies are deferred to v1.1.
- No support for credentials that require computation (HMAC-signed bodies, AWS SigV4, OAuth1, JWT signing). String substitution does not solve these; they need a separate per-scheme path. Out of scope.
- No external secret-store integration (HashiCorp Vault, AWS Secrets Manager, etc.). The catalog schema's per-field shape is forward-compatible with a `sourceType: vault` extension but no such backend exists in v1.
- No per-end-user identity (`channel + chat-id`). Owner-group is the isolation unit. Two users sharing a group transitively share each other's registered credentials by virtue of already sharing memory and CLAUDE.md.
- No channel-LLM-call per-group key resolution. Channels (`kubeclaw-channel-*` SAs) keep using operator keys from `kubeclaw-secrets`. Per-group keys apply only to tool-job (`sa/kubeclaw-tool-job`) upstream calls. This narrows the implementation surface and avoids plumbing per-message owner-group through long-lived channel pods.
- No `/secret rotate` command. Rotation is `/secret remove` followed by `/secret add`. Any in-flight tool-job using the old credential fails closed.
- No automated cleanup of orphan per-group Secret data when an operator removes a catalog entry that groups had credentials for. Operators communicate removals out-of-band; orphan data is cosmetic only and harmless.

## Design

### Architecture

```
OPERATOR ──> Helm values ──> kubeclaw-secrets          (built-in operator keys, unchanged)
OPERATOR ──> Helm values ──> CATALOG ConfigMap         (operator-curated destinations + credentialFields)
─────────────────────────────────────────────────────────────────────────────────────────
END USER ──> /secret add jenkins user=alice password=hunter2
            channel-runner intercepts upstream of LLM
                  │ Redis IPC (existing channel→orchestrator path)
                  ▼
            ORCHESTRATOR
                  ├─ validate against catalog
                  ├─ generate one high-entropy placeholder PER FIELD (≥256-bit hex)
                  ├─ persist to K8s Secret kubeclaw-group-secrets-<group>:
                  │    data["jenkins"] = JSON({
                  │      fields: { user:     { value: "alice",   placeholder: "KC_PH_u_..." },
                  │                password: { value: "hunter2", placeholder: "KC_PH_p_..." } },
                  │      registeredAt: "2026-05-16T..." })
                  ├─ insert SYSTEM event into transcript memory (no value, ever)
                  └─ ack on IPC reply queue
                                  │
                                  ▼ K8s Secret informer fires
            BROKER
                  └─ substitution map: (group, host, placeholder) → real value
─────────────────────────────────────────────────────────────────────────────────────────
TOOL-JOB pod created (orchestrator):
  reads per-group Secret + catalog, stamps envs:
    JENKINS_USER     = KC_PH_u_<entropy>     (placeholder, not real value)
    JENKINS_PASSWORD = KC_PH_p_<entropy>
    JENKINS_URL      = http://jenkins.example.com   (from catalog baseUrlEnvs)
  stamps annotation: kubeclaw.io/owner-group: family
─────────────────────────────────────────────────────────────────────────────────────────
Request-time (workload SDK in tool-job):
  Python in tool-job → requests.Session(auth=(env["JENKINS_USER"], env["JENKINS_PASSWORD"]))
                    → POST http://jenkins.example.com/api/...
        │
        ▼
  Envoy sidecar (mode=sidecar) OR istio egress GW (mode=istio)
        │ ext_authz POST /authz   ──► BROKER:
        │   identity:
        │     sidecar: TokenReview → pod UID from token extras → read pod → owner-group annotation
        │     istio:   parse XFCC SPIFFE; src IP → pod-informer lookup (A1 mitigations)
        │   resolution:
        │     match host against catalog; reject if unmapped
        │     emit substitution map for (group, host) → list of authorized (placeholder, value)
        │   return: 200 + two response headers:
        │     x-kubeclaw-substitutions: <placeholder>=<base64-value>;<placeholder>=<base64-value>;...
        │     x-kubeclaw-policy: positions=header,body;per=10;total=50
        │
        ▼
  Envoy Lua filter (colocated; new):
        - reads x-kubeclaw-substitutions and x-kubeclaw-policy headers
        - skip body scan if Content-Type binary or body > 1MB
        - inline replace each placeholder → real value in request body and headers
        - enforce substitution counter limits (default: ≤10 per individual placeholder; ≤50 total per request)
        - strip both x-kubeclaw-substitutions and x-kubeclaw-policy headers before sending upstream
        │
        ▼
  Upstream (jenkins.example.com:8080) — receives request with real cleartext credential
                                         in the position(s) the workload chose
```

### Trust boundaries

| Component | Role w.r.t. cleartext credential |
|---|---|
| **Broker** | Sole long-term holder. Reads per-group Secrets via namespace-wide RBAC (A.1). Composes substitution maps at request time. Never proxies the request body itself. |
| **Orchestrator** | Generates placeholders at `/secret add` time. Writes per-group Secrets. Stamps envs and annotations on tool-job pods at pod-create time. Holds cleartext for ~milliseconds during `setGroupSecret`. |
| **Channel-runner** | Receives raw `/secret add` line from user transport. Forwards cleartext over Redis IPC to orchestrator. Heap residency ~milliseconds; zeroed in `finally` block. Inserts system event into transcript memory; raw user line is dropped entirely (not redacted). |
| **Tool-job** | Holds placeholder strings only — never the real value. Composes outbound requests using placeholders. Lua filter at egress substitutes. The workload's pre-substitution request contains literal placeholder text, which is not the credential. |
| **LLM (channel-runner-driven)** | Never sees `/secret add` line. Sees: system event describing what was registered (catalog ID, host, env var names, instructions). Sees: results of `list_credentials` tool calls (metadata only). Sees: failure context when tool-job requests are rejected (`no_credential`, `unknown_destination`, etc.) with operator-defined hints. |
| **Envoy Lua filter** | Receives substitution map in `x-kubeclaw-substitutions` header and policy constraints in `x-kubeclaw-policy` header, applies inline string replacement, strips both headers before upstream send. Co-located in Envoy; substitution map lives in filter context only for the request lifetime. |

### Security invariants

1. **Cleartext never enters LLM context.** The user's raw `/secret add` line is removed from transcript memory in `channel-runner.ts` before any LLM call. Backstop regex (Section "Error handling — command-interception safety") scrubs lines matching known credential patterns even if the parser misses.
2. **Cleartext never enters tool-job memory.** Tool-jobs receive placeholder envs only. The Lua filter substitutes after the workload has emitted bytes.
3. **Substitution is gated by destination authorization.** Even if a workload exfiltrates a placeholder to an unauthorized destination, the broker does not provide a substitution map for that destination, so the placeholder traverses to the attacker as literal text.
4. **Substitution is gated by owner-group.** The orchestrator stamps `kubeclaw.io/owner-group: <group>` on tool-job pods at create time. The broker resolves this from the K8s API (sidecar: TokenReview extras; istio: pod-IP-lookup with A1 mitigations). Workloads cannot forge an annotation.

### Catalog schema

The catalog lives in the existing `kubeclaw-credential-broker-config` ConfigMap, alongside today's `mappings:` section (which is retained unchanged for the four built-in destinations).

```yaml
catalog:
  - id: replicate                        # unique catalog identifier; user-visible
    host: api.replicate.com              # exact destination hostname
    upstreamPort: 443                    # TLS origination port (default 443)
    credentialFields:
      - { name: "token", envVar: "REPLICATE_API_TOKEN" }
    baseUrlEnvs:                         # http:// overrides for SDKs in mode=istio
      REPLICATE_API_URL: "http://api.replicate.com"
    allowOperatorFallback: false         # if true, kubeclaw-secrets[<id>] is used when no per-group key
    allowedPositions: [header, body]     # where substitution may occur (default: both)
    apiKeyShape:                         # for backstop regex (optional)
      prefix: "r8_"
      minLength: 30

  - id: jenkins
    host: jenkins.example.com
    upstreamPort: 8080
    credentialFields:
      - { name: "user",     envVar: "JENKINS_USER" }
      - { name: "password", envVar: "JENKINS_PASSWORD" }
    baseUrlEnvs:
      JENKINS_URL: "http://jenkins.example.com"
    allowOperatorFallback: false
    allowedPositions: [header, body]     # Basic auth, but workload could also use form login
```

The schema deliberately omits `headerScheme` and any header-format declaration. The broker does not compose headers — it only returns substitution pairs. The workload, using idiomatic SDK code, composes the request in whatever shape the destination expects; Envoy's Lua filter substitutes the placeholders inline.

`allowedPositions` is the operator's lever to constrain where the substitution may occur:
- `[header]` — substitute only in HTTP request headers. Rejects requests that contain the placeholder in the body or URL.
- `[body]` — substitute only in the request body. Rejects header-position substitution.
- `[header, body]` — default; substitute anywhere.

The substitution counter (constant for v1; configurable in a follow-up) refuses requests where any single placeholder appears more than 10 times *or* total substitutions across all placeholders exceed 50. This catches workloads attempting flood-write exfil patterns; legitimate requests rarely need more than a few substitutions.

### Storage model

Per-group K8s Secrets, one per group, named `kubeclaw-group-secrets-<group>`, with label `kubeclaw.io/group-secrets=true` for broker informer selector. The Secret's `data` map keys are catalog IDs; each value is a JSON blob:

```json
{
  "fields": {
    "user":     { "value": "alice",   "placeholder": "KC_PH_u_<64 hex chars>" },
    "password": { "value": "hunter2", "placeholder": "KC_PH_p_<64 hex chars>" }
  },
  "registeredAt": "2026-05-16T14:22:11Z"
}
```

The JSON blob is the unit of atomic update. `/secret add <id> ...` rewrites the entire `data[<id>]` entry. `/secret remove <id>` patches the Secret to remove the `data[<id>]` key (and deletes the Secret if it was the last entry, to keep `kubectl get secret` tidy on group churn).

Per-field placeholders (rather than one per credential) accommodate flows where the fields are used in different positions of the same request — typing into separate form inputs, sending as separate headers, embedding in different JSON properties. Single-field credentials (`bearer`-style) trivially use this with one placeholder.

#### Operator-fallback env stamping

For catalog entries with `allowOperatorFallback: true` (single-field only), tool-job pods belonging to groups that have *not* registered their own credential are stamped with the static sentinel `KC_PH_FALLBACK_<catalogId>` as the env value for that entry. The sentinel is stable across all such pods and groups (it does not encode group identity). At request time, the broker resolver maps this sentinel to the operator's value from `kubeclaw-secrets.data["<catalogId>"]`. Information disclosure: an attacker who exfiltrates the sentinel learns only that the operator has configured fallback for this entry — operator-curated metadata that is not itself sensitive.

For catalog entries with `allowOperatorFallback: false` (and for groups that have not registered for an entry that allows fallback only with the per-group route disabled), tool-job pods are stamped with the literal sentinel `injected-by-broker` for compatibility with SDKs that enforce client-side key presence. The broker does not substitute this literal; requests pass it through to upstream and fail at the upstream's authentication check. Fail-closed.

Placeholder format: `KC_PH_<short field-name token>_<64 hex chars>`. The `KC_PH_` prefix makes them greppable in logs and in workload pod env (operator can grep `env` output to see which placeholders a pod carries). The 256-bit entropy makes accidental collision with real request content vanishingly unlikely.

### RBAC

| ServiceAccount | Changes vs. today |
|---|---|
| `kubeclaw-credential-broker` | Role widens from `resources: ["secrets"], verbs: ["get"], resourceNames: ["kubeclaw-secrets"]` to `resources: ["secrets"], verbs: ["get", "list", "watch"]` namespace-wide in `kubeclaw`. Trust widening: broker pod can now technically read `kubeclaw-redis`, per-channel HTTP secrets, and the admin-shell password, even though its code never reads anything outside its allowlist. Documented as accepted risk; the trust boundary becomes "broker code is correct" rather than "broker RBAC is precisely scoped." Additionally adds `pods: get` namespace-wide (needed for owner-group annotation lookup in both modes). |
| `kubeclaw-orchestrator` | Adds `secrets: create, update, delete, get, list` namespace-wide. Existing role already has some Secret access for Redis password preservation; this extends it. |
| `kubeclaw-channel-*` | No change. Channels send IPC; they do not touch Secrets directly. |

### Identity propagation

The broker derives a request's owner-group from the tool-job pod's annotation `kubeclaw.io/owner-group: <group>`, stamped by the orchestrator at pod-create time. Resolution differs by mode:

**Mode=sidecar.** The workload's Envoy sidecar attaches the projected SA token (audience: `kubeclaw-credential-broker`) on its `POST /authz` call. The broker performs `TokenReview`. The response's `user.extra` map carries `authentication.kubernetes.io/pod-uid` and `authentication.kubernetes.io/pod-name`. The broker `get`s the pod by uid (via informer cache) and reads its annotation. No race: the token was issued by the kubelet for a specific pod-uid, and the broker cross-references against the live pod by that uid.

**Mode=istio.** The istio egress gateway's `ext_authz` request includes the workload's `x-forwarded-client-cert` (XFCC) with a SPIFFE URI (`spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job`) and a `source.address` with the workload pod's IP. The SPIFFE URI alone identifies only the SA, not the pod. The broker queries its in-process pod informer (label-selected to `kubeclaw-pod=true` or all pods in the namespace) for the pod currently bearing that source IP. A1 mitigations are applied:

1. **Reject lookups against `Terminating` pods.** A pod whose `.metadata.deletionTimestamp` is set may be moments away from its IP being recycled; the broker returns `403 pod_terminating`.
2. **Cross-check `.status.podIP`.** The looked-up pod's recorded podIP must match the request's source IP exactly. Catches stale-cache cases where the informer hasn't fired the delete event yet.
3. **Informer with periodic resync.** Pod informer resyncs every 30 seconds; the in-memory cache lags only by the resync interval and immediate watch events.

Residual race: in the window between a pod's IP being recycled and the broker's informer learning of the delete, a request from the *new* pod (different owner-group) could be mapped to the *old* pod's annotation. Probability: tiny on real clusters. Impact: a single request fails (broker returns wrong group's credentials → upstream rejects → workload retries → second request succeeds because informer has caught up) or succeeds with wrong-group credentials (potential cross-group credential use for one request). Mitigation beyond A1 is the `A2` signed binding token, deferred to a follow-up if the race is observed to bite.

If the pod is found but lacks the `kubeclaw.io/owner-group` annotation (e.g., legacy pod, pod created outside the orchestrator), the broker behaves as follows:
- If the matched catalog entry has `allowOperatorFallback: true` and operator key exists in `kubeclaw-secrets`: substitute the operator key, log a warning.
- Otherwise: `403 no_owner_group`.

### Resolution semantics

Given an authz request with `(callerSA, ownerGroup, host)`:

1. Lookup `host` in catalog. If absent, look in legacy `mappings:` (built-ins). If still absent: `403 unknown_destination`.
2. If caller SA is not `sa/kubeclaw-tool-job` (i.e., the request is from a channel or capability pod): use today's behaviour — return the operator's key from `kubeclaw-secrets`, no per-group resolution. Channels are out of scope for per-group keys (C2).
3. For tool-job calls: load per-group Secret `kubeclaw-group-secrets-<ownerGroup>` from informer cache.
   - If a `data[<catalogId>]` entry exists: return substitution map built from that entry's fields (`placeholder → value` for each field). `keySource: groupSecret`.
   - Else if catalog entry has `allowOperatorFallback: true` (constrained at schema-parse time to single-field entries) and `kubeclaw-secrets.data["<catalogId>"]` exists: return substitution map mapping the operator-fallback sentinel `KC_PH_FALLBACK_<catalogId>` to the operator's value. `keySource: operatorFallback`. The orchestrator stamps this same sentinel as the env value on tool-job pods belonging to groups that have not registered their own credential for the entry — see "Operator-fallback env stamping" below.
   - Else: `403 no_credential` with structured hint `{ catalogId, registerHint: "/secret add <id> ..." }`.
4. Apply substitution-policy gates (`allowedPositions`, counter). Reject as appropriate.

### Slash command surface

| Command | Behaviour |
|---|---|
| `/secret add <id> <value>` | Single-field shorthand. Equivalent to `/secret add <id> <field>=<value>` where `<field>` is the catalog entry's sole `credentialFields` name. |
| `/secret add <id> <field>=<value> [<field>=<value> ...]` | Multi-field form. Required fields validated against catalog; missing fields rejected with a list of expected names. |
| `/secret list` | List registered catalog IDs for the current group, with `registeredAt` timestamps. Never returns values. |
| `/secret remove <id>` | Remove the named credential. Pods created after this lose the envs for that catalog entry; in-flight pods using stale placeholders fail closed. |
| `/secret catalog` | List the full operator-curated catalog: which destinations exist, what fields they require. |
| `/secret help` | Render usage. |

Channel-runner intercepts these strictly upstream of any LLM call. The user's raw line is removed from transcript memory; a system event is inserted describing what happened (catalog ID, host, env var names that downstream tool-jobs will receive — never the value). The assistant's reply is a templated string generated by the channel-runner (the LLM never sees the command).

Coarse-regex backstop: independent of the slash-command parser, every inbound user message is scanned for lines containing strings matching known API-key shapes (catalog entries' `apiKeyShape` configuration drives this; defaults include `sk-[A-Za-z0-9]{20,}`, `Bearer\s+[A-Za-z0-9_\-\.]{20,}`, etc.). Any match is replaced with `[possible secret redacted]` before any LLM call. The backstop is intentionally conservative (high false-positive rate is acceptable; a false negative is the failure we are designing against).

### Tools exposed to the channel LLM

A new `list_credentials` tool is registered in the channel LLM's tool list at startup. Always available; takes no arguments; returns metadata only:

```json
[
  {
    "catalogId": "replicate",
    "host": "api.replicate.com",
    "fields": ["token"],
    "hasCredential": true,
    "registeredAt": "2026-05-16T..."
  },
  {
    "catalogId": "jenkins",
    "host": "jenkins.example.com",
    "fields": ["user", "password"],
    "hasCredential": false,
    "registeredAt": null
  }
]
```

Values are never present in the return shape — neither as cleartext, hash, last-4, nor preview. The orchestrator's `secret.list` IPC handler implements this as `Object.keys(secret.data)` plus the catalog merge; it never decodes secret values. The IPC payload over Redis carries metadata only.

Additionally, on each conversation turn, the channel-runner prepends a system message summarising available APIs and which have credentials registered for the current group. This provides the LLM with up-front context (option `ii` from the design discussion). The block is rebuilt fresh on each turn, so amendments from `/secret add` within the same conversation are reflected immediately. Cost is bounded by catalog size, which is operator-controlled.

Together: option `i` (LLM recovers from request-time `403 no_credential` with structured hints) plus option `ii` (system prompt block on each turn) plus the `list_credentials` tool give the LLM redundant ways to know what's available.

### Components

#### Chart templates

| File | Change |
|---|---|
| `helm/kubeclaw/templates/credential-broker-config.yaml` *(modify)* | Add `catalog:` section. Retain `mappings:` for built-ins. |
| `helm/kubeclaw/templates/credential-broker.yaml` *(modify)* | RBAC: drop `resourceNames` constraint; verbs become `get, list, watch` on Secrets namespace-wide. Add `pods: get` for owner-group annotation lookup. |
| `helm/kubeclaw/templates/orchestrator.yaml` *(modify)* | Add `secrets: create, update, delete, get, list` namespace-wide. |
| `helm/kubeclaw/templates/envoy-sidecar-config.yaml` *(modify)* | Add Lua filter for placeholder substitution in mode=sidecar. |
| `helm/kubeclaw/templates/istio-envoyfilter.yaml` *(modify)* | Add Lua filter for placeholder substitution in mode=istio. |
| `helm/kubeclaw/templates/_helpers.tpl` *(modify)* | `kubeclaw.istioBaseUrlEnv` (and sidecar counterpart) iterates the catalog plus built-ins, not the hard-coded four. |
| `helm/kubeclaw/templates/secrets.yaml` *(no change)* | Per-group Secrets are not chart-rendered. Created dynamically by the orchestrator. |

#### Broker (`src/credential-broker/`)

| File | Change |
|---|---|
| `config.ts` *(modify)* | Schema gains `catalog` array; legacy `mappings` retained. Validates `credentialFields`, `allowedPositions`, `allowOperatorFallback`. |
| `k8s-secret-source.ts` *(modify)* | Watcher changes from "read one named Secret" to "list/watch Secrets with label `kubeclaw.io/group-secrets=true` plus legacy `kubeclaw-secrets`." In-memory cache: `Map<groupName, Map<catalogId, { fields, registeredAt }>>` plus legacy `Map<string, string>` for `kubeclaw-secrets`. JSON-blob parser; rejects malformed entries with metric increment. |
| `resolver.ts` *(modify)* | Returns substitution map: `Array<{ placeholder, value }>`. Implements the four-step resolution semantics above. No template composition. |
| `identity.ts` *(modify)* | New `resolveOwnerGroup(podIdentity)`: TokenReview-extras path (sidecar) and IP-lookup path (istio with A1 mitigations). Returns `null` if no annotation. |
| `pod-informer.ts` *(new)* | k8s pod informer keyed by `(uid, podIP)`. Periodic resync 30s. Includes A1 mitigations. |
| `substitution-policy.ts` *(new)* | Enforces `allowedPositions` and per-request substitution counter. Position is determined by where Envoy's Lua filter found the match; the broker advises and the filter enforces (broker also validates upstream from cached request shape if available). |
| `audit.ts` *(modify)* | New fields: `ownerGroup`, `catalogId`, `keySource`, `substitutionsApplied` (count + position categories — never values). |
| `index.ts` *(modify)* | Wire `pod-informer`, `secret.list` IPC handler (if broker serves IPC; otherwise this lives in orchestrator — see below). |

#### Orchestrator (`src/`)

| File | Change |
|---|---|
| `k8s/job-runner.ts` *(modify)* | (a) Stamp annotation `kubeclaw.io/owner-group: <group>` on every tool-job pod. (b) Catalog-driven env substitution: iterate catalog entries, choosing env value per entry: registered → per-group high-entropy placeholder from the per-group Secret; unregistered with `allowOperatorFallback: true` → static sentinel `KC_PH_FALLBACK_<catalogId>`; unregistered without fallback → literal `injected-by-broker`. Stamp `baseUrlEnvs` unconditionally per catalog entry. (c) Mode=sidecar update: instead of stripping API key envs entirely (today's behavior), substitute with the per-entry value chosen above so SDKs that enforce client-side key presence construct successfully. |
| `k8s/secret-manager.ts` *(new)* | `setGroupSecret(group, catalogId, fields)`: validates against catalog, generates one placeholder per field via `crypto.randomBytes`, patches Secret. `deleteGroupSecret(group, catalogId)`: patches Secret to remove key; deletes Secret if last entry. `listGroupSecrets(group)`: returns names + `registeredAt` only. Includes input validation (catalog ID exists; values non-empty, length-bounded, no control chars). |
| `k8s/catalog.ts` *(new)* | ConfigMap informer for `kubeclaw-credential-broker-config`. Exposes `getCatalog()` and `getEntry(id)`. |
| `k8s/ipc-redis.ts` *(modify)* | New IPC message types: `secret.add`, `secret.remove`, `secret.list`, `catalog.list`. Orchestrator handles all four. |
| `index.ts` *(modify)* | Wire catalog informer at startup. Register IPC handlers. |

#### Channel-runner (`src/`)

| File | Change |
|---|---|
| `channel-runner.ts` *(modify)* | (a) `/secret` slash command parser placed upstream of LLM (same pattern as `/skills`). (b) On `add`: validate against catalog (via local IPC catalog query), strip the original user line from transcript memory, insert system event describing what was registered, send `secret.add` IPC to orchestrator, await ack with 5s timeout, render templated reply to user. (c) Implements coarse-regex backstop scanning every inbound user message. (d) Registers `list_credentials` tool in the channel LLM's tool list. (e) On each turn, prepends system-prompt block summarising catalog + registered keys. |
| `channel-runner.test.ts` *(extend)* | See "Tests at three levels" below. |

#### Tool definitions (`src/tools/`)

| File | Change |
|---|---|
| `list-credentials.ts` *(new)* | Channel-resident tool. Delegates to orchestrator via `secret.list` + `catalog.list` IPC. Returns metadata only. Tool description guides the LLM: "Use when user asks what's available, when a tool call fails with no_credential, or when you're unsure whether a destination is configured." |

#### Documentation

| File | Change |
|---|---|
| `docs/CREDENTIAL_INJECTION.md` *(modify)* | New section: "Per-group user-supplied secrets." Covers catalog schema, slash-command UX, placeholder/substitution mechanism, lifecycle, threat model summary. |
| `docs/SECURITY.md` *(modify)* | Threat-model entries: RBAC widening (A.1) accepted risk; istio IP-recycle race (A1) residual; workload-controls-position risk + mitigations (`allowedPositions`, counter, audit); channel-runner transient cleartext; backstop residual. |

### Data flow

#### Flow 1 — Operator publishes a new catalog entry

```
operator edits helm/kubeclaw/values.yaml → adds catalog entry → helm upgrade
   │
   ▼
ConfigMap kubeclaw-credential-broker-config gets new entry
   │
   ├──► Broker's ConfigMap informer fires
   │       resolver.ts adds entry to in-memory catalog table
   │
   └──► Orchestrator's catalog informer fires (catalog.ts)
           job-runner.ts will include the new entry's apiKeyEnvs (as placeholders for
           groups with registered creds, else "injected-by-broker"-style sentinel)
           and baseUrlEnvs in subsequent tool-job pod specs
```

No restart required. Pods already running unaffected; next tool-job has new envs.

#### Flow 2 — End-user adds a per-group secret

User types: `/secret add jenkins user=alice password=hunter2`

```
channel transport delivers raw line to channel-runner
   │
   ▼
channel-runner.ts (BEFORE any LLM call):
   ├── parse command → { catalogId: "jenkins", fields: { user: "alice", password: "hunter2" } }
   ├── validate catalogId against local catalog cache; required fields present
   ├── drop the raw user line entirely from transcript memory
   ├── publish Redis IPC: { type: "secret.add", group: <current>, catalogId, fields }
   ├── await ack with 5s timeout
   ├── on success: insert SYSTEM event into transcript:
   │     "[SYSTEM] User registered credential for catalog entry 'jenkins' (host: jenkins.example.com).
   │      Tool-jobs will receive envs JENKINS_USER and JENKINS_PASSWORD with placeholder values.
   │      The broker will substitute the real credential on outbound requests to jenkins.example.com."
   ├── append templated assistant turn (channel-runner generates; LLM does not):
   │     "Got it — Jenkins is now configured for this group."
   └── finally: zero local cleartext buffers
   │
   ▼
orchestrator (ipc-redis.ts handler):
   ├── validate catalogId exists; required fields match; values pass shape validation
   ├── secret-manager.setGroupSecret(group, "jenkins", { user: "alice", password: "hunter2" }):
   │     - generate placeholders: KC_PH_u_<entropy>, KC_PH_p_<entropy>
   │     - K8s API: get-or-create Secret kubeclaw-group-secrets-<group> with label kubeclaw.io/group-secrets=true
   │     - patch data["jenkins"] = JSON.stringify({ fields: {...}, registeredAt: now })
   ├── log audit: { ts, group, op: "secret.add", catalogId: "jenkins", success: true }   (no values)
   └── ack IPC reply
   │
   ▼
broker (k8s-secret-source.ts):
   informer fires on Secret update
   substitution-map cache updated:
     (group="family", host="jenkins.example.com", placeholder="KC_PH_u_<>") → "alice"
     (group="family", host="jenkins.example.com", placeholder="KC_PH_p_<>") → "hunter2"
```

Latency user-send to broker-ready: ~100–500ms. User sees confirmation before agent's next turn.

#### Flow 3 — Tool-job upstream request

Assume tool-job for group `family` has been spawned. Pod has annotation `kubeclaw.io/owner-group: family` and envs `JENKINS_USER=KC_PH_u_<>`, `JENKINS_PASSWORD=KC_PH_p_<>`.

```
Python in tool-job:
   import requests
   r = requests.get("http://jenkins.example.com/api/job/foo",
                    auth=(os.environ["JENKINS_USER"], os.environ["JENKINS_PASSWORD"]))
   # → request constructs Basic header from placeholders
   # → Authorization: Basic <base64(KC_PH_u_<>:KC_PH_p_<>)>
   │
   ▼
Mode=sidecar: HTTPS_PROXY=localhost:8443 routes via per-pod Envoy
Mode=istio:   workload's istio-proxy intercepts, wraps in mTLS, forwards to egress gateway
   │
   ▼
Envoy:
   ext_authz POST /authz to credential-broker.kubeclaw.svc:8080
   body: { source: { address: { ip }, principal: "...sa..." }, request: { http: { host, headers, path, body? } } }
   │
   ▼
broker /authz:
   ├── identify caller (sidecar: TokenReview → pod-uid → owner-group annotation;
   │                     istio: XFCC + source IP → pod-informer → annotation, A1 mitigations)
   ├── resolver.ts: lookup host "jenkins.example.com" in catalog → entry "jenkins"
   ├── load per-group Secret for "family"; get fields with placeholders/values
   ├── build substitution map:
   │     [{ placeholder: "KC_PH_u_<>", value: "alice" },
   │      { placeholder: "KC_PH_p_<>", value: "hunter2" }]
   ├── substitution-policy: catalog allowedPositions=[header,body] → permitted
   ├── audit log: { ts, ownerGroup: "family", catalogId: "jenkins",
   │                destination: "jenkins.example.com", keySource: "groupSecret",
   │                placeholderCount: 2 }
   └── 200 + two response headers in the OkResponse headers_to_add block:
         x-kubeclaw-substitutions: KC_PH_u_<>=<base64("alice")>;KC_PH_p_<>=<base64("hunter2")>
         x-kubeclaw-policy: positions=header,body;per=10;total=50
         (Two headers are used because Envoy's Lua sandbox does not support require('json'),
          making a single base64-encoded JSON blob impractical to decode in the filter.)
   │
   ▼
Envoy:
   - reads x-kubeclaw-substitutions (semicolon-delimited key=base64value pairs)
   - reads x-kubeclaw-policy (positions and counter limits)
   - Lua filter: parse pairs; check Content-Type (text/JSON/form OK; binary skip);
                 check body size ≤ 1MB; scan headers + body for each placeholder;
                 count substitutions (reject if > per or total limit); replace inline
   - strip x-kubeclaw-substitutions and x-kubeclaw-policy headers
   - in mode=istio: per-destination DestinationRule originates TLS to jenkins.example.com:8080
   - in mode=sidecar: Envoy independently originates TLS to upstream
   │
   ▼
upstream jenkins.example.com:8080:
   receives Authorization: Basic <base64("alice:hunter2")>
   normal application response
```

Workload memory never held cleartext. Logs at the broker contain identity + catalog ID + counts; no values.

#### Flow 4 — LLM invokes `list_credentials`

```
LLM emits tool_use { name: "list_credentials" }
   │
   ▼
channel-runner intercepts (tool is channel-resident; no tool-job spawned)
   ├── publish Redis IPC: secret.list { group } and catalog.list (parallel)
   ├── orchestrator returns: list of registered (catalogId, registeredAt) names; catalog
   └── merge → array of { catalogId, host, fields, hasCredential, registeredAt }
   │
   ▼
return as tool_result to LLM
```

Latency: a single Redis round-trip (~5ms). No K8s API hit; both informers cached.

### Error handling

#### Command-interception safety (most security-critical)

The `/secret add` parser is the load-bearing surface for keeping cleartext out of the LLM. Defenses, in order:

1. **Parser placement** — runs in the same upstream-of-LLM stage as `/skills`. Tests enforce ordering invariants.
2. **Coarse-regex backstop** — every inbound user message scanned for known credential patterns (catalog-driven via `apiKeyShape`, plus default patterns). Matches replaced with `[possible secret redacted]` before LLM call. Conservative on the false-positive side.
3. **Catalog declares key shape** — each entry optionally carries `apiKeyShape: { prefix, minLength }` which is compiled into a regex `<prefix>[A-Za-z0-9_\-]{minLength,}` and added to the backstop's scan set on startup and on catalog informer events. Operators teach the backstop new providers without code changes.
4. **Adversarial tests** — case sensitivity, whitespace variants, embedded credentials in larger sentences, empty values.

Residual: a credential that doesn't match the backstop AND is mistyped past the parser does reach the LLM. Documented as accepted residual; mitigation is the catalog-driven backstop plus tests; total elimination would require sandboxing all LLM input through a verified parser, out of scope.

#### `/secret add` rejection paths

| Cause | Detection | User-visible | Audit |
|---|---|---|---|
| `catalogId` not in catalog | Orchestrator validates against catalog informer | "Unknown API 'foobar'. Available: …. Use `/secret catalog` for full list." | `{ op: "secret.add", catalogId, error: "unknown_catalog_entry" }` |
| Missing required field | Orchestrator validates required `credentialFields` | "`jenkins` requires fields: user, password. Got: user. Missing: password." | Logged |
| Value empty/whitespace | Orchestrator validates `len(value.trim()) > 0` | "Value is empty." | Logged |
| Value too long (>4KB) | Orchestrator validates max length | "Value exceeds maximum length." | Logged |
| Value contains control chars | Orchestrator validates regex | "Value contains invalid characters." | Logged |
| IPC timeout (5s) | Channel-runner timeout | "Couldn't reach the orchestrator. The credential was NOT stored. Try again." | Channel-runner side log |
| K8s Secret API call fails | Orchestrator surfaces sanitised error | "Failed to store credential." | Full error on orchestrator |

Cleartext is zeroed from channel-runner heap on every code path (`finally` block).

#### Request-time resolution failures

| Condition | Broker response | Audit | Workload outcome |
|---|---|---|---|
| Per-group key present | 200 + substitution map | `keySource: groupSecret` | Success |
| No per-group key; `allowOperatorFallback: true`; operator key present | 200 + substitution map (operator key) | `keySource: operatorFallback` | Success |
| No per-group key; no operator fallback | 403 `{ code: "no_credential", catalogId, hint }` | `status: 403` | SDK throws; tool-result surfaces hint to LLM (option `i` recovery) |
| Host not in catalog and not in legacy mappings | 403 `{ code: "unknown_destination", host }` | `status: 403` | SDK throws; LLM sees |
| Per-group Secret read fails (RBAC, transient) | 503 `{ code: "secret_read_failed" }` | `status: 503` | Workload may retry |
| Pod missing owner-group annotation | If `allowOperatorFallback: true`: substitute operator key + warn. Else: 403 `no_owner_group` | Warn log | Per fallback |
| Mode=istio: pod terminating | 403 `pod_terminating` | Logged | Workload retry on later pod |
| Mode=istio: source IP mismatch | 403 `identity_mismatch` | Logged | Workload retry after informer convergence |
| Substitution position disallowed by `allowedPositions` | 403 `substitution_position_disallowed` | Logged | Indicates misconfigured workload or attack |
| Substitution counter exceeded | 503 `substitution_limit_exceeded` | Logged | Workload retries; persistent failure indicates attack |

Failure mode is closed everywhere: any error path returns 4xx/5xx without `x-kubeclaw-substitutions` or `x-kubeclaw-policy`, so the workload's request goes out with literal placeholder text and upstream rejects.

#### Catalog & Secret drift

| Condition | Behaviour |
|---|---|
| Operator removes a catalog entry while groups have credentials | Broker drops catalog entry → 403 `unknown_destination` on calls. Per-group Secret data is orphaned (cosmetic). `list_credentials` no longer shows the entry. v1 punts on cleanup. |
| Catalog entry's `id` renamed | Treated as remove+add. Users re-register. Operators advised to avoid renames. |
| Concurrent `/secret add` for same `(group, catalogId)` | K8s Secret patch is atomic; last write wins. Both report success. |
| Race: `/secret add` immediately followed by tool-job request | Tool-job hits broker before informer fires → 403 `no_credential`; sub-second window; LLM's next call succeeds. |
| Group deletion | Orchestrator's group-deletion code path deletes `kubeclaw-group-secrets-<group>`. Broker informer evicts. |

#### Audit-only mode interaction

The existing `credentialInjection.auditOnly: true` flag interacts:
- `/secret add` is accepted normally (storage is real; users pre-stage during audit).
- `list_credentials` returns real state.
- Tool-job calls keep using existing env-var keys (today's audit-only semantics). The broker logs the would-substitute decision but does not return `x-kubeclaw-substitutions` or `x-kubeclaw-policy`.
- Flipping `auditOnly: false` makes registered credentials live with no further action.

## Tests at three levels

### Unit tests (per-file, fast, no K8s)

| Test file | Cases |
|---|---|
| `src/credential-broker/resolver.test.ts` *(extend)* | (1) Catalog lookup by host. (2) Substitution map returned for known `(group, host)`. (3) `no_credential` 403 when no per-group key and `allowOperatorFallback=false`. (4) Operator-fallback when `allowOperatorFallback=true`. (5) `unknown_destination` 403 when not in catalog/mappings. (6) `substitution_position_disallowed` per `allowedPositions`. (7) Substitution counter exceeded returns 5xx. |
| `src/credential-broker/identity.test.ts` *(extend)* | (1) Sidecar: TokenReview pod-uid → annotation. (2) Sidecar: missing pod-uid extra → 403. (3) Istio: XFCC+IP → informer hit. (4) Istio: terminating pod → 403. (5) Istio: podIP mismatch → 403. (6) Istio: not in informer cache → 503. |
| `src/credential-broker/k8s-secret-source.test.ts` *(extend)* | (1) Watch fires for labelled Secrets. (2) JSON-blob parsing. (3) Unlabelled Secrets ignored. (4) Legacy `kubeclaw-secrets` still read. (5) Delete eviction. (6) Malformed JSON rejected with metric. |
| `src/credential-broker/substitution-policy.test.ts` *(new)* | (1) `[body]` rejects header-position. (2) `[body,header]` accepts both. (3) Default permits all positions. (4) Per-placeholder counter under limit. (5) Per-placeholder counter at limit (boundary). (6) Per-placeholder counter over limit returns 5xx. (7) Total counter under limit. (8) Total counter over limit returns 5xx. |
| `src/k8s/secret-manager.test.ts` *(new)* | (1) `setGroupSecret` generates placeholder per field. (2) Placeholders ≥256-bit entropy, distinct. (3) Placeholder includes catalog-id-prefixed name for greppability. (4) Label `kubeclaw.io/group-secrets=true` applied. (5) Overwrites only the named catalog entry; others preserved. (6) `deleteGroupSecret` removes named entry; deletes Secret if last. (7) `listGroupSecrets` returns names + registeredAt only. |
| `src/k8s/catalog.test.ts` *(new)* | (1) Informer fires on ConfigMap update. (2) Schema rejects missing `credentialFields`. (3) Schema rejects duplicate `id`. (4) `allowedPositions` validation. (5) Schema rejects multi-field entries with `allowOperatorFallback: true`. (6) Schema validates `apiKeyShape: { prefix, minLength }`. |
| `src/k8s/job-runner.test.ts` *(extend mode=istio block at line 1488)* | (1) Pod gets `owner-group` annotation. (2) Pod gets per-field placeholder envs from per-group Secret when registered. (3) Pod gets `KC_PH_FALLBACK_<id>` sentinel when unregistered and entry allows fallback. (4) Pod gets literal `injected-by-broker` when unregistered and entry disallows fallback. (5) Catalog-driven `baseUrlEnvs` injection unconditional. (6) `auditOnly=true` keeps existing env behaviour. |
| `src/channel-runner.test.ts` *(extend)* | (1) `/secret add` parsed upstream of LLM. (2) Raw user line removed from transcript; system event inserted; LLM never sees raw line. (3) Mistyped `/sercet add` falls through; backstop regex scrubs. (4) Unknown catalogId → friendly error, no IPC. (5) Empty value → error. (6) IPC timeout → user sees retry message; cleartext zeroed. (7) `list_credentials` registered in tool list at startup. (8) System-prompt block prepended each turn with catalog + registered state. |
| `src/tools/list-credentials.test.ts` *(new)* | (1) Returns merge of catalog + registered. (2) No values in return shape. (3) IPC failure returns error, not partial. |

### Integration tests (multi-component; `helm template`; may use kind)

| Test file | Cases |
|---|---|
| `e2e/helm-chart.test.ts` *(extend)* | (1) Catalog ConfigMap renders. (2) Broker RBAC renders with namespace-wide `secrets` verbs. (3) Orchestrator RBAC renders with write verbs. (4) Lua filter renders in `envoy-sidecar-config` and `istio-envoyfilter`. (5) Mode=sidecar regression: built-in mappings unchanged. (6) `testFixture.enabled` regression. |
| `src/credential-broker/index.test.ts` *(extend)* | (1) Full ext_authz flow returns `x-kubeclaw-substitutions` and `x-kubeclaw-policy` headers with correct format. (2) Substitution map parses correctly from the semicolon-delimited wire format. |
| `src/k8s/ipc-redis.test.ts` *(extend)* | (1) `secret.add` → Secret created with correct labels and placeholders. (2) `secret.list` returns names only. (3) `secret.remove` patches Secret; deletes if last. (4) `catalog.list` returns catalog. |

### End-to-end tests (full system; minikube/kind; real Envoy/Istio)

| Test file | Cases |
|---|---|
| `e2e/credential-broker.test.ts` *(extend)* | New: `/secret add` → tool-job → mock upstream sees real credential via header substitution. |
| `e2e/credential-injection.test.ts` *(extend, mode=sidecar)* | (1) Single-field bearer: `/secret add testbearer <token>` → probe tool-job curls mock upstream with `Authorization: Bearer KC_PH_…` → mock receives real token. (2) Multi-field Basic: `/secret add testbasic user=alice password=test` → probe constructs Basic header from envs → mock receives `Basic <base64("alice:test")>`. (3) Body substitution: probe POSTs body containing placeholder → mock receives real value in body. (4) `allowedPositions: [body]` rejection: probe sends placeholder in header for body-only entry → rejected. (5) Counter limit: probe sends placeholder 50 times → 5xx. (6) Cross-group isolation: pods in group A do not receive group B credentials. (7) Removed-credential failure: add → use → remove → next use fails closed; mock receives literal placeholder text and rejects. |
| `e2e/credential-injection-istio.test.ts` *(extend)* | Same six cases as above in mode=istio, plus: (8) Owner-group via IP-lookup (A1 mitigations exercised). (9) Identity-mismatch simulation returns `403 identity_mismatch`. |
| `e2e/credential-injection-istio.test.ts` *(new case)* | Negative: `/secret add` for unknown catalog ID → orchestrator IPC rejects → friendly error → no Secret created. |

### CI workflow

`.github/workflows/e2e-istio.yml` — no new image loads required beyond those already in the istio e2e workflow (`mendhak/http-https-echo`, `curlimages/curl`). The new e2e cases reuse the existing mock-upstream fixture.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Broker RBAC widening (A.1) gives broker pod technical read access to `kubeclaw-redis`, channel-HTTP user secrets, admin-shell password | Medium | Documented as accepted; trust boundary becomes "broker code is correct" rather than "RBAC is precise." Broker code reads only Secrets matching its catalog/per-group filter; no code path reads other Secrets. Future hardening: sub-namespace for group Secrets. |
| Istio IP-recycle race in identity resolution (residual after A1 mitigations) | Low-medium | Documented residual. Mitigations: informer resync, Terminating-pod reject, podIP cross-check. Probability tiny on real clusters; impact is one failed request or single wrong-group credential use. Hardening A2 (signed binding token) deferred. |
| Workload-controls-position: prompt-injected workload could place placeholder in URL query string or unusual body field, causing real credential to land in upstream access logs | Medium | `allowedPositions` operator-curated per catalog entry constrains where substitution may occur. Substitution counter rejects flood-write patterns. Audit logs record substitution count + position categories. Destination authorization remains the primary defense (credential only reaches authorized destinations). |
| Channel-runner holds cleartext briefly during `/secret add` | Low | Heap residency ~milliseconds; zeroed in `finally` block. Raw user line dropped from transcript memory before any LLM call. |
| Coarse-regex backstop residual: a credential that doesn't match the backstop patterns AND is mistyped past the parser reaches the LLM | Low | Catalog-driven `apiKeyShape` lets operators extend patterns without code change. Tests assert backstop catches known shapes. Total elimination out of scope. |
| Body substitution performance for large bodies (file uploads via tool-job) | Low | Skip-binary and 1MB-size threshold in Lua filter. Per-catalog opt-out to header-only retains O(1) for simple cases. |
| Secret leakage via Helm rendering: if operator templates the per-group placeholder into chart values | N/A | Per-group Secrets are not chart-rendered. Orchestrator-only writer. Helm has no view of placeholders. |
| Audit log noise: per-request substitution counts could flood logs | Low | Audit log respects existing rate-limiting in `audit.ts`. Counts logged as scalar, not per-placeholder. |
| Concurrent `/secret add` from two channel sessions | Low | K8s Secret patch is atomic; last write wins. Both sessions see success. Documented. |
| Orphan per-group Secret data when operator removes a catalog entry | Low | Cosmetic; broker won't serve resolutions for the removed entry. Documented as known limitation. Future cleanup job possible. |

## Future work (out of scope)

- **Browser-form-login as a v1.1 tool-job kind.** Playwright-based browser-automation pod that reuses per-group Secret storage and the placeholder/substitution mechanism. Playwright types placeholders into form inputs; egress filter substitutes; site receives real credentials. Storage primitives are forward-compatible.
- **Key rotation tooling.** `/secret rotate <id>` would regenerate placeholders and re-render any cached envs. Today's equivalent is remove+add.
- **A2 signed binding tokens** for istio mode IP-recycle race hardening.
- **External secret store backends** (Vault, AWS Secrets Manager). Catalog `credentialFields` is forward-compatible with a `sourceType` extension.
- **Orphan Secret cleanup** when operator removes catalog entries.
- **Computed-credential schemes** (HMAC body signing, AWS SigV4, JWT signing). Need a per-scheme broker plugin path.
- **Operator-controlled `substitutionCountLimit` per catalog entry.** v1 uses a global default of 10.
- **`list_credentials` enrichment with usage statistics** (last-used timestamp, recent failure counts) — opt-in metric.
- **NOTES.txt warning when catalog grows past a threshold** to nudge operators toward curation.
- **Tool-spec gating** (option iii from the design discussion): dynamically hide tools whose catalog entries have no registered credential. Most surgical UX but requires tool-spec infrastructure changes.

## Acceptance criteria

- [ ] Catalog schema in `kubeclaw-credential-broker-config` ConfigMap parses and validates per the spec; built-in `mappings:` unchanged.
- [ ] Broker RBAC widens to namespace-wide `secrets` verbs; `pods: get` added; chart renders clean.
- [ ] Orchestrator RBAC adds `secrets` write verbs; chart renders clean.
- [ ] `/secret add` slash command intercepts upstream of LLM; transcript memory shows no cleartext; system event reflects registration; LLM never sees raw command (verified by test).
- [ ] `list_credentials` tool registered in channel LLM's tool list at startup; returns metadata only.
- [ ] Per-turn system-prompt block summarises catalog + registered keys for the current group.
- [ ] Tool-job pod creation in mode=sidecar and mode=istio stamps `owner-group` annotation and per-field placeholder envs.
- [ ] Broker resolves owner-group correctly in mode=sidecar (TokenReview extras) and mode=istio (IP-lookup + A1 mitigations).
- [ ] Broker resolver returns substitution map; Lua filter performs inline substitution; placeholder strings never reach upstream when authorized; reach upstream literally when unauthorized.
- [ ] `allowedPositions` enforced; substitution counter enforced.
- [ ] All unit, integration, and e2e tests listed above pass.
- [ ] `docs/CREDENTIAL_INJECTION.md` and `docs/SECURITY.md` updated.
- [ ] Mode=sidecar regression suite (existing tests) passes unchanged.
- [ ] Mode=istio e2e (existing `e2e-istio.yml` workflow) passes with new cases.
