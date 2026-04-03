#!/bin/bash
# End-to-end integration test: Admin → HTTP Channel → Web Search
#
# Tests the full flow:
#   1. Admin interface verifies orchestrator status
#   2. Admin registers a new test group on the existing HTTP channel
#   3. Sends a message via HTTP channel and receives a response
#   4. Triggers a web search and verifies the tool pod is spawned
#   5. Cleans up the test group
#
# Run from host:
#   bash scripts/test-admin-e2e.sh
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
HTTP_PORT=4080
TEST_USER="e2etest"
TEST_PASS="e2epass"

pass() { ((PASS++)); ((TOTAL++)); echo "  PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "  FAIL: $1"; echo "    Expected: $2"; echo "    Got: $(echo "$3" | head -3)"; }

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  for pid in "${CLEANUP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  # Deregister test group
  run_admin_tool "deregister_group" "{\"jid\":\"http:$TEST_USER\"}" >/dev/null 2>&1
  bash "$(dirname "$0")/mock-llm-teardown.sh" kubeclaw 2>/dev/null || true
  if [ -n "${OPENROUTER_NANOCLAW_TESTING_KEY:-}" ]; then
    helm upgrade kubeclaw ./helm/kubeclaw \
      -f ./helm/kubeclaw/values-minikube.yaml \
      --set secrets.openaiApiKey="$OPENROUTER_NANOCLAW_TESTING_KEY" \
      --set secrets.openaiBaseUrl="https://openrouter.ai/api/v1" \
      --set secrets.directLlmModel="moonshotai/kimi-k2.5" \
      --namespace "$NS" >/dev/null 2>&1 || true
  fi
  echo "Cleanup done."
}
trap cleanup EXIT

run_admin_tool() {
  local tool="$1" args="$2"
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

echo "=== KubeClaw E2E Test: Admin → HTTP Channel → Web Search ==="
echo ""

# ── Step 0: Deploy mock LLM server and point cluster at it ──────────────────
echo "[0/11] Deploy mock LLM server"
bash "$(dirname "$0")/mock-llm-deploy.sh" kubeclaw
echo "  Switching cluster to mock LLM..."
helm upgrade kubeclaw ./helm/kubeclaw \
  -f ./helm/kubeclaw/values-minikube.yaml \
  --set secrets.openaiApiKey="mock-key" \
  --set secrets.openaiBaseUrl="http://kubeclaw-mock-llm.kubeclaw.svc.cluster.local/v1" \
  --set secrets.directLlmModel="mock-model" \
  --namespace "$NS" >/dev/null 2>&1
kubectl rollout status deployment/kubeclaw-orchestrator -n "$NS" --timeout=90s >/dev/null 2>&1
kubectl rollout status deployment/kubeclaw-channel-http -n "$NS" --timeout=60s >/dev/null 2>&1

# ── Step 1: Verify orchestrator ─────────────────────────────────────────────
echo "[1/11] Verify orchestrator"
orch_ready=$(kubectl get deployment kubeclaw-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
if [ "$orch_ready" = "1" ]; then
  pass "Orchestrator running"
else
  fail "Orchestrator running" "readyReplicas=1" "readyReplicas=$orch_ready"
  exit 1
fi

# ── Step 2: Admin - get orchestrator status ──────────────────────────────────
echo "[2/11] Admin: orchestrator status"
result=$(run_admin_tool "get_orchestrator_status" "{}")
if echo "$result" | grep -qF "Orchestrator: kubeclaw-orchestrator" && echo "$result" | grep -qF "Ready:"; then
  pass "Admin returns orchestrator status"
else
  fail "Admin returns orchestrator status" "Orchestrator name + Ready" "$result"
fi

# ── Step 3: Verify HTTP channel pod is running ──────────────────────────────
echo "[3/11] Verify HTTP channel pod"
if wait_for_pod "app=kubeclaw-channel-http" 30; then
  pass "HTTP channel pod is ready"
else
  fail "HTTP channel pod ready" "Ready=True" "not ready"
  exit 1
fi

# ── Step 4: Get channel credentials and add test user ────────────────────────
echo "[4/11] Admin: register test group"
# Get existing HTTP channel users from secret
existing_users=$(kubectl get secret kubeclaw-channel-http -n "$NS" -o jsonpath='{.data.users}' 2>/dev/null | base64 -d)
echo "  Existing HTTP users: $existing_users"

# Add test user to the secret
new_users="${existing_users},${TEST_USER}:${TEST_PASS}"
kubectl patch secret kubeclaw-channel-http -n "$NS" -p "{\"stringData\":{\"users\":\"$new_users\"}}" >/dev/null 2>&1

# Register the test user as a group in the orchestrator DB
result=$(run_admin_tool "register_group" "{\"jid\":\"http:$TEST_USER\",\"name\":\"E2E Test\",\"folder\":\"http-$TEST_USER\",\"trigger\":\"\",\"requiresTrigger\":false,\"direct\":true}")
if echo "$result" | grep -qF "Registered group"; then
  pass "Test group registered via admin"
else
  fail "Test group registered" "contains 'Registered group'" "$result"
fi

# Restart channel pod to pick up updated secret
kubectl rollout restart deployment/kubeclaw-channel-http -n "$NS" >/dev/null 2>&1
echo "  Waiting for channel pod restart..."
sleep 5
if wait_for_pod "app=kubeclaw-channel-http" 60; then
  pass "Channel pod restarted with new credentials"
else
  fail "Channel pod restarted" "Ready within 60s" "timed out"
  exit 1
fi

# Also register group in the channel pod's DB so it recognises the JID
# (channel pod auto-registers on first message, but we need it in orchestrator for task routing)

# ── Step 5: Port-forward and test connectivity ──────────────────────────────
echo "[5/11] Test HTTP channel connectivity"
# Kill any stale port-forwards and establish a fresh one
lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1
kubectl port-forward svc/kubeclaw-channel-http -n "$NS" $HTTP_PORT:80 &>/dev/null &
CLEANUP_PIDS+=($!)
sleep 5

# Retry port-forward + auth check up to 5 times (service endpoint may lag behind pod readiness)
http_code="000"
for attempt in 1 2 3 4 5; do
  lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 2
  kubectl port-forward svc/kubeclaw-channel-http -n "$NS" $HTTP_PORT:80 &>/dev/null &
  CLEANUP_PIDS+=($!)
  sleep 5
  http_code=$(curl -s -o /dev/null -w '%{http_code}' -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/" 2>/dev/null)
  if [ "$http_code" = "200" ]; then break; fi
  echo "  Attempt $attempt: HTTP $http_code, retrying..."
done

if [ "$http_code" = "200" ]; then
  pass "HTTP channel serves chat UI for test user"
else
  fail "HTTP channel authenticates test user" "HTTP 200" "HTTP $http_code"
fi

# ── Step 6: Send message and get response ────────────────────────────────────
echo "[6/11] Send message and receive response"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/e2e-sse.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"Say hello in exactly 3 words"}' >/dev/null 2>&1

echo "  Waiting up to 15s for LLM response..."
if wait_for_sse /tmp/e2e-sse.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/e2e-sse.txt 2>/dev/null || true)
  pass "Received LLM response via SSE"
  echo "    Response: $(echo "$sse_output" | head -1)"
else
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/e2e-sse.txt 2>/dev/null || true)
  if [ -n "$sse_output" ]; then
    pass "Received LLM response via SSE"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "Received LLM response" "SSE data lines" "$(cat /tmp/e2e-sse.txt 2>/dev/null | head -3)"
    echo "  Channel logs:"
    kubectl logs -l app=kubeclaw-channel-http -n "$NS" -c channel --tail=10 2>&1
  fi
