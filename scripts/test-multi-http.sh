#!/bin/bash
# Live integration test: Two HTTP channel instances running simultaneously.
#
# Deploys a second HTTP channel ("http-two") alongside the existing "http" channel,
# sends a message to each, and verifies both respond independently.
#
# Run from host:
#   bash scripts/test-multi-http.sh
#
# Prerequisites:
#   - kubeclaw deployed on minikube profile 'kubeclaw-live'
#   - Orchestrator and primary HTTP channel pod running

set -uo pipefail

NS="kubeclaw"
PASS=0
FAIL=0
TOTAL=0
CLEANUP_PIDS=()

PORT_ONE=4080
PORT_TWO=4082

pass() { ((PASS++)); ((TOTAL++)); echo "  PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "  FAIL: $1"; echo "    Expected: $2"; echo "    Got: $(echo "$3" | head -3)"; }

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  for pid in "${CLEANUP_PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  lsof -ti:$PORT_ONE -ti:$PORT_TWO 2>/dev/null | xargs kill -9 2>/dev/null || true

  # Deregister test groups from orchestrator
  run_admin_tool "deregister_group" '{"jid":"http:user-one"}' >/dev/null 2>&1
  run_admin_tool "deregister_group" '{"jid":"http:user-two"}' >/dev/null 2>&1

  # Remove http-two via helm (redeploy without it)
  echo "  Removing http-two channel via helm..."
  helm upgrade kubeclaw ./helm/kubeclaw \
    -f ./helm/kubeclaw/values-minikube.yaml \
    --set secrets.openaiApiKey="mock-key" \
    --set secrets.openaiBaseUrl="http://kubeclaw-mock-llm.kubeclaw.svc.cluster.local/v1" \
    --set secrets.directLlmModel="moonshotai/kimi-k2.5" \
    --namespace "$NS" >/dev/null 2>&1
  # Helm won't delete the orphaned resources automatically; clean them up
  kubectl delete deployment kubeclaw-channel-http-two -n "$NS" --ignore-not-found >/dev/null 2>&1
  kubectl delete svc kubeclaw-channel-http-two -n "$NS" --ignore-not-found >/dev/null 2>&1
  kubectl delete networkpolicy kubeclaw-channel-http-two-ingress -n "$NS" --ignore-not-found >/dev/null 2>&1

  bash "$(dirname "$0")/mock-llm-teardown.sh" kubeclaw 2>/dev/null || true
  echo "  Cleanup done."
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

wait_for_sse() {
  local file="$1" timeout="${2:-15}"
  local elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    if grep -q '^data: ' "$file" 2>/dev/null; then return 0; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  return 1
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

port_forward_retry() {
  local svc="$1" local_port="$2" remote_port="$3" user="$4" pass="$5"
  for attempt in 1 2 3 4 5; do
    lsof -ti:$local_port 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
    kubectl port-forward "svc/$svc" -n "$NS" "$local_port:$remote_port" &>/dev/null &
    CLEANUP_PIDS+=($!)
    sleep 3
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "$user:$pass" "http://localhost:$local_port/" 2>/dev/null)
    if [ "$code" = "200" ]; then return 0; fi
    echo "    Attempt $attempt: HTTP $code, retrying..."
  done
  return 1
}

echo "=== KubeClaw Multi-HTTP Channel Test ==="
echo ""

echo "[0/8] Deploy mock LLM server"
bash "$(dirname "$0")/mock-llm-deploy.sh" kubeclaw

# ── Step 1: Verify existing HTTP channel ─────────────────────────────────────
echo "[1/8] Verify existing HTTP channel (http)"
if wait_for_pod "app=kubeclaw-channel-http" 10; then
  pass "Primary HTTP channel pod running"
else
  fail "Primary HTTP channel pod" "Ready" "not ready"
  exit 1
fi

CREDS_ONE=$(kubectl get secret kubeclaw-channel-http -n "$NS" -o jsonpath='{.data.users}' | base64 -d)
USER_ONE=$(echo "$CREDS_ONE" | cut -d: -f1)
PASS_ONE=$(echo "$CREDS_ONE" | cut -d, -f1 | cut -d: -f2)
echo "  Channel one creds: $USER_ONE:****"

# ── Step 2: Deploy second HTTP channel via Helm ─────────────────────────────
echo "[2/8] Deploy second HTTP channel (http-two)"

# Create secret for http-two
kubectl apply -f - <<EOF >/dev/null 2>&1
apiVersion: v1
kind: Secret
metadata:
  name: kubeclaw-channel-http-two
  namespace: $NS
type: Opaque
stringData:
  users: "user-two:pass-two"
  port: "$PORT_TWO"
EOF

if helm upgrade kubeclaw ./helm/kubeclaw \
  -f ./helm/kubeclaw/values-minikube.yaml \
  --set secrets.openaiApiKey="mock-key" \
  --set secrets.openaiBaseUrl="http://kubeclaw-mock-llm.kubeclaw.svc.cluster.local/v1" \
  --set secrets.directLlmModel="moonshotai/kimi-k2.5" \
  --set channels.http-two.type=http \
  --set channels.http-two.enabled=true \
  --set channels.http-two.httpPort=$PORT_TWO \
  --set 'channels.http-two.envVars[0].name=HTTP_CHANNEL_USERS' \
  --set 'channels.http-two.envVars[0].key=users' \
  --set 'channels.http-two.envVars[1].name=HTTP_CHANNEL_PORT' \
  --set 'channels.http-two.envVars[1].key=port' \
  --set 'channels.http-two.envVars[1].optional=true' \
  --namespace "$NS" >/dev/null 2>&1; then
  pass "Helm upgrade with http-two channel"
else
  fail "Helm upgrade" "exit 0" "helm upgrade failed"
  exit 1
fi

# ── Step 3: Wait for both channel pods ───────────────────────────────────────
echo "[3/8] Wait for both channel pods"
echo "  Waiting for http-two pod..."
if wait_for_pod "app=kubeclaw-channel-http-two" 90; then
  pass "http-two channel pod is ready"
else
  fail "http-two pod ready" "Ready within 90s" "timed out"
  kubectl get pods -n "$NS" -l app=kubeclaw-channel-http-two 2>&1
  kubectl logs -l app=kubeclaw-channel-http-two -n "$NS" --tail=10 2>&1
  exit 1
fi

# Verify both pods running
http_one_ready=$(kubectl get pods -n "$NS" -l app=kubeclaw-channel-http -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
http_two_ready=$(kubectl get pods -n "$NS" -l app=kubeclaw-channel-http-two -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
if [ "$http_one_ready" = "True" ] && [ "$http_two_ready" = "True" ]; then
  pass "Both channel pods running simultaneously"
else
  fail "Both pods running" "http=$http_one_ready, http-two=$http_two_ready" "not both True"
fi

# Verify http-two has correct env vars
channel_type=$(kubectl exec deployment/kubeclaw-channel-http-two -n "$NS" -c channel -- printenv KUBECLAW_CHANNEL_TYPE 2>/dev/null)
channel_name=$(kubectl exec deployment/kubeclaw-channel-http-two -n "$NS" -c channel -- printenv KUBECLAW_CHANNEL 2>/dev/null)
if [ "$channel_type" = "http" ] && [ "$channel_name" = "http-two" ]; then
  pass "http-two has correct KUBECLAW_CHANNEL=http-two, KUBECLAW_CHANNEL_TYPE=http"
else
  fail "http-two env vars" "CHANNEL=http-two, TYPE=http" "CHANNEL=$channel_name, TYPE=$channel_type"
fi

# ── Step 4: Register groups in orchestrator ──────────────────────────────────
echo "[4/8] Register groups for both channels"
run_admin_tool "register_group" "{\"jid\":\"http:$USER_ONE\",\"name\":\"User One\",\"folder\":\"http-user-one\",\"trigger\":\"\",\"requiresTrigger\":false,\"direct\":true}" >/dev/null
run_admin_tool "register_group" '{"jid":"http:user-two","name":"User Two","folder":"http-user-two","trigger":"","requiresTrigger":false,"direct":true}' >/dev/null
pass "Groups registered for both channels"

# ── Step 5: Port-forward and test connectivity to both ───────────────────────
echo "[5/8] Test connectivity to both channels"

if port_forward_retry "kubeclaw-channel-http" $PORT_ONE 80 "$USER_ONE" "$PASS_ONE"; then
  pass "Channel one (http) accessible on port $PORT_ONE"
else
  fail "Channel one accessible" "HTTP 200" "failed after retries"
fi

if port_forward_retry "kubeclaw-channel-http-two" $PORT_TWO 80 "user-two" "pass-two"; then
  pass "Channel two (http-two) accessible on port $PORT_TWO"
else
  fail "Channel two accessible" "HTTP 200" "failed after retries"
fi

# ── Step 6: Send message to each channel and verify independent responses ────
echo "[6/8] Send messages to both channels"

# Channel one
curl --no-buffer -s -u "$USER_ONE:$PASS_ONE" "http://localhost:$PORT_ONE/stream" > /tmp/multi-sse-one.txt 2>&1 &
SSE_ONE=$!; CLEANUP_PIDS+=($SSE_ONE)
sleep 2
curl -s -X POST "http://localhost:$PORT_ONE/message" \
  -H 'Content-Type: application/json' \
  -u "$USER_ONE:$PASS_ONE" \
  -d '{"text":"You are channel one. Reply with exactly: I am channel one"}' >/dev/null 2>&1

# Channel two
curl --no-buffer -s -u "user-two:pass-two" "http://localhost:$PORT_TWO/stream" > /tmp/multi-sse-two.txt 2>&1 &
SSE_TWO=$!; CLEANUP_PIDS+=($SSE_TWO)
sleep 2
curl -s -X POST "http://localhost:$PORT_TWO/message" \
  -H 'Content-Type: application/json' \
  -u "user-two:pass-two" \
  -d '{"text":"You are channel two. Reply with exactly: I am channel two"}' >/dev/null 2>&1

echo "  Waiting for responses from both channels..."
wait_for_sse /tmp/multi-sse-one.txt 15 && wait_for_sse /tmp/multi-sse-two.txt 15 || sleep 5
kill $SSE_ONE $SSE_TWO 2>/dev/null || true

sse_one=$(grep '^data: ' /tmp/multi-sse-one.txt 2>/dev/null || true)
sse_two=$(grep '^data: ' /tmp/multi-sse-two.txt 2>/dev/null || true)

if [ -n "$sse_one" ]; then
  pass "Channel one responded"
  echo "    Response: $(echo "$sse_one" | head -1)"
else
  fail "Channel one responded" "SSE data" "$(cat /tmp/multi-sse-one.txt 2>/dev/null | head -2)"
fi

if [ -n "$sse_two" ]; then
  pass "Channel two responded"
  echo "    Response: $(echo "$sse_two" | head -1)"
else
  fail "Channel two responded" "SSE data" "$(cat /tmp/multi-sse-two.txt 2>/dev/null | head -2)"
fi

# ── Step 7: Verify isolation — separate databases ────────────────────────────
echo "[7/8] Verify channel isolation"

db_one=$(kubectl exec deployment/kubeclaw-channel-http -n "$NS" -c channel -- ls /app/store/ 2>/dev/null | grep messages)
db_two=$(kubectl exec deployment/kubeclaw-channel-http-two -n "$NS" -c channel -- ls /app/store/ 2>/dev/null | grep messages)

if [ -n "$db_one" ] && [ -n "$db_two" ]; then
  pass "Both channels have separate databases ($db_one / $db_two)"
else
  fail "Separate databases" "both have messages-*.db" "one=$db_one two=$db_two"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total ==="

if [ "$FAIL" -gt 0 ]; then exit 1; fi
