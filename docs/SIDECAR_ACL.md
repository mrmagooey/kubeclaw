# Redis ACL-Based Sidecar Follow-Up Implementation

This document describes the Redis ACL-based implementation for bidirectional communication with sidecar containers in Kubernetes mode, enabling follow-up message support.

## Overview

The ACL-based sidecar system allows KubeClaw to:

1. **Run arbitrary containers** via file-based or HTTP-based sidecar patterns
2. **Send follow-up messages** to active sidecar jobs
3. **Receive responses** through Redis Pub/Sub and Streams
4. **Maintain security** via Redis ACL (Access Control Lists) with per-job credentials

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Orchestrator (Main Pod)                           │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    RedisACLManager                                    │   │
│  │  - Creates per-job ACL users                                          │   │
│  │  - Encrypts credentials (AES-256-GCM)                                │   │
│  │  - Stores in SQLite                                                   │   │
│  │  - Revokes on job completion                                         │   │
│  └────────────────────────┬────────────────────────────────────────────┘   │
│                           │                                                 │
│                           │ Creates ACL                                     │
│                           ▼                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    SidecarAgentRunner                                 │   │
│  │  - FileSidecarAgentRunner (file-based IPC)                           │   │
│  │  - HttpSidecarAgentRunner (HTTP-based)                               │   │
│  │  - Manages active jobs and routing                                   │   │
│  └────────────────────────┬────────────────────────────────────────────┘   │
│                           │                                                 │
└───────────────────────────┼─────────────────────────────────────────────────┘
                            │ Creates K8s Job
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Kubernetes Job                                    │
│                                                                             │
│  ┌──────────────────────────────┐  ┌──────────────────────────────────┐    │
│  │  kubeclaw-file-adapter       │  │  user-agent                      │    │
│  │  (or http-adapter)           │  │  (arbitrary container)           │    │
│  │                              │  │                                  │    │
│  │  - Reads input from stdin    │  │  - Reads from /workspace/input   │    │
│  │  - Polls for output files    │  │  - Writes to /workspace/output   │    │
│  │  - Connects to Redis         │  │    (file mode)                   │    │
│  │    with ACL credentials      │  │  - Or exposes HTTP API           │    │
│  │  - Listens for follow-ups    │  │    (http mode)                   │    │
│  │    via Redis Streams         │  │                                  │    │
│  │  - Sends output via          │  │                                  │    │
│  │    Redis Pub/Sub             │  │                                  │    │
│  └──────────┬───────────────────┘  └──────────────────────────────────┘    │
│             │                                                               │
│             │ Redis ACL Connection                                          │
│             ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Redis 7+ (StatefulSet)                             │   │
│  │  - Per-job ACL users (~kubeclaw:*:${jobId})                          │   │
│  │  - Key-pattern restricted                                             │   │
│  │  - Admin commands blocked                                             │   │
│  │  - Input streams: kubeclaw:input:${jobId}                            │   │
│  │  - Output channels: kubeclaw:output:${jobId}                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. ACL Manager (`src/k8s/acl-manager.ts`)

The `RedisACLManager` handles:

- **ACL Creation**: Creates Redis ACL users with job-specific key patterns
- **Password Encryption**: AES-256-GCM encryption for passwords at rest
- **Credential Storage**: Persists encrypted credentials in SQLite
- **Cleanup**: Revokes ACLs on job completion or expiration

```typescript
// Creating ACL for a job
await aclManager.createJobACL(jobId, groupFolder, ttlSeconds);

// Retrieving credentials
const credentials = aclManager.getJobCredentials(jobId);
// Returns: { username: 'sidecar-${jobId}', password: 'decrypted-password' }

// Revoking ACL
await aclManager.revokeJobACL(jobId);
```

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

### 3. Sidecar Adapters

#### File Adapter (`container/file-adapter/`)

For containers that communicate via files:

- **Input**: Task written to `/workspace/input/task.json`
- **Output**: Result read from `/workspace/output/result.json`
- **Redis**: Connects with ACL credentials for follow-up support

```typescript
// Environment variables expected:
REDIS_URL=redis://kubeclaw-redis:6379
REDIS_USERNAME=sidecar-${jobId}
REDIS_PASSWORD=${decryptedPassword}
KUBECLAW_JOB_ID=${jobId}
```

#### HTTP Adapter (`container/http-adapter/`)

For containers exposing HTTP REST APIs:

- **Health Check**: Polls `GET /agent/health`
- **Task**: Posts to `POST /agent/task`
- **Redis**: Connects with ACL credentials for follow-up support

### 4. Runtime Integration (`src/runtime/index.ts`)

The runtime factory manages sidecar lifecycles:

