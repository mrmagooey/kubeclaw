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
