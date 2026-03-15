#!/bin/bash
#
# Run E2E Tests in Docker
#
# This script sets up Docker-in-Docker environment and runs E2E tests
# inside a containerized environment.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
E2E_DIR="${PROJECT_ROOT}/e2e"
RESULTS_DIR="${E2E_DIR}/results"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.test.yml"
TEST_PHASE="${TEST_PHASE:-all}"
DEBUG_MODE="${DEBUG_MODE:-false}"
CLEANUP_ON_EXIT="${CLEANUP_ON_EXIT:-true}"

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Cleanup function
cleanup() {
  if [ "$CLEANUP_ON_EXIT" = "true" ]; then
    log_info "Cleaning up resources..."
    cd "${SCRIPT_DIR}"
    docker-compose -f "${COMPOSE_FILE}" down -v --remove-orphans 2>/dev/null || true
    docker network rm nanoclaw-e2e 2>/dev/null || true
    log_info "Cleanup complete"
  fi
}

# Set trap for cleanup
trap cleanup EXIT

# Create results directory
mkdir -p "${RESULTS_DIR}"

log_info "Starting E2E tests in Docker environment"
log_info "Project root: ${PROJECT_ROOT}"
log_info "Test phase: ${TEST_PHASE}"

# Check Docker is available
if ! command -v docker &> /dev/null; then
  log_error "Docker is not installed or not in PATH"
  exit 1
fi

# Check Docker Compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  log_error "Docker Compose is not installed"
  exit 1
fi

# Use docker-compose or docker compose
if docker compose version &> /dev/null; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

log_info "Using: ${COMPOSE_CMD}"

# Navigate to CI directory
cd "${SCRIPT_DIR}"

# Pull latest images
log_info "Pulling latest base images..."
${COMPOSE_CMD} -f "${COMPOSE_FILE}" pull --quiet 2>/dev/null || log_warn "Could not pull all images (this is usually OK)"

# Start services
log_info "Starting test environment..."
export TEST_PHASE="${TEST_PHASE}"
export DEBUG="${DEBUG_MODE}"

# Start Redis first
${COMPOSE_CMD} -f "${COMPOSE_FILE}" up -d redis

# Wait for Redis
log_info "Waiting for Redis to be ready..."
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  if ${COMPOSE_CMD} -f "${COMPOSE_FILE}" exec -T redis redis-cli ping 2>/dev/null | grep -q "PONG"; then
    log_info "Redis is ready"
    break
  fi
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -eq 0 ]; then
    log_error "Redis failed to start"
    exit 1
  fi
  sleep 1
done

# Start minikube (if needed for k8s tests)
if [ "${USE_MINIKUBE:-false}" = "true" ]; then
  log_info "Starting minikube..."
  ${COMPOSE_CMD} -f "${COMPOSE_FILE}" up -d minikube
  
  # Wait for minikube
  log_info "Waiting for minikube to be ready..."
  RETRIES=60
  while [ $RETRIES -gt 0 ]; do
    if ${COMPOSE_CMD} -f "${COMPOSE_FILE}" exec -T minikube minikube status 2>/dev/null | grep -q "host: Running"; then
      log_info "Minikube is ready"
      break
    fi
    RETRIES=$((RETRIES - 1))
    if [ $RETRIES -eq 0 ]; then
      log_error "Minikube failed to start"
      exit 1
    fi
    sleep 5
  done
fi

# Run tests
log_info "Running E2E tests..."
TEST_EXIT_CODE=0

${COMPOSE_CMD} -f "${COMPOSE_FILE}" up --abort-on-container-exit test-runner || TEST_EXIT_CODE=$?

# Copy results from container
log_info "Copying test results..."
${COMPOSE_CMD} -f "${COMPOSE_FILE}" cp test-runner:/workspace/results "${RESULTS_DIR}" 2>/dev/null || true

# Check for test results
if [ -f "${RESULTS_DIR}/test-results.json" ]; then
  log_info "Test results found in ${RESULTS_DIR}"
  
  # Generate reports
  if command -v node &> /dev/null; then
    log_info "Generating test reports..."
    node "${SCRIPT_DIR}/test-reporter.js" \
      --input="${RESULTS_DIR}/test-results.json" \
      --output="${RESULTS_DIR}/junit-results.xml" \
      --summary="${RESULTS_DIR}/test-summary.md" || true
  fi
else
  log_warn "No test results found"
fi

# Display summary
if [ $TEST_EXIT_CODE -eq 0 ]; then
  log_info "All tests passed!"
else
  log_error "Tests failed with exit code: ${TEST_EXIT_CODE}"
fi

# Show container logs on failure
if [ $TEST_EXIT_CODE -ne 0 ]; then
  log_info "Container logs:"
  ${COMPOSE_CMD} -f "${COMPOSE_FILE}" logs --tail=100 test-runner 2>/dev/null || true
fi

exit $TEST_EXIT_CODE