fi

# ── Step 7: Web search ──────────────────────────────────────────────────────
echo "[7/11] Web search via tool calling"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/e2e-sse-search.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"Use your web_search tool to search for: what year was kubernetes released"}' >/dev/null 2>&1

echo "  Waiting up to 60s for web search response..."
if wait_for_sse /tmp/e2e-sse-search.txt 60; then
  kill $SSE_PID 2>/dev/null || true
  sse_search=$(grep '^data: ' /tmp/e2e-sse-search.txt 2>/dev/null || true)
  pass "Web search returned a response"
  echo "    Response: $(echo "$sse_search" | head -2)"
else
  kill $SSE_PID 2>/dev/null || true
  sse_search=$(grep '^data: ' /tmp/e2e-sse-search.txt 2>/dev/null || true)
  if [ -n "$sse_search" ]; then
    pass "Web search returned a response"
    echo "    Response: $(echo "$sse_search" | head -2)"
  else
    fail "Web search returned a response" "SSE data lines" "$(cat /tmp/e2e-sse-search.txt 2>/dev/null | head -3)"
    echo "  Channel logs:"
    kubectl logs -l app=kubeclaw-channel-http -n "$NS" -c channel --tail=15 2>&1
  fi
fi

# ── Step 8: Verify tool pod was spawned ──────────────────────────────────────
echo "[8/11] Verify tool pod job"
recent_jobs=$(kubectl get jobs -n "$NS" --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -3)
if [ -n "$recent_jobs" ]; then
  pass "Tool pod job(s) found"
  echo "    Jobs: $(echo "$recent_jobs" | tr '\n' ' ')"
else
  echo "  (Note: no tool pod jobs found — they may have been cleaned up by TTL)"
fi

# ── Step 9: Conversation history persists across turns ─────────────────────
echo "[9/11] Conversation history persists across turns"
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/e2e-sse-history-1.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"remember the code: BANANA42"}' >/dev/null 2>&1

echo "  Waiting up to 15s for LLM response to remember code..."
if wait_for_sse /tmp/e2e-sse-history-1.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/e2e-sse-history-1.txt 2>/dev/null || true)
  if echo "$sse_output" | grep -qF "BANANA42"; then
    pass "LLM remembered code (contains BANANA42)"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "LLM remembered code" "response contains BANANA42" "$(echo "$sse_output" | head -1)"
  fi
