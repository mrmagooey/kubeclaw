---
name: debug
description: Debug Kubernetes agent issues. Use when things aren't working, agent jobs fail, authentication problems, or to understand how the Kubernetes system works. Covers logs, kubectl commands, PVCs, and common issues.
---

# KubeClaw Kubernetes Debugging

This guide covers debugging the Kubernetes-based agent execution system.

## Architecture Overview

```
Kubernetes Cluster
─────────────────────────────────────────────────────────────
deployment/kubeclaw-orchestrator      batch/Job: kubeclaw-agent-*
    │                                      │
    │ creates Job                          │ runs Claude Agent SDK
    │ via src/k8s/job-runner.ts            │ with MCP servers
    │                                      │
    ├── Redis Pub/Sub ─────────────────────► agent output stream
    ├── Redis Streams ────────────────────► agent input
    │
    PVC: kubeclaw-groups  → /workspace/group  (subPath: groupFolder)
    PVC: kubeclaw-sessions → /home/node/.claude (subPath: groupFolder)
```

**Important:** Agent Jobs run as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

## Log Locations

| Log               | Command                                                              | Content                            |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------- |
| Orchestrator logs | `kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw`       | Message routing, job creation, IPC |
| Agent job logs    | `kubectl logs job/<job-name> -n kubeclaw`                            | Claude SDK output, tool calls      |
| Recent jobs       | `kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp` | Job history                        |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# Check current log level
kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LOG_LEVEL")].value}'

# To enable debug, edit the deployment and set LOG_LEVEL=debug
kubectl edit deployment kubeclaw-orchestrator -n kubeclaw
# Add/modify the LOG_LEVEL environment variable
```

Debug level shows:

- Full job specifications
- Redis IPC operations
- Real-time agent output

## Common Issues

### 1. "Agent not responding"

**Check the orchestrator logs:**

```bash
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=100
```

Common causes:

#### Job Creation Failed

```
Error creating job: ...
```

**Fix:** Check orchestrator has proper RBAC permissions to create Jobs:

```bash
kubectl get role kubeclaw-orchestrator -n kubeclaw
```

#### Redis Connection Issues

```
Error connecting to Redis: ...
```

**Fix:** Verify Redis is running and `REDIS_URL` env var is set:

```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-redis
kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="REDIS_URL")].value}'
```

### 2. Job Stuck in Pending

**Check job status:**

```bash
kubectl describe job <job-name> -n kubeclaw
```

Common causes:

#### PVC Not Bound

```
Warning  FailedMount  ...  kubelet  Unable to attach or mount volumes
```

**Fix:** Check PVC status:

```bash
kubectl get pvc -n kubeclaw
```

#### Insufficient Resources

```
Warning  FailedScheduling  ...  insufficient cpu/memory
```

**Fix:** Check node resources:

```bash
kubectl top nodes
kubectl describe nodes
```

### 3. Redis Connection Errors

**Check Redis health:**

```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-redis
kubectl logs statefulset/kubeclaw-redis -n kubeclaw --tail=50
```

**Verify REDIS_URL is configured:**

```bash
kubectl get secret kubeclaw-redis -n kubeclaw -o jsonpath='{.data.admin-password}' | base64 -d
```

### 4. Session Not Resuming

If sessions aren't being resumed (new session ID every time):

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the job, `HOME=/home/node`, so it looks at `/home/node/.claude/projects/`.

**Check the PVC mount:**

```bash
# Verify the sessions PVC is mounted correctly
kubectl get job <job-name> -n kubeclaw -o jsonpath='{.spec.template.spec.volumes}'
```

**Verify sessions are accessible:**

```bash
# Check what's in the sessions PVC from the orchestrator
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  ls -la /app/groups/<groupFolder>/.claude/projects/ 2>/dev/null || echo "No sessions found"
```

**Fix:** Ensure `src/k8s/job-runner.ts` mounts the sessions PVC with correct subPath:

```typescript
{
  name: 'sessions',
  persistentVolumeClaim: { claimName: 'kubeclaw-sessions' }
}
// ...
{
  name: 'sessions',
  mountPath: '/home/node/.claude',  // NOT /root/.claude
  subPath: groupFolder
}
```

### 5. Authentication Errors

If the agent fails with authentication errors:

**Check the secrets exist:**

```bash
kubectl get secret kubeclaw-secrets -n kubeclaw
```

**Verify secret keys:**

```bash
kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath='{.data}' | jq keys
```

Should contain one of:

- `CLAUDE_CODE_OAUTH_TOKEN` (subscription)
- `ANTHROPIC_API_KEY` (pay-per-use)

## Manual Testing

### Check orchestrator is running:

```bash
kubectl get pods -n kubeclaw
```

### Check recent agent jobs:

```bash
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -10
```

### View logs for a specific agent job:

```bash
kubectl logs job/<job-name> -n kubeclaw
```

### Check Redis connectivity from orchestrator:

```bash
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  node -e "const r=require('ioredis'); const c=new r(process.env.REDIS_URL); c.ping().then(console.log)"
```

### Inspect PVC usage:

```bash
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  du -sh /app/groups/* 2>/dev/null | head -20
```

## IPC Debugging

The orchestrator communicates with agents via Redis Pub/Sub and Streams:

### Check Redis pub/sub channels (active agent output streams):

```bash
kubectl exec -it statefulset/kubeclaw-redis -n kubeclaw -- \
  redis-cli -a $(kubectl get secret kubeclaw-redis -n kubeclaw \
    -o jsonpath='{.data.admin-password}' | base64 -d) \
  pubsub channels 'kubeclaw:*'
```

### Monitor all kubeclaw Redis traffic:

```bash
kubectl exec -it statefulset/kubeclaw-redis -n kubeclaw -- \
  redis-cli -a <password> monitor | grep kubeclaw
```

### Check pending input streams (messages queued for agent):

```bash
kubectl exec -it statefulset/kubeclaw-redis -n kubeclaw -- \
  redis-cli -a <password> keys 'kubeclaw:input:*'
```

**Redis channel types:**

- `kubeclaw:output:<job-name>` - Agent publishes output chunks
- `kubeclaw:input:<job-name>` - Stream for agent input
- `kubeclaw:done:<job-name>` - Agent signals completion

## Session Persistence

Claude sessions are stored per-group in the `kubeclaw-sessions` PVC at subPath matching the group folder. Each group has its own session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match the job user's HOME directory:

- Job user: `node`
- Job HOME: `/home/node`
- Mount target: `/home/node/.claude/` (NOT `/root/.claude/`)

To clear sessions:

```bash
# Clear all sessions for all groups (WARNING: destructive)
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  rm -rf /app/groups/*/.claude/

