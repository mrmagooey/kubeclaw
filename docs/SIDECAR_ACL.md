# Redis ACL-Based Sidecar Tool Pod Security

This document describes the Redis ACL implementation that protects per-tool-call bridge containers (sidecar tool pods) in Kubernetes mode.

## Overview

Each sidecar tool pod is a two-container Kubernetes Job: `kubeclaw-tool-bridge` (running `tool-server.js`) and `user-tool` (an arbitrary container). The bridge reads tool calls from a Redis stream and writes results back to a separate stream. To prevent any one pod from reading another pod's streams or performing administrative operations, the orchestrator mints a per-job Redis ACL user at pod creation time and revokes it after the pod's TTL expires.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Orchestrator (Main Pod)                           │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    RedisACLManager                                    │   │
│  │  - createToolPodACL(): mints stool-{podJobName} user                  │   │
│  │  - Encrypts credentials (AES-256-GCM)                                │   │
│  │  - Stores in SQLite job_acls                                         │   │
│  │  - startAclCleanupSweep(): 10-min periodic sweep revokes expired     │   │
│  └────────────────────────┬────────────────────────────────────────────┘   │
│                           │ createToolPodACL() called by                    │
│                           ▼                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    JobRunner.createSidecarToolPodJob()                │   │
│  │  - Mints per-job ACL (fallback: shared tool-server user)             │   │
│  │  - Injects credentials into bridge container env                     │   │
│  └────────────────────────┬────────────────────────────────────────────┘   │
│                           │ Creates K8s Job                                 │
└───────────────────────────┼─────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Kubernetes Job (sidecar tool pod)                        │
│                                                                             │
│  ┌────────────────────────────┐  ┌──────────────────────────────────────┐  │
│  │  kubeclaw-tool-bridge      │  │  user-tool                           │  │
│  │  (tool-server.js)          │  │  (arbitrary container)               │  │
│  │                            │  │                                      │  │
│  │  - Reads tool calls from   │  │  - http: exposes POST /invoke        │  │
│  │    toolcalls stream        │  │  - file: reads/writes /shared        │  │
│  │  - Writes results to       │  │  - acp: exposes /runs endpoint       │  │
│  │    toolresults stream      │  │                                      │  │
│  │  - Authenticates via       │  │                                      │  │
│  │    per-job ACL credentials │  │                                      │  │
│  └──────────┬─────────────────┘  └──────────────────────────────────────┘  │
│             │                                                               │
│             │ Redis ACL Connection (stool-{podJobName})                     │
│             ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Redis 7+ (StatefulSet)                             │   │
│  │  - Per-job users: stool-{podJobName} (capped 64 chars)               │   │
│  │  - Read-only: kubeclaw:toolcalls:{agentJobId}:{toolName}             │   │
│  │  - Write-only: kubeclaw:toolresults:{agentJobId}:{toolName}          │   │
│  │  - No pub/sub channel access; no cross-job keys                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. ACL Manager (`src/k8s/acl-manager.ts`)

The `RedisACLManager` handles:

- **ACL Creation**: Mints Redis ACL users scoped to a single tool pod's streams via `createToolPodACL()`
- **Password Encryption**: AES-256-GCM encryption for passwords at rest
- **Credential Storage**: Persists encrypted credentials in SQLite
- **Cleanup**: Periodic sweep revokes ACLs after their TTL expires

### 2. Database Schema (`src/db.ts`)

Job ACLs are stored in the `job_acls` table:

```sql
CREATE TABLE job_acls (
  job_id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,  -- Encrypted at rest
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT DEFAULT 'active'
);
```

The storage key in `job_acls` uses the format `{podJobName}-{Date.now().toString(36)}` to avoid primary-key collisions on recycled pod names.

## Security Model

### ACL Rules

Each tool pod bridge container gets an ACL user minted with these exact rules:

```
resetkeys
%R~kubeclaw:toolcalls:{agentJobId}:{toolName}
%W~kubeclaw:toolresults:{agentJobId}:{toolName}
resetchannels
+xread
+xadd
+ping
+reset
+quit
+client|setinfo
+client|setname
```

`resetkeys` at the head of the rule list drops any leftover key grants from a previous user with the same name, making the rules safe for username collisions on recycled pod names.

### Key Isolation

- The tool pod bridge can only read from `kubeclaw:toolcalls:{agentJobId}:{toolName}` (read-only key pattern `%R~`)
- The tool pod bridge can only write to `kubeclaw:toolresults:{agentJobId}:{toolName}` (write-only key pattern `%W~`)
- No other key patterns are accessible
- No pub/sub channel access (`resetchannels` with no channel grants)

### ACL Username Format

- Format: `stool-{podJobName}`, capped at 64 characters
- `SETUSER` on an existing username with the same name appends rules; `resetkeys` at the start of the rule list drops any leftover key grants — safe for collisions on recycled names

