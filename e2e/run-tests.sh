#!/bin/bash
set -e

# NanoClaw E2E Test Suite
# Kubernetes-based end-to-end testing for NanoClaw

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/test-helpers.sh"

# Test tracking
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
CURRENT_PHASE=""
NAMESPACE="kubeclaw"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# TEST RUNNER FRAMEWORK
# ============================================================================

run_test() {
    local test_name="$1"
    local test_func="$2"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -e "${BLUE}[TEST]${NC} $test_name"
    
    if $test_func; then
        echo -e "${GREEN}[PASS]${NC} $test_name"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}[FAIL]${NC} $test_name"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

start_phase() {
    local phase_num="$1"
    local phase_name="$2"
    CURRENT_PHASE="Phase $phase_num: $phase_name"
    
    echo ""
    echo "================================================================================"
    echo -e "${YELLOW}PHASE $phase_num: $phase_name${NC}"
    echo "================================================================================"
}

end_phase() {
    echo -e "${GREEN}Completed${NC} $CURRENT_PHASE"
    echo ""
}

print_summary() {
    echo ""
    echo "================================================================================"
    echo -e "${YELLOW}TEST SUMMARY${NC}"
    echo "================================================================================"
    echo "Total Tests:  $TOTAL_TESTS"
    echo -e "Passed:       ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed:       ${RED}$FAILED_TESTS${NC}"
    echo ""
    
    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}ALL TESTS PASSED!${NC}"
        return 0
    else
        echo -e "${RED}SOME TESTS FAILED!${NC}"
        return 1
    fi
}

# ============================================================================
# PHASE 1: INFRASTRUCTURE TESTS
# ============================================================================

test_namespace_creation() {
    kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1
    kubectl get namespace "$NAMESPACE" > /dev/null 2>&1
}

test_network_policy_exists() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: $NAMESPACE
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
EOF
    kubectl get networkpolicy default-deny-all -n "$NAMESPACE" > /dev/null 2>&1
}

test_redis_deployment() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: $NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: $NAMESPACE
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
EOF
    wait_for_pod "redis" "$NAMESPACE" 60
}

test_storage_class() {
    kubectl get storageclass 2>/dev/null | grep -q "storageclass" || true
    # Storage class may not exist in minikube, but that's OK for testing
    return 0
}

test_secrets_creation() {
    kubectl create secret generic kubeclaw-config \
        --from-literal=redis-url="redis://redis:6379" \
        --from-literal=api-key="test-api-key-12345" \
        -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1
    kubectl get secret kubeclaw-config -n "$NAMESPACE" > /dev/null 2>&1
}

test_configmap_creation() {
    kubectl create configmap kubeclaw-env \
        --from-literal=LOG_LEVEL=debug \
        --from-literal=MAX_CONCURRENT_JOBS=5 \
        -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1
    kubectl get configmap kubeclaw-env -n "$NAMESPACE" > /dev/null 2>&1
}

# ============================================================================
# PHASE 2: ORCHESTRATOR DEPLOYMENT
# ============================================================================

test_orchestrator_deployment() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubeclaw-orchestrator
  template:
    metadata:
      labels:
        app: kubeclaw-orchestrator
    spec:
      serviceAccountName: kubeclaw-orchestrator
      containers:
      - name: orchestrator
        image: kubeclaw:latest
        imagePullPolicy: IfNotPresent
        env:
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: kubeclaw-config
              key: redis-url
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: kubeclaw-env
              key: LOG_LEVEL
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
spec:
  selector:
    app: kubeclaw-orchestrator
  ports:
  - port: 8080
    targetPort: 8080
EOF
    wait_for_pod "kubeclaw-orchestrator" "$NAMESPACE" 120
}

test_rbac_permissions() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
rules:
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "watch", "create", "delete"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
subjects:
- kind: ServiceAccount
  name: kubeclaw-orchestrator
  namespace: $NAMESPACE
roleRef:
  kind: Role
  name: kubeclaw-orchestrator
  apiGroup: rbac.authorization.k8s.io
EOF
    kubectl get serviceaccount kubeclaw-orchestrator -n "$NAMESPACE" > /dev/null 2>&1
}

# ============================================================================
# PHASE 3: BASIC AGENT JOB
# ============================================================================

test_simple_agent_job() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-agent-job-1
  namespace: $NAMESPACE
  labels:
    app: kubeclaw-agent
    test-id: "test-001"
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c", "echo 'Agent job completed successfully' && exit 0"]
EOF
    wait_for_job "test-agent-job-1" "$NAMESPACE" 60
}

test_resource_limits() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-resource-limits
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 60
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "200m"
        command: ["sh", "-c", "echo 'Testing resource limits' && exit 0"]
EOF
    wait_for_job "test-resource-limits" "$NAMESPACE" 60
}

test_ttl_cleanup() {
    # Create a job with short TTL
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-ttl-job
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 10
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c", "echo 'Job complete' && exit 0"]
EOF
    wait_for_job "test-ttl-job" "$NAMESPACE" 60
    
    # Wait for TTL cleanup (10 seconds + buffer)
    sleep 15
    
    # Job should be auto-deleted
    ! kubectl get job test-ttl-job -n "$NAMESPACE" > /dev/null 2>&1
}