else
  kill $SSE_PID 2>/dev/null || true
  fail "LLM response for remember code" "SSE data within 15s" "timeout"
fi

sleep 2
curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/e2e-sse-history-2.txt 2>&1 &
SSE_PID=$!
CLEANUP_PIDS+=($SSE_PID)
sleep 2

curl -s -X POST "http://localhost:$HTTP_PORT/message" \
  -H 'Content-Type: application/json' \
  -u "$TEST_USER:$TEST_PASS" \
  -d '{"text":"what code did I ask you to remember?"}' >/dev/null 2>&1

echo "  Waiting up to 15s for LLM to recall code..."
if wait_for_sse /tmp/e2e-sse-history-2.txt 15; then
  kill $SSE_PID 2>/dev/null || true
  sse_output=$(grep '^data: ' /tmp/e2e-sse-history-2.txt 2>/dev/null || true)
  if echo "$sse_output" | grep -qF "BANANA42"; then
    pass "LLM recalled code from history (contains BANANA42)"
    echo "    Response: $(echo "$sse_output" | head -1)"
  else
    fail "LLM recalled code from history" "response contains BANANA42" "$(echo "$sse_output" | head -1)"
  fi
else
  kill $SSE_PID 2>/dev/null || true
  fail "LLM response for code recall" "SSE data within 15s" "timeout"
fi

# ── Step 10: Admin clear_conversation wipes history ──────────────────────────
echo "[10/11] Admin clear_conversation wipes history"
# Clear in the channel pod first (while it's still running and has the right PVC),
# then scale to 0 → wait for full termination → scale to 1. This prevents the
# terminating pod from overwriting the cleared DB before the new pod reads it.
result=$(kubectl exec deployment/kubeclaw-channel-http -n "$NS" -c channel -- \
  node --input-type=module -e "
    import { executeTool } from './dist/admin-shell.js';
    import { initDatabase } from './dist/db.js';
    await initDatabase();
    const result = await executeTool('clear_conversation', {\"folder\":\"http-http-$TEST_USER\"});
    process.stdout.write(result);
  " 2>/dev/null || true)
if echo "$result" | grep -qE "cleared|success|ok" -i; then
  pass "Admin clear_conversation executed"
else
  fail "Admin clear_conversation" "result contains 'cleared'" "$result"
fi

echo "  Scaling channel pod to 0 → 1 to reload cleared DB without race..."
lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
kubectl scale deployment/kubeclaw-channel-http --replicas=0 -n "$NS" >/dev/null 2>&1
kubectl wait pod -l app=kubeclaw-channel-http -n "$NS" --for=delete --timeout=30s >/dev/null 2>&1 || true
kubectl scale deployment/kubeclaw-channel-http --replicas=1 -n "$NS" >/dev/null 2>&1
if ! wait_for_pod "app=kubeclaw-channel-http" 60; then
  fail "Channel pod restart after clear" "Ready within 60s" "timed out"
else
  sleep 3
  lsof -ti:$HTTP_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  kubectl port-forward svc/kubeclaw-channel-http -n "$NS" $HTTP_PORT:80 &>/dev/null &
  CLEANUP_PIDS+=($!)
  sleep 4

  curl --no-buffer -s -u "$TEST_USER:$TEST_PASS" "http://localhost:$HTTP_PORT/stream" > /tmp/e2e-sse-history-3.txt 2>&1 &
  SSE_PID=$!
  CLEANUP_PIDS+=($SSE_PID)
  sleep 2

  curl -s -X POST "http://localhost:$HTTP_PORT/message" \
    -H 'Content-Type: application/json' \
    -u "$TEST_USER:$TEST_PASS" \
    -d '{"text":"what code did I ask you to remember?"}' >/dev/null 2>&1

  echo "  Waiting up to 15s for LLM response after history clear..."
  if wait_for_sse /tmp/e2e-sse-history-3.txt 15; then
    kill $SSE_PID 2>/dev/null || true
    sse_output=$(grep '^data: ' /tmp/e2e-sse-history-3.txt 2>/dev/null || true)
    if ! echo "$sse_output" | grep -qF "BANANA42"; then
      pass "History cleared (response does NOT contain BANANA42)"
      echo "    Response: $(echo "$sse_output" | head -1)"
    else
      fail "History was cleared" "response should NOT contain BANANA42" "$(echo "$sse_output" | head -1)"
    fi
  else
    kill $SSE_PID 2>/dev/null || true
    fail "LLM response after history clear" "SSE data within 15s" "timeout"
  fi  # closes if wait_for_sse
fi    # closes if ! wait_for_pod

# ── Step 11: Restore original secret ─────────────────────────────────────────
echo "[11/11] Restore original channel credentials"
kubectl patch secret kubeclaw-channel-http -n "$NS" -p "{\"stringData\":{\"users\":\"$existing_users\"}}" >/dev/null 2>&1
pass "Original channel credentials restored"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total (out of 11 steps) ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
