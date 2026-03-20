# KubeClaw Kubernetes Migration

This document describes the Kubernetes-based runtime for KubeClaw, replacing Docker containers with Kubernetes Jobs and Redis-based communication.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Kubernetes Cluster                          │
│                                                                     │
│  ┌─────────────────────┐  ┌─────────────────────┐                  │
│  │  kubeclaw-redis     │  │ kubeclaw-orchestrator│                  │
│  │  (StatefulSet)      │  │  (Deployment)        │                  │
│  │  - AOF persistence  │  │  - Message loop      │                  │
│  │  - Pub/Sub          │  │  - Job scheduling    │                  │
│  │  - Streams          │  │  - Channel mgmt      │                  │
│  └──────────┬──────────┘  └──────────┬──────────┘                  │
│             │                        │                             │
│             │ Redis Pub/Sub          │ Creates                     │
│             │ & Streams              │ Jobs                        │
│             ▼                        ▼                             │
│  ┌─────────────────────────────────────────────────┐              │
│  │        kubeclaw-agent Jobs (Batch)              │              │
│  │  ┌──────────────┐  ┌──────────────┐             │              │
│  │  │ Agent Job 1  │  │ Agent Job 2  │  ...        │              │
│  │  │ - Claude SDK │  │ - Claude SDK │             │              │
│  │  │ - Redis IPC  │  │ - Redis IPC  │             │              │
│  │  └──────────────┘  └──────────────┘             │              │
│  └─────────────────────────────────────────────────┘              │
│                                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐               │
│  │ PVC: kubeclaw-groups │  │ PVC: kubeclaw-sessions│               │
│  │ (ReadWriteMany)      │  │ (ReadWriteOnce)      │               │
│  └──────────────────────┘  └──────────────────────┘               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Kubernetes Manifests (`k8s/`)

| File                         | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `00-namespace.yaml`          | Creates the `kubeclaw` namespace with security policies |
| `01-network-policy.yaml`     | Restricts agent egress to DNS, Redis, and HTTPS only    |
| `05-secrets.yaml`            | Template for Kubernetes secrets (API keys, tokens)      |
| `10-redis.yaml`              | Redis StatefulSet with AOF persistence                  |
| `20-storage.yaml`            | Default PVCs for groups and sessions (RWO)              |
| `20-storage-minikube.yaml`   | Storage config for minikube/single-node (RWO only)      |
| `20-storage-production.yaml` | Storage config for production (RWX for concurrency)     |
| `30-orchestrator.yaml`       | Orchestrator deployment with RBAC for job management    |
| `40-agent-job-template.yaml` | Template for agent Job manifests                        |

### 2. Source Code (`src/k8s/`)

| File              | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `types.ts`        | TypeScript types for K8s runtime                     |
| `redis-client.ts` | Redis connection management                          |
| `job-runner.ts`   | Kubernetes Job creation and management               |
| `job-queue.ts`    | Distributed job queue with Redis                     |
| `ipc-redis.ts`    | Redis-based IPC for orchestrator-agent communication |
| `index.ts`        | Module exports                                       |

### 3. Runtime Factory (`src/runtime/`)

| File       | Purpose                                  |
| ---------- | ---------------------------------------- |
| `types.ts` | Common AgentRunner interface             |
| `index.ts` | Factory for Docker/K8s runtime selection |

## Communication Flow

### Agent Output (Agent → Orchestrator)

```
1. Agent publishes to Redis channel: `kubeclaw:messages:${groupFolder}`
2. Orchestrator subscribes to channel and receives messages
3. Messages parsed and sent to user via channel (WhatsApp, etc.)
```

### Agent Input (Orchestrator → Agent)

```
1. Orchestrator writes to Redis stream: `kubeclaw:input:${jobId}`
2. Agent reads from stream using XREAD (blocking)
3. Agent processes message and continues conversation
```

### Task Requests (Agent → Orchestrator)

```
1. Agent publishes to Redis channel: `kubeclaw:tasks:${groupFolder}`
2. Orchestrator processes task CRUD operations
3. Task stored in SQLite database
```

## Configuration

### Environment Variables

```bash
# Runtime selection
KUBECLAW_RUNTIME=kubernetes  # 'docker' or 'kubernetes'

# Redis connection
REDIS_URL=redis://kubeclaw-redis:6379

# Kubernetes settings
KUBECLAW_NAMESPACE=kubeclaw
MAX_CONCURRENT_JOBS=10

# Job resource limits
AGENT_JOB_MEMORY_REQUEST=512Mi
AGENT_JOB_MEMORY_LIMIT=4Gi
AGENT_JOB_CPU_REQUEST=500m
AGENT_JOB_CPU_LIMIT=2000m
```

### Backward Compatibility

The system supports dual-mode operation:

