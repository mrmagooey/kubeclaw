# Dynamic Tool Selection

The Tool Selection Agent (TSA) finds and activates the right tool for a task without requiring the channel LLM to know the tool catalog in advance. It tries three tiers in order and stops as soon as one succeeds.

## The Three Tiers

| Tier | Name             | Source                                      | Provenance    | Gate                                              |
| ---- | ---------------- | ------------------------------------------- | ------------- | ------------------------------------------------- |
| 1    | Live catalog     | Currently active tools (live catalog)       | `catalog`     | Always available                                  |
| 2    | Curated library  | Admin-registered tools (may need credential)| `library`     | Always available                                  |
| 3    | Open discovery   | Registry search → draft → probe → register  | `discovered`  | Requires Cilium or Istio (see [Tier-3 hard gate]) |

The TSA scores candidates against the task description using an LLM matcher with a minimum confidence threshold of 0.5. A match below that threshold falls through to the next tier.

### Tier 1 — Live Catalog

Checks tools already active in the cluster (the merged Helm baseline + SQLite overrides catalog). If a live tool matches the task, the TSA returns `ready` immediately — no registration or reconciliation step is needed.

Use case: the user asks for something the orchestrator has already set up. This tier has no side-effects.

### Tier 2 — Curated Library

Checks admin-registered library tools — tools an operator has registered in advance but that are not yet active in the live catalog. If a library tool matches:

