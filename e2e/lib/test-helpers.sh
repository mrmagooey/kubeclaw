#!/bin/bash
# E2E Test Helpers Library for NanoClaw Kubernetes Testing

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================================================
# LOGGING FUNCTIONS
# ============================================================================

log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

log_debug() {
    echo -e "${CYAN}[DEBUG]${NC} $1"
}

# ============================================================================
# KUBECTL HELPER FUNCTIONS
# ============================================================================

kubectl_apply() {
    local file="$1"
    local namespace="${2:-default}"
    
    if [ -f "$file" ]; then
        kubectl apply -f "$file" -n "$namespace" > /dev/null 2>&1
    else
        echo "$file" | kubectl apply -f - -n "$namespace" > /dev/null 2>&1
    fi
}

kubectl_delete() {
    local resource="$1"
    local namespace="${2:-default}"
    
    kubectl delete "$resource" -n "$namespace" --ignore-not-found=true > /dev/null 2>&1 || true
}

kubectl_wait_for_resource() {
    local resource_type="$1"
    local resource_name="$2"
    local namespace="${3:-default}"
    local timeout="${4:-60}"
    
    kubectl wait --for=condition=ready "$resource_type" "$resource_name" \
        -n "$namespace" --timeout="${timeout}s" > /dev/null 2>&1 || return 1
}

# ============================================================================
# WAIT FUNCTIONS
# ============================================================================