- Set `KUBECLAW_RUNTIME=docker` (default) for existing Docker behavior
- Set `KUBECLAW_RUNTIME=kubernetes` for K8s Jobs

No code changes required - the runtime factory selects the appropriate implementation.

## Deployment

### 1. Prerequisites

- Kubernetes cluster (v1.24+)
- Storage class supporting ReadWriteMany (e.g., AWS EFS, NFS)
- kubectl configured

### 2. Deploy Infrastructure

```bash
# Create namespace and network policies
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-network-policy.yaml

# Create Redis secret first (required for Redis ACL authentication)
kubectl create secret generic kubeclaw-redis \
  --from-literal=admin-password=$(openssl rand -base64 32) \
  -n kubeclaw

# Deploy Redis (requires Redis 7+ for ACL support)
kubectl apply -f k8s/10-redis.yaml

# Create storage (choose appropriate configuration):
# Option A: For minikube/single-node clusters (RWO only)
kubectl apply -f k8s/20-storage-minikube.yaml
# Option B: For production clusters with RWX support (EFS, NFS, etc.)
# kubectl apply -f k8s/20-storage-production.yaml

# Create secrets (Option A - Recommended for production)
kubectl create secret generic kubeclaw-secrets \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=claude-code-oauth-token=$CLAUDE_CODE_OAUTH_TOKEN \
  -n kubeclaw

# Create secrets (Option B - Using template file)
# Edit k8s/05-secrets.yaml with your values, then:
# kubectl apply -f k8s/05-secrets.yaml
```

### 3. Build and Deploy

```bash
# Build all container images (agent, browser sidecar, and adapters)
./container/build.sh --all

# Build orchestrator image
docker build -t kubeclaw-orchestrator:latest .

# Push to registry (or load into cluster)
kind load docker-image kubeclaw-agent:claude
kind load docker-image kubeclaw-agent:openrouter
kind load docker-image kubeclaw-browser-sidecar:latest
kind load docker-image kubeclaw-file-adapter:latest
kind load docker-image kubeclaw-http-adapter:latest
kind load docker-image kubeclaw-orchestrator:latest

# Deploy orchestrator
kubectl apply -f k8s/30-orchestrator.yaml
```

The `--all` flag builds:

- `kubeclaw-agent:claude` — main agent image (Claude SDK variant)
- `kubeclaw-agent:openrouter` — OpenRouter variant
- `kubeclaw-browser-sidecar:latest` — required for groups with `browserSidecar: true`
- `kubeclaw-file-adapter:latest` and `kubeclaw-http-adapter:latest` — sidecar adapters

For minimal K8s deployments that only need the Claude agent and browser sidecar, use `./container/build.sh --claude-only --browser` instead.

## Storage Configuration

KubeClaw requires persistent storage for two purposes:

- **Groups**: Agent code and configuration (50Gi default)
- **Sessions**: Claude SDK session data (20Gi default)

### Storage Access Modes

| Mode                  | Description                                          | Use Case                          |
| --------------------- | ---------------------------------------------------- | --------------------------------- |
| `ReadWriteOnce` (RWO) | Volume can be mounted by one node at a time          | Single-node clusters, minikube    |
| `ReadWriteMany` (RWX) | Volume can be mounted by multiple nodes concurrently | Production with concurrent agents |

### Environment-Specific Configurations

Choose the appropriate storage configuration for your environment:

#### Option A: Minikube / Local Development

Use for single-node clusters without RWX support:

```bash
kubectl apply -f k8s/20-storage-minikube.yaml
```

**Limitations:**