```typescript
// File sidecar runner
const fileRunner = new FileSidecarAgentRunner();
fileRunner.setSendMessageHandler(async (groupFolder, text) => {
  // Route follow-up to active sidecar via Redis
});

// HTTP sidecar runner
const httpRunner = new HttpSidecarAgentRunner();
```

## Security Model

### ACL Rules

Each sidecar gets an ACL user with these restrictions:

```redis
ACL SETUSER sidecar-${jobId} on >${password} \
  ~kubeclaw:*:${jobId} \      # Can only access own keys
  +@read +@write +@stream +@pubsub \  # Basic operations
  -@admin -@dangerous          # No admin commands
```

### Key Isolation

- Sidecar A **cannot** access keys of Sidecar B
- Keys follow pattern: `kubeclaw:{type}:{jobId}`
- Input stream: `kubeclaw:input:${jobId}`
- Output channel: `kubeclaw:output:${jobId}`

### Command Restrictions

Sidecars **cannot** run:

- `FLUSHDB`, `FLUSHALL` - Database clearing
- `CONFIG` - Configuration changes
- `ACL` - ACL manipulation
- `DEBUG`, `SHUTDOWN`, `SAVE` - Administrative commands

### Password Security

- Passwords generated with `crypto.randomBytes(32)` (256-bit entropy)
- Encrypted at rest using AES-256-GCM
- Encryption key derived from `ACL_ENCRYPTION_KEY` env var
- Warning logged if encryption key not set (development mode)

## Configuration

### Required Environment Variables

```bash
# Redis connection
REDIS_URL=redis://kubeclaw-redis:6379
REDIS_ADMIN_PASSWORD=your-secure-password

# ACL encryption (32+ bytes recommended)
ACL_ENCRYPTION_KEY=your-encryption-key-here!!!
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

### Secrets Template

Create Redis secret:

```bash
kubectl create secret generic kubeclaw-redis \
  --from-literal=admin-password=$(openssl rand -base64 32) \
  -n kubeclaw
```

## Flow: Follow-Up Message

```
1. User sends message in group
   ↓
2. Orchestrator detects active sidecar for group
   ↓
3. Orchestrator retrieves ACL credentials from DB
   ↓
4. Orchestrator publishes to Redis Stream:
      XADD kubeclaw:input:${jobId} * type followup prompt "..."
   ↓
5. Sidecar adapter (in Job) receives via XREAD
   ↓
6. Sidecar processes follow-up via file IPC or HTTP
   ↓
7. Sidecar publishes response via Redis Pub/Sub:
      PUBLISH kubeclaw:output:${jobId} {...}
   ↓
8. Orchestrator receives and routes to channel
```

## Flow: Job Lifecycle

```
1. Runtime creates ACL: createJobACL(jobId, groupFolder)
   ↓
2. Runtime creates K8s Job with ACL env vars
   ↓
3. Sidecar adapter connects to Redis with ACL credentials
   ↓
4. Sidecar processes initial task
   ↓
5. Sidecar enters follow-up listening mode (XREAD on input stream)
   ↓
6. [Optional] Multiple follow-up messages exchanged
   ↓
7. Job completes or times out
   ↓
8. Runtime revokes ACL: revokeJobACL(jobId)
   ↓
9. ACL user deleted from Redis, marked revoked in DB
```

## Requirements

- **Redis 7+** - ACL support required
- **Kubernetes** - For sidecar job management
- **ACL_ENCRYPTION_KEY** - For secure credential storage

## Testing

Run ACL-specific tests:

```bash
# Unit tests
npm test -- src/k8s/acl-manager.test.ts

# Security tests
npm test -- e2e/sidecar-security.test.ts

# Integration tests
npm test -- e2e/sidecar-acl.test.ts
```

## Troubleshooting

### "Redis version not supported"

Ensure Redis 7+ is running:

```bash
redis-cli INFO server | grep redis_version
# Should show 7.x.x
```

### "NOAUTH Authentication required"

Check `REDIS_ADMIN_PASSWORD` is set correctly and matches the Redis secret.

### Sidecar cannot connect to Redis

Verify ACL was created:

```bash
kubectl exec -it kubeclaw-redis-0 -- redis-cli ACL LIST
```

### Credentials not found

Check ACL status in database:

```bash
sqlite3 store/messages.db "SELECT * FROM job_acls WHERE job_id = '...';"
```

## Migration from Non-ACL Setup

If upgrading from a non-ACL setup:

1. Ensure Redis 7+ is deployed
2. Set `REDIS_ADMIN_PASSWORD` and `ACL_ENCRYPTION_KEY`
3. Restart orchestrator
4. New jobs will use ACL automatically
5. Existing jobs without ACL will continue to work (backward compatible)

## Future Improvements

- [ ] Automatic ACL credential rotation
- [ ] mTLS for Redis connections
- [ ] Audit logging for ACL operations
- [ ] Support for Redis Sentinel/Cluster
