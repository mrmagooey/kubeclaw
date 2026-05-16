# KubeClaw Security Model

## Trust Model: Four-Tier Privilege Separation

KubeClaw enforces security through a four-tier pod architecture. Each tier has an explicit privilege level, and the boundaries between them are enforced by Kubernetes — not by application-level permission checks.

| Tier | Privilege | Trust Level | Rationale |
|------|-----------|-------------|-----------|
| **Orchestrator** | High (superuser) | Trusted | Only pod with K8s API access. Controls all pod lifecycles. Redis is part of this tier. |
| **Channel** | Low | Partially trusted | User-facing I/O. Owns LLM conversation. No K8s API access. Can only reach capabilities/tools after orchestrator-mediated discovery. |
| **Capability** | Low | Partially trusted | Long-lived feature pods. No K8s API access. Cannot create or destroy other pods. |
| **Tool Job** | None | Untrusted | Ephemeral. No K8s API access. Can use external container images. Auto-deleted after completion. |
| User messages | N/A | User input | Potential prompt injection via any channel. |

## Security Boundaries

### 1. Orchestrator Exclusivity (Primary Boundary)

The orchestrator is the only pod with Kubernetes API access. This means:
- Only the orchestrator can create, destroy, or inspect pods
- Channels, capabilities, and tool jobs cannot escalate privileges
- Even a fully compromised channel pod cannot affect other groups, create pods, or access the K8s API
- Redis (IPC) is architecturally part of the orchestrator tier

### 2. Channel Isolation

Each channel pod:
- Runs its own LLM conversation directly against provider endpoints — no shared agent runtime
- Has no K8s API access
- Can only access capabilities and tool jobs after the orchestrator authorizes and provides discovery
- Cannot communicate with other channel pods
- Handles only its own registered groups

### 3. Tool Job Sandboxing

Tool jobs are the lowest-privilege tier:
- **Ephemeral** — created on demand when a channel requests one via the orchestrator, auto-deleted after completion
- **No K8s API access** — cannot create pods, inspect the cluster, or affect other tiers
- **Filesystem isolation** — only explicitly mounted paths are visible
- **External image support** — can run third-party container images paired with IPC sidecars, so untrusted images are sandboxed
- **Non-root execution** — runs as unprivileged user
- **Network policy** — restricted to DNS, Redis (in-namespace), and HTTPS endpoints

### 4. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/kubeclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into any pod
- Cannot be modified by channels, capabilities, or tool jobs

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 5. Session Isolation

Each group has isolated conversation state:
- Groups cannot see other groups' conversation history
- Session data is scoped to the channel pod handling that group
- Prevents cross-group information disclosure

### 6. IPC Authorization

The orchestrator mediates all cross-tier communication. Operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | Yes | Yes |
| Send message to other chats | Yes | No |
| Schedule task for self | Yes | Yes |
| Schedule task for others | Yes | No |
| View all tasks | Yes | Own only |
| Manage other groups | Yes | No |
| Request capability discovery | Yes | Yes |
| Request tool job spin-up | Yes | Yes |

### 7. Credential Handling

**Orchestrator-only credentials:**
- K8s API access (service account)
- Redis connection

**Channel pod credentials:**
- LLM provider API keys (Anthropic, OpenAI, etc.) — needed for direct provider communication

**NOT exposed to any non-orchestrator pod:**
- K8s API credentials
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns

## Privilege Comparison by Tier

| Capability | Orchestrator | Channel | Capability | Tool Job |
|------------|-------------|---------|------------|----------|
| K8s API access | Yes | No | No | No |
| Create/destroy pods | Yes | No | No | No |
| Redis access | Yes | Via IPC | Via IPC | Via IPC sidecar |
| LLM provider access | No | Yes (direct) | No | No |
| User I/O | No | Yes | No | No |
| Filesystem | Full | Scoped to group | Scoped to feature | Scoped to task |
| Network | Unrestricted | Unrestricted | Restricted | Restricted |
| Lifecycle | Permanent | Permanent | Long-lived | Ephemeral |

## Per-group credential injection threats

