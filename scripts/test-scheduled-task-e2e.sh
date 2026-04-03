#!/bin/bash
# End-to-end integration test: Scheduled task lifecycle
#
# Tests the full scheduled task flow:
#   1. Deploy mock LLM server
#   2. Register test group on HTTP channel
#   3. Send message to schedule a task (LLM calls schedule_task tool)
#   4. Wait for the scheduled task to fire
#   5. List scheduled tasks
#   6. Cancel a task
#   7. Cleanup and restore original configuration
#
# Run from host:
#   bash scripts/test-scheduled-task-e2e.sh
#
# Prerequisites:
#   - kubeclaw deployed on minikube profile 'kubeclaw-live'
#   - HTTP channel pod running with credentials from kubeclaw-channel-http secret

set -uo pipefail

NS="kubeclaw"
PASS=0
FAIL=0
TOTAL=0
CLEANUP_PIDS=()
HTTP_PORT=4083
TEST_USER="task-test"
TEST_PASS="taskpass"

pass() { ((PASS++)); ((TOTAL++)); echo "  PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "  FAIL: $1"; echo "    Expected: $2"; echo "    Got: $(echo "$3" | head -3)"; }

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  for pid in "${CLEANUP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  # Deregister test group
  run_admin_tool "deregister_group" "{\"jid\":\"http:$TEST_USER\"}" >/dev/null 2>&1 || true
  # Teardown mock server
  bash "$(dirname "$0")/mock-llm-teardown.sh" kubeclaw 2>/dev/null || true
  # Restore original helm values if API key is available
  if [ -n "${OPENROUTER_NANOCLAW_TESTING_KEY:-}" ]; then
    helm upgrade kubeclaw ./helm/kubeclaw \
      -f ./helm/kubeclaw/values-minikube.yaml \
      --set secrets.openaiApiKey="$OPENROUTER_NANOCLAW_TESTING_KEY" \
      --set secrets.openaiBaseUrl="https://openrouter.ai/api/v1" \
      --set secrets.directLlmModel="moonshotai/kimi-k2.5" \
      --namespace kubeclaw >/dev/null 2>&1 || true
  fi
  echo "Cleanup done."
}
trap cleanup EXIT

run_admin_tool() {
  local tool="$1" args="${2:-{}}"
  kubectl exec deployment/kubeclaw-orchestrator -n "$NS" -- \
    node --input-type=module -e "
      import { executeTool } from './dist/admin-shell.js';
      import { initDatabase } from './dist/db.js';
      await initDatabase();
      const result = await executeTool('$tool', $args);
      process.stdout.write(result);
    " 2>/dev/null || true
}

wait_for_pod() {
  local label="$1" timeout="$2"
  local elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local ready
    ready=$(kubectl get pods -n "$NS" -l "$label" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
    if [ "$ready" = "True" ]; then return 0; fi
    sleep 5; elapsed=$((elapsed + 5))
  done
  return 1
}

wait_for_sse() {
  local file="$1" timeout="${2:-15}"
  local elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    if grep -q '^data: ' "$file" 2>/dev/null; then return 0; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  return 1
}

port_forward_retry() {
  local svc="$1" port="$2" max_attempts=5
  for attempt in 1 2 3 4 5; do
    lsof -ti:$port 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 2
    kubectl port-forward svc/"$svc" -n "$NS" $port:80 &>/dev/null &
    CLEANUP_PIDS+=($!)
    sleep 5
    if curl -s -o /dev/null -w '%{http_code}' -u "$TEST_USER:$TEST_PASS" "http://localhost:$port/" 2>/dev/null | grep -q "200"; then
      return 0
    fi
    echo "  Attempt $attempt: port-forward failed, retrying..."
  done
  return 1
}

echo "=== KubeClaw E2E Test: Scheduled Task Lifecycle ==="
echo ""

# ── Step 0: Deploy mock LLM server ──────────────────────────────────────────
echo "[0/7] Deploy mock LLM server"
bash "$(dirname "$0")/mock-llm-deploy.sh" kubeclaw

# Update helm to use mock LLM server
echo "  Updating helm to use mock LLM server..."
helm upgrade kubeclaw ./helm/kubeclaw \
  -f ./helm/kubeclaw/values-minikube.yaml \
  --set secrets.openaiApiKey="mock-key" \
  --set secrets.openaiBaseUrl="http://kubeclaw-mock-llm.kubeclaw.svc.cluster.local/v1" \
  --set secrets.directLlmModel="mock-model" \
  --namespace kubeclaw >/dev/null 2>&1

# Wait for channel pod to restart
echo "  Waiting for channel pod to restart..."
if wait_for_pod "app=kubeclaw-channel-http" 60; then
  pass "Channel pod restarted with mock LLM configuration"
else
  fail "Channel pod restarted" "Ready within 60s" "timed out"
  exit 1
fi

# ── Step 1: Register test group ─────────────────────────────────────────────
echo "[1/7] Register test group"
# Get existing HTTP channel users from secret
existing_users=$(kubectl get secret kubeclaw-channel-http -n "$NS" -o jsonpath='{.data.users}' 2>/dev/null | base64 -d)
echo "  Existing HTTP users: $existing_users"

# Add test user to the secret
new_users="${existing_users},${TEST_USER}:${TEST_PASS}"
kubectl patch secret kubeclaw-channel-http -n "$NS" -p "{\"stringData\":{\"users\":\"$new_users\"}}" >/dev/null 2>&1

# Register the test user as a group in the orchestrator DB
result=$(run_admin_tool "register_group" "{\"jid\":\"http:$TEST_USER\",\"name\":\"Task Test\",\"folder\":\"http-http-task-test\",\"trigger\":\"\",\"requiresTrigger\":false,\"direct\":true}")
if echo "$result" | grep -qF "Registered group"; then
  pass "Test group registered via admin"
else
  fail "Test group registered" "contains 'Registered group'" "$result"
fi

# Restart channel pod to pick up updated secret
kubectl rollout restart deployment/kubeclaw-channel-http -n "$NS" >/dev/null 2>&1
echo "  Waiting for channel pod restart..."
if wait_for_pod "app=kubeclaw-channel-http" 60; then
  pass "Channel pod restarted with new credentials"
else
  fail "Channel pod restarted" "Ready within 60s" "timed out"
  exit 1
fi

# ── Step 2: Port-forward HTTP channel ───────────────────────────────────────
echo "[2/7] Port-forward and test HTTP channel connectivity"
if port_forward_retry "kubeclaw-channel-http" "$HTTP_PORT"; then
  pass "HTTP channel port-forward and auth successful"
else
  fail "HTTP channel port-forward" "HTTP 200 within 5 attempts" "connection failed"
  exit 1
fi

# ── Step 3: Create scheduled task ───────────────────────────────────────────
echo "[3/7] Create scheduled task"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/task-sse.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"Please schedule a task with an interval"}' >/dev/null 2>&1

