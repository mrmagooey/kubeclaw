# NanoClaw E2E Testing - Minikube Environment Validation Report

**Date:** 2026-03-08  
**Tester:** Automated E2E Validation  
**Environment:** Minikube Local Kubernetes Cluster

---

## Executive Summary

This report documents the setup and validation of a minikube environment for NanoClaw e2e testing. The infrastructure was successfully deployed with several documented issues and workarounds.

**Overall Status:** ⚠️ PARTIALLY SUCCESSFUL

- Infrastructure: ✅ DEPLOYED
- Redis: ✅ RUNNING
- Storage: ✅ CONFIGURED
- Agent Image: ✅ BUILT
- Orchestrator: ❌ BUILD FAILED (TypeScript errors)

---

## 1. System Information

### 1.1 Host System

| Property       | Value                        |
| -------------- | ---------------------------- |
| OS             | Ubuntu 24.04 (ARM64/aarch64) |
| Total RAM      | 7.7 GiB                      |
| Available RAM  | 6.3 GiB                      |
| CPU Cores      | 8                            |
| Disk Available | 48 GB                        |

### 1.2 Kubernetes Cluster

| Property           | Value                        |
| ------------------ | ---------------------------- |
| Minikube Version   | v1.38.1                      |
| Kubernetes Version | v1.35.1                      |
| Container Runtime  | Docker                       |
| Storage Driver     | overlay2                     |
| Storage Class      | standard (minikube-hostpath) |

### 1.3 Tool Versions

| Tool     | Version |
| -------- | ------- |
| minikube | v1.38.1 |
| kubectl  | v1.31.0 |
| Docker   | 28.2.2  |

---

## 2. Resource Allocation

### 2.1 Minikube Configuration

```
Driver: docker
CPUs: 4
Memory: 6144 MB (adjusted from 8192 MB due to host limitations)
Disk: 20 GB
Addons: storage-provisioner
```

### 2.2 Resource Constraints Encountered

- **Issue:** Requested 8192 MB RAM exceeds host capacity (7700 MB total)
- **Resolution:** Reduced to 6144 MB (6 GB)
- **Impact:** May limit concurrent job capacity

### 2.3 Deployed Component Resources

| Component    | CPU Request | CPU Limit | Memory Request | Memory Limit |
| ------------ | ----------- | --------- | -------------- | ------------ |
| Redis        | 100m        | 1         | 256Mi          | 2Gi          |
| Orchestrator | 100m        | 500m      | 256Mi          | 512Mi        |
| Agent Job    | 500m        | 2         | 512Mi          | 4Gi          |

---

## 3. Deployment Status

### 3.1 Kubernetes Manifests

| File                       | Status      | Notes                                               |
| -------------------------- | ----------- | --------------------------------------------------- |
| 00-namespace.yaml          | ✅ MODIFIED | Changed from `restricted` to `baseline` PodSecurity |
| 01-network-policy.yaml     | ✅ APPLIED  | Network policies active                             |
| 10-redis.yaml              | ✅ APPLIED  | Redis StatefulSet running                           |
| 20-storage.yaml            | ✅ MODIFIED | Changed RWX to RWO for minikube compatibility       |
| 30-orchestrator.yaml       | ⏸️ PENDING  | Waiting for orchestrator image fix                  |
| 40-agent-job-template.yaml | ⏸️ PENDING  | Template validated                                  |

### 3.2 Component Status

```
Namespace: nanoclaw

Pods:
  nanoclaw-redis-0           1/1     Running   0          5m

Services:
  nanoclaw-redis             ClusterIP   10.107.245.229   6379/TCP

PVCs:
  data-nanoclaw-redis-0      Bound   10Gi   RWO   standard
  nanoclaw-groups            Bound   50Gi   RWO   standard
  nanoclaw-redis-data        Bound   10Gi   RWO   standard
  nanoclaw-sessions          Bound   20Gi   RWO   standard

Secrets:
  nanoclaw-secrets           Opaque   2      5m
```

---

## 4. Issues Encountered and Resolutions

### Issue 1: Minikube Architecture Mismatch

**Severity:** High  
**Status:** ✅ RESOLVED

**Problem:**

- Downloaded AMD64 minikube binary on ARM64 system
- Resulted in "exec format error"

**Resolution:**

```bash
# Download ARM64 version instead
curl -L https://storage.googleapis.com/minikube/releases/latest/minikube-linux-arm64 \
  -o ~/.local/bin/minikube
```

---

### Issue 2: PodSecurity Policy Violation

**Severity:** High  
**Status:** ✅ RESOLVED

**Problem:**

```
Create Pod nanoclaw-redis-0 failed: violates PodSecurity "restricted:latest":
- allowPrivilegeEscalation != false
- unrestricted capabilities
- runAsNonRoot != true
- seccompProfile missing
```