These threat-model entries cover risks introduced by the per-group user-supplied credentials feature. See [`docs/CREDENTIAL_INJECTION.md#per-group-user-supplied-credentials`](CREDENTIAL_INJECTION.md#per-group-user-supplied-credentials) for the full design.

### A.1 — RBAC widening: broker namespace-wide Secret read

**Description.** The credential broker's Kubernetes Role previously restricted Secret access to a single named Secret (`resourceNames: ["kubeclaw-secrets"]`). Per-group credential support requires the broker to watch all Secrets labelled `kubeclaw.io/group-secrets=true`, which demands dropping the `resourceNames` constraint. The broker now holds `get, list, watch` on all Secrets in the `kubeclaw` namespace, giving it technical access to `kubeclaw-redis`, per-channel HTTP secrets, the admin-shell password, and any other Secret in the namespace.

**Accepted risk.** The trust boundary shifts from "broker RBAC is precisely scoped" to "broker code is correct." The broker's `k8s-secret-source.ts` contains one labeled-selector watch (for `kubeclaw.io/group-secrets=true`) and one named get (for `kubeclaw-secrets`); no code path reads arbitrary Secrets. Future hardening option: move per-group Secrets to a dedicated sub-namespace and re-scope the Role to that namespace.

### A.1 (residual) — Istio IP-recycle race in identity resolution

**Description.** In mode=istio, the broker identifies the calling pod by matching the `ext_authz` source IP against its in-process pod informer. Between a pod's IP being recycled and the broker's informer receiving the delete event, a request from a new pod (potentially in a different group) could be mapped to the old pod's annotation. Impact: the new pod's request uses the old group's credential for that one request, then subsequent requests succeed correctly once the informer catches up.

**Mitigations (A1 set):**
1. Reject lookups against `Terminating` pods (`.metadata.deletionTimestamp` set).
2. Cross-check `.status.podIP`: the looked-up pod's recorded IP must match the request source IP exactly.
3. Pod informer resyncs every 30 seconds; immediate watch events minimize lag.

**Residual.** A tiny window remains between IP assignment and informer convergence. Probability is very low on real clusters. Impact is bounded to a single request failing or using a wrong-group credential. The A2 mitigation (signed binding token embedded in the projected SA token) is deferred to a follow-up if the race is observed in production.

### Workload-controls-position: placeholder in unintended request location

**Description.** A prompt-injected workload could place a placeholder string in an unexpected request location — URL query string, unusual body field — causing the real credential to appear in an upstream access log or be forwarded to an unintended recipient by the upstream.

**Mitigations:**
- `allowedPositions` per catalog entry (operator-controlled): restricts substitution to `header`, `body`, or both. Requests where the Lua filter finds a placeholder outside the allowed positions are rejected with `403 substitution_position_disallowed`.
- Substitution counter limits: ≤10 occurrences per individual placeholder; ≤50 total per request. Exceeding either limit produces `503 substitution_limit_exceeded` and the request is dropped.
- Audit logging: every authz decision records the substitution count and position categories (never values).
- Destination authorization remains the primary defense: even if a placeholder lands in an unexpected position, the substitution only occurs for authorized destinations.

### Channel-runner transient cleartext

**Description.** During `/secret add`, the channel-runner holds the user's cleartext credential as a JavaScript string from the time the transport delivers it until the Redis IPC ack is received — typically a few milliseconds. The `finally` block zeros the local binding, but JavaScript string immutability means the literal cleartext characters remain in V8 heap until the garbage collector reclaims the memory. During that window, a heap snapshot or memory dump of the channel-runner pod would contain the credential.

**Accepted risk.** The window is on the order of milliseconds, not seconds. The channel-runner runs in a low-privilege pod with no K8s API access; taking a heap snapshot requires either exec access to the pod (which requires orchestrator-level privilege) or a vulnerability in the channel runtime. The raw user line is dropped from transcript memory before any LLM call. This risk is accepted; total elimination would require a language runtime with guaranteed zeroing semantics for secret strings.

### Backstop regex residual: credential-shaped values reaching the LLM

**Description.** If a user misformats a `/secret add` command such that the parser does not recognise it as a credential command, and the credential value does not match any backstop regex pattern, the raw message (containing the credential) is forwarded to the LLM.

**Mitigations:**
- Catalog entries may declare `apiKeyShape: { prefix, minLength }`, which compiles to a regex `<prefix>[A-Za-z0-9_\-]{minLength,}` added to the backstop scan set at startup and on catalog informer events.
- Built-in backstop patterns cover common formats (`sk-[A-Za-z0-9]{20,}`, `Bearer\s+[A-Za-z0-9_\-\.]{20,}`, etc.).
- The backstop is intentionally conservative: false positives (redacting non-credentials) are preferred over false negatives.

**Residual.** A credential that matches neither the backstop nor the parser reaches the LLM. This is documented as accepted residual; total elimination would require parsing and sandboxing all inbound text through a verified scanner, which is out of scope.

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  User messages (WhatsApp, Telegram, HTTP — potential injection)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Platform-specific I/O
┌──────────────────────────────────────────────────────────────────┐
│                CHANNEL POD (Low Priv)                              │
│  • Owns LLM conversation (direct to provider)                     │
│  • Trigger check, message formatting                              │
│  • No K8s API access                                              │
│  • Requests capabilities/tools via orchestrator                   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ discovery + authorization
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│              ORCHESTRATOR (High Priv — Superuser)                  │
│  • Only pod with K8s API access                                   │
│  • Manages all pod lifecycles                                     │
│  • Mediates discovery and authorization                           │
│  • Redis IPC                                                      │
└───────┬────────────────────────────────┬─────────────────────────┘
        │ lifecycle + discovery          │ spin-up on request
        ▼                                ▼
┌───────────────────────┐  ┌──────────────────────────────────────┐
│ CAPABILITY POD (Low)  │  │ TOOL JOB (No Priv — Sandboxed)       │
│ • Long-lived          │  │ • Ephemeral                           │
│ • No K8s API          │  │ • No K8s API                          │
│ • Channels talk       │  │ • External images + IPC sidecars      │
│   directly after      │  │ • Channels talk directly after        │
│   discovery           │  │   discovery                           │
└───────────────────────┘  └──────────────────────────────────────┘
```