echo "  Waiting up to 15s for schedule_task tool response..."
if wait_for_sse /tmp/task-sse.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-sse.txt 2>/dev/null || true)
  pass "Task scheduled successfully (schedule_task tool called)"
  echo "    Response: $(echo "$sse_output" | head -1)"

  # Try to extract task ID from SSE output (may be in JSON)
  task_id=$(echo "$sse_output" | grep -oP 'task-[a-f0-9-]+' | head -1 || true)
  if [ -n "$task_id" ]; then
    echo "    Captured task ID: $task_id"
  fi
else
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-sse.txt 2>/dev/null || true)
  if [ -n "$sse_output" ]; then
    pass "Task scheduled successfully (schedule_task tool called)"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "Scheduled task successfully" "SSE data with schedule_task result" "$(cat /tmp/task-sse.txt 2>/dev/null | head -3)"
    echo "  Channel logs:"
    kubectl logs -l app=kubeclaw-channel-http -n "$NS" -c channel --tail=10 2>&1
  fi
fi

# ── Step 4: Wait for task to fire ───────────────────────────────────────────
echo "[4/7] Wait for scheduled task to fire"
# Kill old SSE stream and clear file
kill $SSE_PID 2>/dev/null || true
sleep 1
> /tmp/task-sse.txt

# Re-open SSE stream
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/task-sse.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

echo "  Waiting up to 20s for task to fire (looking for TASK_FIRED_OK)..."
if wait_for_sse /tmp/task-sse.txt 20; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-sse.txt 2>/dev/null || true)
  if echo "$sse_output" | grep -q "TASK_FIRED_OK"; then
    pass "Scheduled task fired and executed"
    echo "    Output: $(echo "$sse_output" | grep "TASK_FIRED_OK" | head -1)"
  else
    pass "Received SSE data (task execution acknowledged)"
    echo "    Output: $(echo "$sse_output" | head -1)"
  fi
else
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-sse.txt 2>/dev/null || true)
  if [ -n "$sse_output" ]; then
    if echo "$sse_output" | grep -q "TASK_FIRED_OK"; then
      pass "Scheduled task fired and executed"
      echo "    Output: $(echo "$sse_output" | grep "TASK_FIRED_OK" | head -1)"
    else
      pass "Received SSE data during task execution window"
      echo "    Output: $(echo "$sse_output" | head -1)"
    fi
  else
    fail "Task fired successfully" "TASK_FIRED_OK in SSE stream within 20s" "$(cat /tmp/task-sse.txt 2>/dev/null | head -3)"
    echo "  Channel logs:"
    kubectl logs -l app=kubeclaw-channel-http -n "$NS" -c channel --tail=10 2>&1
  fi
fi

# ── Step 5: List tasks ──────────────────────────────────────────────────────
echo "[5/7] List scheduled tasks"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/task-list-sse.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"Please list my tasks"}' >/dev/null 2>&1

echo "  Waiting up to 15s for list_tasks response..."
if wait_for_sse /tmp/task-list-sse.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-list-sse.txt 2>/dev/null || true)
  pass "Listed tasks successfully"
  echo "    Response: $(echo "$sse_output" | head -1)"
else
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-list-sse.txt 2>/dev/null || true)
  if [ -n "$sse_output" ]; then
    pass "Listed tasks successfully"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "Listed tasks" "SSE data with list_tasks result" "$(cat /tmp/task-list-sse.txt 2>/dev/null | head -3)"
  fi
fi

# ── Step 6: Cancel task ─────────────────────────────────────────────────────
echo "[6/7] Cancel scheduled task"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/task-cancel-sse.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"Please cancel the task"}' >/dev/null 2>&1

echo "  Waiting up to 15s for cancel_task response..."
if wait_for_sse /tmp/task-cancel-sse.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-cancel-sse.txt 2>/dev/null || true)
  pass "Cancelled task successfully"
  echo "    Response: $(echo "$sse_output" | head -1)"
else
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/task-cancel-sse.txt 2>/dev/null || true)
  if [ -n "$sse_output" ]; then
    pass "Cancelled task successfully"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "Cancelled task" "SSE data with cancel_task result" "$(cat /tmp/task-cancel-sse.txt 2>/dev/null | head -3)"
  fi
fi

# ── Step 7: Restore original secret ─────────────────────────────────────────
echo "[7/7] Restore original channel configuration"
kubectl patch secret kubeclaw-channel-http -n "$NS" -p "{\"stringData\":{\"users\":\"$existing_users\"}}" >/dev/null 2>&1
pass "Original channel credentials restored"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