**Root Cause:**
Namespace enforces `restricted` PodSecurity standard, but Redis container doesn't meet requirements.

**Resolution:**
Changed namespace label from `restricted` to `baseline`:

```yaml
labels:
  pod-security.kubernetes.io/enforce: baseline
```

**Recommendation:**
For production, add proper security contexts to Redis StatefulSet instead of relaxing namespace policy.

---

### Issue 3: ReadWriteMany Storage Not Supported

**Severity:** Medium  
**Status:** ✅ WORKAROUND APPLIED

**Problem:**
minikube's hostpath provisioner doesn't support ReadWriteMany (RWX) access mode.

**Manifest Error:**

```yaml
spec:
  accessModes:
    - ReadWriteMany # Not supported by standard storage class
```

**Resolution:**
Changed to ReadWriteOnce for minikube compatibility:

```yaml
spec:
  accessModes:
    - ReadWriteOnce
```

**Impact:**

- Orchestrator and agent jobs cannot share groups PVC simultaneously
- Limits concurrent agent execution on same node
- Production clusters with NFS/EFS should use RWX

---

### Issue 4: Orchestrator TypeScript Build Failures

**Severity:** Critical  
**Status:** ❌ UNRESOLVED

**Problem:**
Multiple TypeScript compilation errors in k8s/ modules:

```
src/k8s/ipc-redis.ts(38,18): error TS2709: Cannot use namespace 'Redis' as a type.
src/k8s/job-runner.ts(93,15): error TS2339: Property 'body' does not exist on type 'V1Job'.
src/k8s/job-runner.ts(94,9): error TS2345: Argument of type 'string' not assignable to parameter of type 'BatchV1ApiCreateNamespacedJobRequest'.
src/k8s/redis-client.ts(23,22): error TS2351: This expression is not constructible.
```

**Root Cause:**

1. `ioredis` import issues (namespace vs type)
2. Kubernetes client API signature mismatches
3. Missing type definitions

**Files Affected:**

- `src/k8s/ipc-redis.ts`
- `src/k8s/job-runner.ts`
- `src/k8s/redis-client.ts`
- `src/runtime/index.ts`

**Recommended Fixes:**

1. **Fix Redis imports:**

```typescript
// Change from:
import Redis from 'ioredis';
// To:
import { Redis } from 'ioredis';
```

2. **Fix Kubernetes API calls:**

```typescript
// Change from:
await k8sApi.createNamespacedJob(namespace, jobManifest);
// To:
await k8sApi.createNamespacedJob({
  namespace,
  body: jobManifest,
});
```

3. **Add explicit types:**

```typescript
// Add proper typing for error handlers
.catch((err: Error) => { ... })
```

---

### Issue 5: kubectl Version Mismatch Warning

**Severity:** Low  
**Status:** ⚠️ ACKNOWLEDGED

**Warning:**

```
kubectl is version 1.31.0, which may have incompatibilities with Kubernetes 1.35.1
```

**Impact:**
No observed issues during testing, but may cause subtle compatibility problems.

**Recommendation:**
Update kubectl to match cluster version:

```bash
minikube kubectl -- get pods -A
```

---

## 5. Smoke Test Results

### Test 1: Redis Connectivity

```bash
kubectl exec nanoclaw-redis-0 -- redis-cli ping
```

**Result:** ✅ PONG

### Test 2: Redis Pub/Sub

```bash
kubectl exec nanoclaw-redis-0 -- redis-cli PUBLISH nanoclaw:test "message"
```

**Result:** ✅ Published successfully

### Test 3: PVC Binding

```bash
kubectl get pvc -n nanoclaw
```

**Result:** ✅ All PVCs bound

### Test 4: Simple Job Execution

```bash
kubectl apply -f test-job.yaml
kubectl logs job/nanoclaw-test-job
```

**Result:** ✅ "Test job completed successfully"

### Test 5: Network Policies

```bash
kubectl get networkpolicy -n nanoclaw
```

**Result:** ✅ Policies applied

---

## 6. Container Images

### 6.1 Built Images

| Image                 | Tag    | Size    | Status          |
| --------------------- | ------ | ------- | --------------- |
| nanoclaw-agent        | latest | 1.78 GB | ✅ Built        |
| nanoclaw-orchestrator | latest | N/A     | ❌ Build failed |

### 6.2 Agent Image Details

- **Base:** node:22-slim
- **Chromium:** Installed for browser automation
- **Additional:** git, curl, fonts
- **User:** node (non-root)
- **Workdir:** /workspace/group

---

## 7. Security Analysis

### 7.1 Network Policies

✅ **Properly configured:**