- Only ONE agent job can run at a time (no concurrent processing)
- Suitable for development and testing only
- See [Concurrency](#concurrency) section for workarounds

#### Option B: Production with RWX Support

Use for production environments with NFS/EFS/Azure Files:

```bash
kubectl apply -f k8s/20-storage-production.yaml
```

**Prerequisites by Platform:**

**AWS EKS with EFS:**

```bash
# Install EFS CSI driver
kubectl apply -k "github.com/kubernetes-sigs/aws-efs-csi-driver/deploy/kubernetes/overlays/stable/?ref=release-1.7"

# Create storage class (update with your EFS filesystem ID)
cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-sc
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-xxxxxxxxxxxxxxxxx
  directoryPerms: "700"
EOF
```

**Azure AKS with Azure Files:**

```bash
# Azure Files storage class is pre-installed
cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azurefile
provisioner: kubernetes.io/azure-file
mountOptions:
  - dir_mode=0777
  - file_mode=0777
EOF
```

**GCP GKE with Filestore:**

```bash
# Install Filestore CSI driver in GKE console
cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: filestore
provisioner: filestore.csi.storage.gke.io
volumeBindingMode: WaitForFirstConsumer
EOF
```

### Storage Troubleshooting

**Issue: PVC stuck in Pending**

```bash
# Check PVC status
kubectl describe pvc kubeclaw-groups -n kubeclaw

# Common causes:
# 1. No storage class supports RWX - use minikube config instead
# 2. Insufficient permissions - check cloud provider IAM
# 3. Resource quotas exceeded - check namespace limits
```

**Issue: Concurrent jobs fail with volume mount errors**

- Ensure you're using RWX storage class
- Check: `kubectl get storageclass` to see available classes
- For minikube: Accept that only one agent can run at a time

### Storage Recommendations

| Environment | Recommended Storage | Access Mode | Notes                     |
| ----------- | ------------------- | ----------- | ------------------------- |
| Minikube    | hostPath            | RWO         | Single node, single agent |
| Kind        | standard            | RWO         | Development only          |
| AWS EKS     | EFS                 | RWX         | Best for production       |
| Azure AKS   | Azure Files         | RWX         | Cost-effective            |
| GCP GKE     | Filestore           | RWX         | Enterprise option         |
| On-premise  | NFS/Rook Ceph       | RWX         | Requires setup            |

**Production Storage Best Practices:**

- Use RWX storage classes for concurrent agent support
- Enable volume encryption at rest
- Set up volume snapshots for backup
- Monitor storage usage and set alerts
- Use SSD-backed storage for better I/O performance

## Security Features

### Network Isolation

- Agents can only communicate with:
  - DNS (UDP 53)
  - Redis within namespace (TCP 6379)
  - HTTPS endpoints (TCP 443)
- Orchestrator has unrestricted egress but limited ingress

### RBAC

- Orchestrator has minimal permissions:
  - Create/get/list/watch/delete Jobs
  - Get/list/watch Pods
  - Get Pod logs

### Secrets

- API keys stored in Kubernetes Secrets
- Mounted as environment variables, never in code

## Monitoring

### Check Job Status

```bash
kubectl get jobs -n kubeclaw
kubectl describe job kubeclaw-agent-{folder}-{timestamp} -n kubeclaw
kubectl logs job/kubeclaw-agent-{folder}-{timestamp} -n kubeclaw
```

### Check Redis

```bash
# Connect with admin authentication (ACL required)
kubectl exec -it kubeclaw-redis-0 -n kubeclaw -- redis-cli -a $(kubectl get secret kubeclaw-redis -n kubeclaw -o jsonpath='{.data.admin-password}' | base64 -d)

# Test pub/sub
> PUBLISH kubeclaw:messages:main '{"type":"test","message":"hello"}'
> XADD kubeclaw:input:job-123 * text "Hello agent"

# Check ACL status
> ACL LIST
> ACL USERS
```

**Note:** Redis 7+ is required for ACL support. ACLs are persisted to `/data/redis-acl.conf`.

### Orchestrator Logs

```bash
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw
```

## Migration from Docker

1. **Data Migration**: Copy `groups/` and `data/` directories to PVCs
2. **Fresh Start**: Start with empty PVCs (sessions will be recreated)
3. **Hybrid Mode**: Run both Docker and K8s during transition

## Troubleshooting

### Jobs stuck in Pending

- Check PVC status: `kubectl get pvc -n kubeclaw`
- Check node resources: `kubectl describe nodes`
- Check storage class supports RWX

### Redis connection errors

- Verify Redis is running: `kubectl get pods -n kubeclaw`
- Check REDIS_URL environment variable
- Test connection from orchestrator pod

### Agent output not streaming

- Check Redis pub/sub: `kubectl exec kubeclaw-redis-0 -- redis-cli pubsub channels`
- Verify agent is publishing to correct channel
- Check orchestrator logs for IPC errors

## Performance Tuning

### Concurrency

**Important:** Concurrency is limited by your storage configuration:

| Storage Mode        | Max Concurrent Jobs | Use Case                             |
| ------------------- | ------------------- | ------------------------------------ |
| ReadWriteOnce (RWO) | 1                   | Development, single-node clusters    |
| ReadWriteMany (RWX) | 10+                 | Production with proper storage class |

**For RWO environments (minikube, single-node):**

```bash
# Set max concurrent jobs to 1 to avoid volume conflicts
MAX_CONCURRENT_JOBS=1
```

**For RWX environments (production):**

```bash
# Adjust based on cluster capacity
MAX_CONCURRENT_JOBS=10  # Default
```

Each job uses 500m-2000m CPU and 512Mi-4Gi memory. Plan your cluster capacity accordingly.

### Redis

- AOF fsync every second (good balance of durability/performance)
- Max memory 2GB with LRU eviction

### Job Cleanup

- `ttlSecondsAfterFinished: 3600` (1 hour)
- Failed jobs must be manually cleaned if needed