### Fallback Behavior

If ACL minting fails (e.g., Redis version older than 7), `createSidecarToolPodJob()` falls back to the shared `tool-server` user and logs a warning. The pod will still be created, but without per-job isolation.

### Password Security

- Passwords generated with `crypto.randomBytes(32)` (256-bit entropy)
- Encrypted at rest using AES-256-GCM
- Encryption key from `ACL_ENCRYPTION_KEY` env var
- `ACL_ENCRYPTION_KEY` is shipped in the `kubeclaw-redis` Helm Secret as key `acl-encryption-key` and injected into the orchestrator pod as env var `ACL_ENCRYPTION_KEY`

## TTL and Lifecycle

- TTL = pod's `activeDeadlineSeconds` + 900 seconds (15-minute outlive buffer)
- Revocation: `startAclCleanupSweep()` runs on a 10-minute interval (started in `src/index.ts`) and calls `DELUSER` for any ACL whose `expires_at` has passed
- There is no completion hook; pods are cleaned up by idle timeout or `activeDeadlineSeconds` expiry

## Job Lifecycle Flow

```
1. Channel requests a tool pod for tool {toolName} on agentJob {agentJobId}
   ↓
2. JobRunner.createSidecarToolPodJob() calls createToolPodACL()
   ↓
3. ACL user stool-{podJobName} minted with exactly two stream patterns
   ↓
4. Credentials injected into bridge container's REDIS_URL
   ↓
5. K8s Job created; bridge container connects to Redis as stool-{podJobName}
   ↓
6. Bridge reads tool calls from kubeclaw:toolcalls:{agentJobId}:{toolName}
   ↓
7. Bridge forwards to user-tool (http/file/acp); writes result to toolresults
   ↓
8. Pod terminates via idle timeout or activeDeadlineSeconds (no completion hook)
   ↓
9. startAclCleanupSweep() (10-min interval) revokes expired ACL via DELUSER
```

## Configuration

### Required Environment Variables

```bash
# Redis connection
REDIS_URL=redis://kubeclaw-redis:6379
REDIS_ADMIN_PASSWORD=your-secure-password

# ACL encryption key (from kubeclaw-redis secret, key acl-encryption-key)
ACL_ENCRYPTION_KEY=your-encryption-key-here
```

### Kubernetes Manifests

Redis StatefulSet with ACL support (`k8s/10-redis.yaml`):

```yaml
containers:
  - name: redis
    image: redis:7-alpine # Redis 7+ required for ACLs
    command:
      - redis-server
      - --aclfile /data/redis-acl.conf
      - --requirepass $(REDIS_ADMIN_PASSWORD)
```

### Secrets

The `kubeclaw-redis` Helm Secret holds two keys: `admin-password` and `acl-encryption-key`. Both are injected into the orchestrator pod as environment variables.

```bash
kubectl create secret generic kubeclaw-redis \
  --from-literal=admin-password=$(openssl rand -base64 32) \
  --from-literal=acl-encryption-key=$(openssl rand -base64 32) \
  -n kubeclaw
```

## Requirements

- **Redis 7+** — ACL support required; older versions fall back to shared `tool-server` user with a warning
- **Kubernetes** — For sidecar job management
- **ACL_ENCRYPTION_KEY** — For secure credential storage

## Testing

Run ACL-specific tests:

```bash
# Unit tests
npm test -- src/k8s/acl-manager.test.ts
```

## Troubleshooting

### "Redis version not supported" or fallback warning in logs

Ensure Redis 7+ is running:

```bash
redis-cli INFO server | grep redis_version
# Should show 7.x.x
```

If the orchestrator logs warn about falling back to the shared `tool-server` user, the Redis version is below 7 or ACL commands are restricted.

### "NOAUTH Authentication required"

Check that `REDIS_ADMIN_PASSWORD` is set correctly and matches the value in the `kubeclaw-redis` secret.

### Bridge container cannot connect to Redis

Verify the ACL was created:

```bash
kubectl exec -it kubeclaw-redis-0 -- redis-cli ACL LIST | grep stool-
```

### Credentials not found in database

Check ACL status in the SQLite database:

```bash
sqlite3 store/messages.db "SELECT job_id, username, status, expires_at FROM job_acls ORDER BY created_at DESC LIMIT 20;"
```

### ACL not being revoked after pod terminates

The cleanup sweep runs every 10 minutes. If ACLs are accumulating past their `expires_at`:

```bash
# Check sweep is running (look for aclCleanupSweep log entries)
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=200 | grep -i acl

# Manually inspect expired but active ACLs
sqlite3 store/messages.db "SELECT job_id, username, expires_at FROM job_acls WHERE status = 'active' AND expires_at < datetime('now');"
```