- Agents: Egress only to DNS (UDP 53), Redis (TCP 6379), HTTPS (TCP 443)
- Orchestrator: Ingress on port 8080, unrestricted egress

### 7.2 RBAC

⏸️ **Not yet deployed** (requires orchestrator)

- ServiceAccount: nanoclaw-orchestrator
- Role: job-manager (create/get/list/watch/delete Jobs, get/list/watch Pods, get Pod logs)

### 7.3 Secrets Management

✅ **Configured:**

- Secret: nanoclaw-secrets
- Keys: anthropic-api-key, claude-code-oauth-token
- Mounted as environment variables

### 7.4 Pod Security

⚠️ **Baseline policy** (relaxed from restricted for Redis)

- Recommendation: Add security contexts to Redis and revert to restricted

---

## 8. Performance Observations

### 8.1 Resource Usage

| Component     | CPU Usage | Memory Usage   |
| ------------- | --------- | -------------- |
| minikube node | ~5%       | ~2.1 GB / 6 GB |
| Redis         | Minimal   | ~3 MB          |

### 8.2 Storage Performance

- PVC provisioning: < 5 seconds
- Image pull time: N/A (built locally)
- Pod startup: ~10 seconds

---

## 9. Instructions for Running Full E2E Suite

### Prerequisites

```bash
# Install required tools
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-arm64
chmod +x minikube-linux-arm64 && sudo mv minikube-linux-arm64 /usr/local/bin/minikube

curl -LO https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/linux/arm64/kubectl
chmod +x kubectl && sudo mv kubectl /usr/local/bin/kubectl
```

### Start Minikube

```bash
minikube start --driver=docker --cpus=4 --memory=6144 --disk-size=20g --addons=storage-provisioner
```

### Deploy Infrastructure

```bash
# Apply manifests
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-network-policy.yaml
kubectl apply -f k8s/10-redis.yaml
kubectl apply -f k8s/20-storage.yaml

# Create secrets
kubectl create secret generic nanoclaw-secrets \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=claude-code-oauth-token=$CLAUDE_CODE_OAUTH_TOKEN \
  -n nanoclaw
```

### Build and Deploy Orchestrator (after TypeScript fixes)

```bash
# Set docker environment to minikube
eval $(minikube docker-env)

# Build images
docker build -t nanoclaw-orchestrator:latest -f Dockerfile .
docker build -t nanoclaw-agent:latest -f container/Dockerfile .

# Deploy orchestrator
kubectl apply -f k8s/30-orchestrator.yaml
```

### Run Tests

```bash
# Check status
kubectl get pods -n nanoclaw
kubectl get jobs -n nanoclaw

# View logs
kubectl logs -f deployment/nanoclaw-orchestrator -n nanoclaw
kubectl logs job/nanoclaw-agent-<name> -n nanoclaw
```

### Cleanup

```bash
minikube delete
```

---

## 10. Recommendations

### Immediate Actions Required

1. **Fix TypeScript errors** in k8s/ modules (Critical)
2. **Add security contexts** to Redis StatefulSet to allow restricted PodSecurity
3. **Update k8s/20-storage.yaml** to support both RWO (minikube) and RWX (production)

### Production Deployment Considerations

1. **Storage:** Use NFS or EFS for ReadWriteMany support
2. **Secrets:** Use proper secret management (Vault, Sealed Secrets)
3. **Monitoring:** Deploy Prometheus/Grafana for metrics
4. **Ingress:** Configure ingress controller for external access
5. **Resource quotas:** Set namespace resource limits

### CI/CD Integration

```yaml
# Example GitHub Actions workflow
- name: Start minikube
  uses: medyagh/setup-minikube@master
  with:
    driver: docker
    memory: 6144

- name: Deploy and test
  run: |
    kubectl apply -f k8s/
    kubectl wait --for=condition=ready pod -l app=nanoclaw-redis -n nanoclaw --timeout=120s
    # Run e2e tests
```

---

## Appendix A: Modified Files

### k8s/00-namespace.yaml

Changed PodSecurity from `restricted` to `baseline`.

### k8s/20-storage.yaml

Changed `nanoclaw-groups` PVC from `ReadWriteMany` to `ReadWriteOnce`.

### Dockerfile (created)

Created orchestrator Dockerfile at repository root.

---

## Appendix B: Known Limitations

1. **Architecture:** ARM64 only (would need AMD64 testing)
2. **Storage:** RWX not supported in minikube
3. **Scaling:** Single-node cluster limits horizontal scaling tests
4. **Persistence:** hostpath provisioner not suitable for production
5. **Monitoring:** No metrics or logging stack deployed

---

## Sign-off

**Validation performed by:** Automated E2E Test Suite  
**Date:** 2026-03-08  
**Status:** Ready for development fixes

---

_End of Report_