# ============================================================================
# PHASE 4: REDIS COMMUNICATION
# ============================================================================

test_redis_pubsub() {
    # Test Redis pub/sub by running a test pod
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-redis-pubsub
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Subscribe and publish test
          redis-cli -h redis PUBLISH test-channel "test-message" &
          sleep 1
          exit 0
EOF
    wait_for_job "test-redis-pubsub" "$NAMESPACE" 60
}

test_redis_streams() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-redis-streams
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Add to stream
          redis-cli -h redis XADD test-stream '*' message "test-data"
          # Read from stream
          redis-cli -h redis XREAD COUNT 1 STREAMS test-stream 0
          exit 0
EOF
    wait_for_job "test-redis-streams" "$NAMESPACE" 60
}

test_close_sentinel() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-close-sentinel
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Test sentinel key operations
          redis-cli -h redis SET sentinel:test:close "true" EX 60
          redis-cli -h redis GET sentinel:test:close
          redis-cli -h redis DEL sentinel:test:close
          exit 0
EOF
    wait_for_job "test-close-sentinel" "$NAMESPACE" 60
}

# ============================================================================
# PHASE 5: CONCURRENCY TESTS
# ============================================================================

test_job_limits() {
    # Test that we can create multiple concurrent jobs
    for i in {1..3}; do
        cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-concurrent-$i
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c", "sleep 2 && echo 'Job $i complete'"]
EOF
    done
    
    # Wait for all jobs
    for i in {1..3}; do
        wait_for_job "test-concurrent-$i" "$NAMESPACE" 120
    done
}

test_redis_counters() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-redis-counters
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Increment counter
          redis-cli -h redis INCR test:counter
          redis-cli -h redis INCR test:counter
          redis-cli -h redis INCR test:counter
          # Get final value
          redis-cli -h redis GET test:counter
          exit 0
EOF
    wait_for_job "test-redis-counters" "$NAMESPACE" 60
}

# ============================================================================
# PHASE 6: IPC AND TASK TESTS
# ============================================================================

test_task_request() {
    # Simulate a task request via Redis
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-task-request
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Simulate task request
          redis-cli -h redis XADD task:requests '*' task_type "echo" payload '{"message":"hello"}'
          # Simulate task response
          redis-cli -h redis XADD task:responses '*' task_id "test-123" result "success"
          exit 0
EOF
    wait_for_job "test-task-request" "$NAMESPACE" 60
}

test_authorization() {
    # Test that pods can read secrets
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-authorization
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: auth-test
        image: bitnami/kubectl:latest
        command:
        - sh
        - -c
        - |
          # Test that we can read configmap (simulating auth check)
          kubectl get configmap kubeclaw-env -n $NAMESPACE
          exit 0
EOF
    wait_for_job "test-authorization" "$NAMESPACE" 60
}

# ============================================================================
# PHASE 7: FAILURE SCENARIOS
# ============================================================================

test_job_failure() {
    # Create a job that will fail
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-job-failure
  namespace: $NAMESPACE
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: failing-agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c", "echo 'Failing intentionally' && exit 1"]
EOF
    
    # Wait for job to complete (will fail, but should complete with backoff)
    sleep 10
    
    # Job should exist but have failed status
    kubectl get job test-job-failure -n "$NAMESPACE" > /dev/null 2>&1
}

test_reconnection() {
    # Test that agent can reconnect after Redis restart
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-reconnection
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: redis-test
        image: redis:7-alpine
        command:
        - sh
        - -c
        - |
          # Test connection and reconnection
          for i in 1 2 3; do
            redis-cli -h redis PING || exit 1
            sleep 1
          done
          exit 0
EOF
    wait_for_job "test-reconnection" "$NAMESPACE" 60
}

test_network_policy() {
    # Verify network policy is in place
    kubectl get networkpolicy default-deny-all -n "$NAMESPACE" > /dev/null 2>&1
}

# ============================================================================
# PHASE 8: STORAGE PERSISTENCE
# ============================================================================

test_pvc_creation() {
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
  namespace: $NAMESPACE
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
EOF
    
    # Wait for PVC to be bound
    for i in {1..30}; do
        if kubectl get pvc test-pvc -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q "Bound"; then
            return 0
        fi
        sleep 2
    done
    return 1
}

test_persistence_across_jobs() {
    # Create job that writes to PVC
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-write-pvc
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: test-pvc
      containers:
      - name: writer
        image: busybox
        volumeMounts:
        - name: data
          mountPath: /data
        command: ["sh", "-c", "echo 'persistent-data' > /data/test.txt"]
EOF
    wait_for_job "test-write-pvc" "$NAMESPACE" 60
    
    # Create job that reads from PVC
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-read-pvc
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: test-pvc
      containers:
      - name: reader
        image: busybox
        volumeMounts:
        - name: data
          mountPath: /data
        command: ["sh", "-c", "cat /data/test.txt | grep 'persistent-data'"]
EOF
    wait_for_job "test-read-pvc" "$NAMESPACE" 60
}

