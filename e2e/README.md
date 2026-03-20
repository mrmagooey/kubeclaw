# KubeClaw E2E Testing

End-to-end testing suite for KubeClaw Kubernetes deployment.

## Prerequisites

- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [minikube](https://minikube.sigs.k8s.io/docs/start/) or any Kubernetes cluster
- Docker (for building images)

## Quick Start

### 1. Start Minikube

```bash
minikube start --driver=docker --cpus=4 --memory=8192 --disk-size=40g
```

### 2. Build Images

```bash
# Build agent image
docker build -t kubeclaw-agent:latest -f container/Dockerfile .

# Build orchestrator image
docker build -t kubeclaw-orchestrator:latest -f Dockerfile .

# Load into minikube
minikube image load kubeclaw-agent:latest
minikube image load kubeclaw-orchestrator:latest
```

### 3. Deploy KubeClaw

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/10-redis.yaml
kubectl apply -f k8s/20-storage.yaml
kubectl apply -f k8s/30-orchestrator.yaml
kubectl apply -f k8s/01-network-policy.yaml
```

### 4. Run E2E Tests

```bash
# Apply test resources
kubectl apply -f e2e/manifests/test-namespace.yaml
kubectl apply -f e2e/manifests/test-pvc.yaml
kubectl apply -f e2e/manifests/test-jobs.yaml
kubectl apply -f e2e/manifests/network-test.yaml

# Watch test jobs
kubectl get jobs -n kubeclaw -l test=e2e -w

# Check logs
kubectl logs -n kubeclaw job/simple-job
```

### 5. Cleanup

```bash
# Remove test resources only
kubectl delete -f e2e/manifests/ --ignore-not-found=true

# Remove all kubeclaw resources
kubectl delete namespace kubeclaw
```

## Test Manifests

### test-namespace.yaml

Defines the kubeclaw namespace with resource quotas and limit ranges for testing.

### test-pvc.yaml

Test persistent volume claims with different access modes (RWO, RWX).

### test-jobs.yaml

Collection of test jobs:

- `simple-job`: Basic job that succeeds
- `failing-job`: Job that exits with error (for failure handling tests)
- `slow-job`: Job that sleeps for 30s (for concurrency/timeout tests)
- `resource-test-job`: Job with specific resource requests/limits
- `write-test-job`: Writes data to PVC
- `read-test-job`: Reads data from PVC
- `agent-like-job`: Mock agent job with KubeClaw environment variables

### network-test.yaml

Network policy validation:

- `network-test-external`: Tests external access is blocked
- `network-test-redis`: Tests Redis connectivity (should succeed)
- `network-test-dns`: Tests DNS resolution within namespace
- `network-test-port-scan`: Tests port connectivity to services

## Fixtures

### test-messages.json

Sample Redis pub/sub messages for testing:

- Agent output messages (text, tool_use, thinking)
- Task requests (schedule, pause, resume, cancel)
- Input stream messages
- Close sentinel messages

### test-config.env

Environment variables for test configuration. Source this file in test scripts:

```bash
set -a
source e2e/fixtures/test-config.env
set +a
```

## Troubleshooting

### Jobs stuck in Pending

Check resource quotas:

```bash
kubectl describe resourcequota -n kubeclaw
```

### PVC not binding

Check storage class:

```bash
kubectl get storageclass
kubectl describe pvc -n kubeclaw
```

### Network tests failing

Verify network policies:

```bash
kubectl get networkpolicies -n kubeclaw
kubectl describe networkpolicy kubeclaw-agent-policy -n kubeclaw
```

### Redis connection refused

Wait for Redis to be ready:

```bash
kubectl wait --for=condition=ready pod -l app=kubeclaw-redis -n kubeclaw --timeout=120s
```

### Images not found

Ensure images are loaded in minikube:

```bash
minikube image list | grep kubeclaw
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
- name: Start minikube
  uses: medyagh/setup-minikube@master
  with:
    driver: docker
    cpus: 4
    memory: 8192

- name: Deploy KubeClaw
  run: |
    kubectl apply -f k8s/
    kubectl wait --for=condition=ready pod -l app=kubeclaw-redis -n kubeclaw

- name: Run E2E Tests
  run: |
    kubectl apply -f e2e/manifests/
    ./e2e/scripts/wait-for-jobs.sh
```

## Test Labels

All test resources have labels for easy filtering:

```bash
# List all test resources
kubectl get all -n kubeclaw -l test=e2e

# List test jobs
kubectl get jobs -n kubeclaw -l test=e2e

# List network test pods
kubectl get pods -n kubeclaw -l test-type=network

# Cleanup only test resources
kubectl delete all -n kubeclaw -l test=e2e
```

## Resource Limits

Test jobs use minimal resources:

- CPU: 50m-500m request, 200m-1 limit
- Memory: 32Mi-512Mi request, 128Mi-1Gi limit

All test jobs have TTLs of 60-120 seconds for automatic cleanup.