- **No credential required**: the TSA registers the tool into the live catalog, reconciles the ConfigMap, and returns `ready`.
- **Credential required, broker holds it**: the TSA returns `pending_credential` with an approval token. The user must call `approve_tool_credential` to finalize activation (see [Channel UX](#channel-ux-find_tools-and-approve_tool_credential)).
- **Credential required, broker does not hold it**: the TSA returns `unavailable`. An administrator must add the credential to the broker catalog before the tool can be used.

Library tools are globally scoped (`scopeGroup: null`); once activated they are available to all channels.

### Tier 3 — Open Discovery

Discovers tools from the public container registry, drafts a `ToolSpec` for the best candidate, verifies it in a sandboxed probe job, and registers it if the probe passes. This tier is **hard-gated** — it only runs when the cluster has kernel-enforced egress control (Cilium or Istio). See [Tier-3 hard gate](#tier-3-hard-gate) for the requirement and rationale.

Discovered tools are **scoped to the requesting group only** (see [Group scoping](#group-scoping-and-promotion)).

## Channel UX: `find_tools` and `approve_tool_credential`

A channel sends a `find_tools` IPC request with a `taskDescription` string. The TSA responds with one of three statuses:

### `ready`

The tool is active and the channel can invoke it immediately.

```json
{
  "status": "ready",
  "tools": [{ "name": "image_search", "description": "...", "provenance": "library" }],
  "message": "Activated image_search from the library."
}
```

### `pending_credential`

A matching tool was found but it requires a third-party credential the user must approve. The response contains an `approvalToken` (short-lived, HMAC-signed, bound to the tool name and catalog id).

```json
{
  "status": "pending_credential",
  "toolName": "image_search",
  "catalogId": "brave-search",
  "host": "api.search.brave.com",
  "approvalToken": "<token>",
  "message": "Tool image_search needs your brave-search credential. Approve to enable it."
}
```

The user then calls `approve_tool_credential` with the `toolName`, `catalogId`, and `approvalToken`. On success the TSA registers the tool and returns a `ready` result.

### `unavailable`

No suitable tool was found at any tier, or a matching tool cannot be made ready (broker credential missing, probe failed, no hard egress enforcement, etc.).

```json
{ "status": "unavailable", "message": "No suitable tool found." }
```

## Tier-3 Hard Gate

Tier-3 open discovery is disabled unless the cluster has **hard (kernel-enforced) egress enforcement**. The gate is checked at orchestrator startup via `hasHardEgressEnforcement()`:

| Condition                              | Substrate | Tier 3 |
| -------------------------------------- | --------- | ------ |
| `CILIUM_NETWORK_POLICY_ENABLED=true`   | Cilium    | Enabled |
| `CREDENTIAL_INJECTION_MODE=istio`      | Istio     | Enabled |
| Neither                                | None      | Disabled |

When the gate is closed, `buildTsaSearchRegistry` returns `undefined` and the TSA has no `searchRegistry` function; tier-3 is skipped and `find_tools` returns `unavailable` after tiers 1 and 2 fail.

**Why this gate is mandatory:** tier-3 discovery runs unknown third-party container images. The sandboxed probe is only trustworthy when the cluster can actually enforce the probe's egress policy — i.e., when a connection attempt to a host outside the tool's declared `allowedEgress` list is dropped at the kernel/sidecar layer. Without that enforcement the probe cannot detect exfiltration attempts made by a malicious image, and the security model of the probe sandbox collapses.

## Discovery Pipeline (Tier 3)

When tier 3 is active, `makeSearchRegistry` runs the following pipeline for each task description. Up to `maxCandidates` (default 5) images are evaluated in order; the pipeline returns the first one that passes all stages.

```
1. Registry search
      searchImages(taskDescription) → up to 5 ImageCandidate objects

2. Metadata fetch
      fetchImageMetadata(repo, "latest") → digest (sha256) + readme from Docker Hub

3. LLM draft
      draftToolSpec({ taskDescription, metadata }) →
        LLM produces JSON (name, description, parameters, image, pattern, allowedEgress, …)
        image is FORCED to repo@sha256:<digest> regardless of what the LLM wrote
        draft is rejected if the image has no resolvable digest

4. Coherence check
      checkEgressCredentialCoherence(spec) →
        rejects if credentials declared but no allowedEgress
        rejects if any egress host is not a credential host

5. Sandboxed probe
      probeTool(spec, probe) → runProbeToolJob (60 s timeout)
        - probe spec has credentials stripped (credential-free)
        - job runs with hardened securityContext
        - egressViolation → rejected; empty output → rejected; error → rejected

6. On pass: spec registered, provenance recorded, result returned
```

If all candidates are exhausted without a pass, the tier returns `null` and `find_tools` returns `unavailable`.

## Security Model of Discovery

Five layered controls protect against untrusted third-party images during and after discovery:

### 1. Sandboxed probe pod

The probe runs as a one-shot Kubernetes Job with the same hardened `securityContext` applied to all tool pods:

**Pod-level** (`hardenedPodSecurityContext`):
- `runAsNonRoot: true`, `runAsUser: 65534`
- `seccompProfile: RuntimeDefault`

**Container-level** (`hardenedContainerSecurityContext`):
- `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true`
- `capabilities.drop: [ALL]`

### 2. Default-deny egress

The probe pod's egress is controlled by the cluster's Cilium NetworkPolicy or Istio egress policy, derived from the tool's `allowedEgress` declaration. Any connection attempt to a host not in `allowedEgress` is blocked at the kernel layer. If the bridge detects a connection error consistent with a policy denial (ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, etc.), the probe result carries `egressViolation: true` and the candidate is rejected.

An offline tool that declares `allowedEgress: []` has **no outbound connectivity** during the probe.

### 3. Credential-free probe

Secrets are **never injected into a probe pod**. `probeTool` strips `credentials` from the spec before calling `runProbeToolJob`. As a belt-and-suspenders measure, `runProbeToolJob` also strips them independently at the job-seam — so no future caller path can accidentally inject secrets into a probe.

### 4. Digest pinning

`draftToolSpec` always forces the image reference to `repo@sha256:<digest>`, overriding whatever the LLM wrote. If the Docker Hub API returns no digest for the image, the draft is rejected outright. This means:

- The registered spec references an immutable layer, not a mutable tag.
- The image that passed the probe is the exact image that runs in production.
- The `sourceDigest` (the `sha256:…` portion) is stored in the provenance record.

### 5. Egress/credential coherence

Before the probe runs, `checkEgressCredentialCoherence` enforces that a credentialed tool's `allowedEgress` hosts are a strict subset of the credential hosts. Specifically:

- A tool with credentials and no `allowedEgress` is rejected (no implicit open egress).
- Any egress host not covered by a declared credential is rejected.

This prevents a tool from being drafted with credentials targeting one host while declaring egress to an unrelated host.

## Provenance and TTL

Every tool activated by the TSA is recorded in the `auto_tool_meta` SQLite table:

| Column         | Type           | Description                                                  |
| -------------- | -------------- | ------------------------------------------------------------ |
| `name`         | string         | Tool name (matches catalog entry)                            |
| `provenance`   | string         | `catalog`, `library`, or `discovered`                        |
| `scope_group`  | string \| null | Group folder for discovered tools; `null` for library tools  |
| `source_digest`| string \| null | `sha256:…` digest for discovered tools; `null` otherwise     |
| `acquired_at`  | ms timestamp   | When the tool was first activated                            |
| `last_used_at` | ms timestamp   | Updated on each use via `recordAutoToolUse`                  |

Tools are pruned from the catalog and provenance table when they have not been used within the TTL:

| Setting              | Default          | Override env var       |
| -------------------- | ---------------- | ---------------------- |
| TTL                  | 14 days          | `AUTO_TOOL_TTL_MS`     |
| Sweep interval       | hourly           | `AUTO_TOOL_SWEEP_MS`   |

The sweep runs `sweepStaleAutoTools` on a `setInterval` in the orchestrator. It deletes the provenance row, removes the tool from the runtime registry, and reconciles the ConfigMap so channel pods stop seeing the tool.

## Group Scoping and Promotion

Discovered tools are group-scoped: the TSA registers them with `channels: [<requesting channel>]` and records `scopeGroup` as the requesting group's folder. A second group asking for the same capability must re-discover independently — the probe runs again and a new provenance record is created for that group.

There is no automatic promotion of a discovered tool to all groups. Broadening a discovered tool beyond its originating group is an explicit human/admin action: an administrator would re-register the tool from the library (or directly via `register_tool`) with an unrestricted `channels` list. This is intentional — it keeps the blast radius of an untrusted image to the group that triggered discovery until a human reviews and promotes it.

## Known Limitation: Credentialed Discovered Tools

When discovery produces a tool that requires a credential, the TSA returns `pending_credential` (same as tier 2). However, completing that approval is **not yet implemented for discovered tools**: `finalizeCredentialApproval` resolves the spec by looking up the library, and a discovered spec is not in the library. There is no pending-discovered-spec store yet.

In practice this means **credential-free discovered tools** are the fully supported path. A discovered tool that the LLM drafts with `credentials` will surface a `pending_credential` response that cannot currently be completed. This is a known gap (see Phase 3 plan, Task 7) and will be addressed by adding a pending-spec store in a future iteration.

## Configuration Reference

| Env var                          | Default                  | Description                                                |
| -------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `CILIUM_NETWORK_POLICY_ENABLED`  | `false`                  | Set `true` to enable Cilium as egress substrate; enables tier 3 |
| `CREDENTIAL_INJECTION_MODE`      | `off`                    | Set `istio` to enable Istio egress; also enables tier 3    |
| `AUTO_TOOL_TTL_MS`               | `1209600000` (14 days)   | Milliseconds before an unused auto-acquired tool is pruned |
| `AUTO_TOOL_SWEEP_MS`             | `3600000` (1 hour)       | Interval between TTL sweep runs                            |