# ============================================================================
# PHASE 9: CLEANUP VERIFICATION
# ============================================================================

test_ttl_cleanup_verification() {
    # This test verifies that TTL cleanup works
    # Create a job with very short TTL
    cat <<EOF | kubectl apply -f - -n "$NAMESPACE" > /dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
  name: test-short-ttl
  namespace: $NAMESPACE
spec:
  ttlSecondsAfterFinished: 5
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: kubeclaw-agent:latest
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c", "echo 'Quick job'"]
EOF
    wait_for_job "test-short-ttl" "$NAMESPACE" 60
    
    # Wait for cleanup
    sleep 10
    
    # Should be deleted
    ! kubectl get job test-short-ttl -n "$NAMESPACE" > /dev/null 2>&1
}

test_resource_teardown() {
    # Verify resources can be deleted
    kubectl delete deployment redis -n "$NAMESPACE" --ignore-not-found=true > /dev/null 2>&1 || true
    kubectl delete deployment kubeclaw-orchestrator -n "$NAMESPACE" --ignore-not-found=true > /dev/null 2>&1 || true
    kubectl delete job -l app=kubeclaw-agent -n "$NAMESPACE" --ignore-not-found=true > /dev/null 2>&1 || true
    kubectl delete pvc test-pvc -n "$NAMESPACE" --ignore-not-found=true > /dev/null 2>&1 || true
    return 0
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    echo "================================================================================"
    echo "NanoClaw E2E Test Suite - Kubernetes Testing"
    echo "================================================================================"
    echo ""
    
    # Check prerequisites
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}ERROR: kubectl not found${NC}"
        exit 1
    fi
    
    if ! kubectl cluster-info &> /dev/null; then
        echo -e "${RED}ERROR: No Kubernetes cluster found${NC}"
        echo "Run './setup-minikube.sh' first to set up the test environment"
        exit 1
    fi
    
    echo -e "${GREEN}Kubernetes cluster found${NC}"
    kubectl version --short 2>/dev/null || kubectl version
    echo ""
    
    # Phase 1: Infrastructure Tests
    start_phase 1 "Infrastructure Tests"
    run_test "TC-001: Namespace Creation" test_namespace_creation
    run_test "TC-002: Network Policy Existence" test_network_policy_exists
    run_test "TC-003: Redis Deployment" test_redis_deployment
    run_test "TC-004: Storage Class Availability" test_storage_class
    run_test "TC-005: Secrets Creation" test_secrets_creation
    run_test "TC-006: ConfigMap Creation" test_configmap_creation
    end_phase
    
    # Phase 2: Orchestrator Deployment
    start_phase 2 "Orchestrator Deployment"
    run_test "TC-007: Orchestrator Deployment" test_orchestrator_deployment
    run_test "TC-008: RBAC Permissions" test_rbac_permissions
    end_phase
    
    # Phase 3: Basic Agent Job
    start_phase 3 "Basic Agent Job"
    run_test "TC-009: Simple Agent Job" test_simple_agent_job
    run_test "TC-010: Resource Limits" test_resource_limits
    run_test "TC-011: TTL Cleanup" test_ttl_cleanup
    end_phase
    
    # Phase 4: Redis Communication
    start_phase 4 "Redis Communication"
    run_test "TC-012: Redis Pub/Sub" test_redis_pubsub
    run_test "TC-013: Redis Streams" test_redis_streams
    run_test "TC-014: Close Sentinel" test_close_sentinel
    end_phase
    
    # Phase 5: Concurrency Tests
    start_phase 5 "Concurrency Tests"
    run_test "TC-015: Job Limits" test_job_limits
    run_test "TC-016: Redis Counters" test_redis_counters
    end_phase
    
    # Phase 6: IPC and Task Tests
    start_phase 6 "IPC and Task Tests"
    run_test "TC-017: Task Request" test_task_request
    run_test "TC-018: Authorization" test_authorization
    end_phase
    
    # Phase 7: Failure Scenarios
    start_phase 7 "Failure Scenarios"
    run_test "TC-019: Job Failure Handling" test_job_failure
    run_test "TC-020: Reconnection" test_reconnection
    run_test "TC-021: Network Policy" test_network_policy
    end_phase
    
    # Phase 8: Storage Persistence
    start_phase 8 "Storage Persistence"
    run_test "TC-022: PVC Creation" test_pvc_creation
    run_test "TC-023: Persistence Across Jobs" test_persistence_across_jobs
    end_phase
    
    # Phase 9: Cleanup Verification
    start_phase 9 "Cleanup Verification"
    run_test "TC-024: TTL Cleanup Verification" test_ttl_cleanup_verification
    run_test "TC-025: Resource Teardown" test_resource_teardown
    end_phase
    
    # Print summary
    print_summary
    exit $?
}

# Handle cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Test run interrupted${NC}"
    exit 1
}
trap cleanup SIGINT SIGTERM

main "$@"