# Clear sessions for a specific group
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  rm -rf /app/groups/<groupFolder>/.claude/

# Also clear the session ID from KubeClaw's tracking (stored in SQLite)
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  sqlite3 /app/store/messages.db "DELETE FROM sessions WHERE group_folder = '<groupFolder>'"
```

To verify session resumption is working, check the logs for the same session ID across messages:

```bash
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw | grep "Session initialized" | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## Rebuilding After Changes

```bash
# Rebuild main app and roll out
npm run build
docker build -t kubeclaw-orchestrator:latest .
kind load docker-image kubeclaw-orchestrator:latest  # or push to registry
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw

# Rebuild agent container
./container/build.sh
kind load docker-image kubeclaw-agent:claude  # or push to registry
# New jobs will pick up the new image automatically
```

## Checking Agent Image

```bash
# List images in cluster (if using local registry)
docker images | grep kubeclaw-agent

# Check what's in the image by running a test job
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-info
  namespace: kubeclaw
spec:
  template:
    spec:
      containers:
      - name: agent
        image: kubeclaw-agent:claude
        command:
        - /bin/sh
        - -c
        - |
          echo "=== Node version ==="
          node --version
          echo "=== Claude Code version ==="
          claude --version
          echo "=== Home directory ==="
          echo "HOME=$HOME"
          echo "=== Workspace ==="
          ls -la /workspace/
      restartPolicy: Never
  backoffLimit: 0
EOF

# Wait and check logs
kubectl wait --for=condition=complete job/agent-info -n kubeclaw --timeout=30s
kubectl logs job/agent-info -n kubeclaw
kubectl delete job agent-info -n kubeclaw
```