wait_for_pod() {
    local pod_selector="$1"
    local namespace="${2:-default}"
    local timeout="${3:-60}"
    local interval=2
    
    log_debug "Waiting for pod matching '$pod_selector' in namespace '$namespace' (timeout: ${timeout}s)"
    
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        if kubectl get pods -n "$namespace" -l "app=$pod_selector" 2>/dev/null | grep -q "Running"; then
            # Check if pod is ready
            local ready_pods
            ready_pods=$(kubectl get pods -n "$namespace" -l "app=$pod_selector" -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
            if echo "$ready_pods" | grep -q "True"; then
                return 0
            fi
        fi
        
        # Also check by name prefix
        local pod_name
        pod_name=$(kubectl get pods -n "$namespace" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null | grep "^${pod_selector}" || true)
        if [ -n "$pod_name" ]; then
            local ready
            ready=$(kubectl get pod "$pod_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
            if [ "$ready" = "True" ]; then
                return 0
            fi
        fi
        
        sleep $interval
        elapsed=$((elapsed + interval))
        
        if [ $((elapsed % 10)) -eq 0 ]; then
            log_debug "Still waiting... ($elapsed/$timeout)"
        fi
    done
    
    log_fail "Timeout waiting for pod '$pod_selector' after ${timeout}s"
    return 1
}

wait_for_job() {
    local job_name="$1"
    local namespace="${2:-default}"
    local timeout="${3:-60}"
    local interval=2
    
    log_debug "Waiting for job '$job_name' in namespace '$namespace' (timeout: ${timeout}s)"
    
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        local succeeded
        local failed
        
        succeeded=$(kubectl get job "$job_name" -n "$namespace" -o jsonpath='{.status.succeeded}' 2>/dev/null || echo "0")
        failed=$(kubectl get job "$job_name" -n "$namespace" -o jsonpath='{.status.failed}' 2>/dev/null || echo "0")
        
        if [ "$succeeded" -ge 1 ] 2>/dev/null; then
            return 0
        fi
        
        if [ "$failed" -ge 1 ] 2>/dev/null; then
            log_fail "Job '$job_name' failed"
            return 1
        fi
        
        sleep $interval
        elapsed=$((elapsed + interval))
        
        if [ $((elapsed % 10)) -eq 0 ]; then
            log_debug "Still waiting for job... ($elapsed/$timeout)"
        fi
    done
    
    log_fail "Timeout waiting for job '$job_name' after ${timeout}s"
    return 1
}

wait_for_deployment() {
    local deployment_name="$1"
    local namespace="${2:-default}"
    local timeout="${3:-60}"
    
    log_debug "Waiting for deployment '$deployment_name' in namespace '$namespace' (timeout: ${timeout}s)"
    
    kubectl rollout status deployment/"$deployment_name" -n "$namespace" --timeout="${timeout}s" > /dev/null 2>&1
}

wait_for_service() {
    local service_name="$1"
    local namespace="${2:-default}"
    local timeout="${3:-30}"
    local interval=2
    
    log_debug "Waiting for service '$service_name' endpoints in namespace '$namespace' (timeout: ${timeout}s)"
    
    local elapsed=0
    while [ $elapsed -lt $timeout ]; do
        local endpoints
        endpoints=$(kubectl get endpoints "$service_name" -n "$namespace" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)
        if [ -n "$endpoints" ]; then
            return 0
        fi
        
        sleep $interval
        elapsed=$((elapsed + interval))
    done
    
    log_fail "Timeout waiting for service '$service_name' endpoints after ${timeout}s"
    return 1
}

# ============================================================================
# ASSERTION FUNCTIONS
# ============================================================================

assert_equals() {
    local expected="$1"
    local actual="$2"
    local message="${3:-Assertion failed}"
    
    if [ "$expected" = "$actual" ]; then
        return 0
    else
        log_fail "$message: expected '$expected', got '$actual'"
        return 1
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local message="${3:-Assertion failed}"
    
    if echo "$haystack" | grep -q "$needle"; then
        return 0
    else
        log_fail "$message: '$haystack' does not contain '$needle'"
        return 1
    fi
}

assert_not_empty() {
    local value="$1"
    local message="${2:-Value is empty}"
    
    if [ -n "$value" ]; then
        return 0
    else
        log_fail "$message"
        return 1
    fi
}

assert_resource_exists() {
    local resource_type="$1"
    local resource_name="$2"
    local namespace="${3:-default}"
    
    if kubectl get "$resource_type" "$resource_name" -n "$namespace" > /dev/null 2>&1; then
        return 0
    else
        log_fail "Resource $resource_type/$resource_name does not exist in namespace $namespace"
        return 1
    fi
}

assert_resource_not_exists() {
    local resource_type="$1"
    local resource_name="$2"
    local namespace="${3:-default}"
    
    if ! kubectl get "$resource_type" "$resource_name" -n "$namespace" > /dev/null 2>&1; then
        return 0
    else
        log_fail "Resource $resource_type/$resource_name still exists in namespace $namespace"
        return 1
    fi
}

assert_pod_status() {
    local pod_name="$1"
    local expected_status="$2"
    local namespace="${3:-default}"
    
    local actual_status
    actual_status=$(kubectl get pod "$pod_name" -n "$namespace" -o jsonpath='{.status.phase}' 2>/dev/null)
    
    if [ "$actual_status" = "$expected_status" ]; then
        return 0
    else
        log_fail "Pod $pod_name status is '$actual_status', expected '$expected_status'"
        return 1
    fi
}

assert_job_succeeded() {
    local job_name="$1"
    local namespace="${2:-default}"
    
    local succeeded
    succeeded=$(kubectl get job "$job_name" -n "$namespace" -o jsonpath='{.status.succeeded}' 2>/dev/null || echo "0")
    
    if [ "$succeeded" -ge 1 ] 2>/dev/null; then
        return 0
    else
        log_fail "Job $job_name did not succeed"
        return 1
    fi
}

# ============================================================================
# TEST FRAMEWORK HELPERS
# ============================================================================

test_cleanup() {
    local namespace="${1:-default}"
    local pattern="${2:-test-}"
    
    log_info "Cleaning up test resources matching '$pattern' in namespace '$namespace'"
    
    # Delete jobs
    kubectl delete jobs -n "$namespace" -l "test-run=e2e" --ignore-not-found=true > /dev/null 2>&1 || true
    
    # Delete pods
    kubectl delete pods -n "$namespace" --field-selector=status.phase=Succeeded --ignore-not-found=true > /dev/null 2>&1 || true
    kubectl delete pods -n "$namespace" --field-selector=status.phase=Failed --ignore-not-found=true > /dev/null 2>&1 || true
    
    # Wait a moment for deletions to process
    sleep 2
}

get_pod_logs() {
    local pod_name="$1"
    local namespace="${2:-default}"
    local container="${3:-}"
    
    if [ -n "$container" ]; then
        kubectl logs "$pod_name" -c "$container" -n "$namespace" 2>/dev/null || echo "[No logs available]"
    else
        kubectl logs "$pod_name" -n "$namespace" 2>/dev/null || echo "[No logs available]"
    fi
}

get_job_logs() {
    local job_name="$1"
    local namespace="${2:-default}"
    
    local pod_name
    pod_name=$(kubectl get pods -n "$namespace" --selector=job-name="$job_name" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [ -n "$pod_name" ]; then
        get_pod_logs "$pod_name" "$namespace"
    else
        echo "[No pod found for job $job_name]"
    fi
}

exec_in_pod() {
    local pod_name="$1"
    local namespace="${2:-default}"
    shift 2
    
    kubectl exec "$pod_name" -n "$namespace" -- "$@"
}

# ============================================================================
# REDIS HELPERS
# ============================================================================

redis_cli() {
    local command="$1"
    local namespace="${2:-default}"
    local redis_host="${3:-redis}"
    
    kubectl run redis-cli-tmp --rm -i --restart=Never -n "$namespace" \
        --image=redis:7-alpine -- redis-cli -h "$redis_host" $command 2>/dev/null
}

redis_ping() {
    local namespace="${1:-default}"
    local redis_host="${2:-redis}"
    
    kubectl run redis-ping --rm -i --restart=Never -n "$namespace" \
        --image=redis:7-alpine -- redis-cli -h "$redis_host" PING 2>/dev/null | grep -q "PONG"
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

generate_test_id() {
    date +%s%N | sha256sum | head -c 8
}

time_command() {
    local start_time
    local end_time
    start_time=$(date +%s)
    "$@"
    end_time=$(date +%s)
    echo $((end_time - start_time))
}

retry_command() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        if "$@"; then
            return 0
        fi
        
        log_debug "Attempt $attempt failed, retrying in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
    done
    
    return 1
}

check_prerequisites() {
    local required_commands=("kubectl" "docker")
    local missing_commands=()
    
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            missing_commands+=("$cmd")
        fi
    done
    
    if [ ${#missing_commands[@]} -gt 0 ]; then
        log_fail "Missing required commands: ${missing_commands[*]}"
        return 1
    fi
    
    if ! kubectl cluster-info &> /dev/null; then
        log_fail "No Kubernetes cluster accessible via kubectl"
        return 1
    fi
    
    return 0
}
