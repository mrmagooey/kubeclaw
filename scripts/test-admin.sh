#!/bin/bash
# Integration test for admin shell tools against a live kubeclaw instance.
# Run from host:
#   bash scripts/test-admin.sh

set -uo pipefail

NS="kubeclaw"
PASS=0
FAIL=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); echo "  PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "  FAIL: $1"; echo "    Expected: $2"; echo "    Got: $3"; }

run_tool() {
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

assert_contains() {
  local desc="$1" result="$2" expected="$3"
  if echo "$result" | grep -qF "$expected"; then
    pass "$desc"
  else
    fail "$desc" "contains '$expected'" "$(echo "$result" | head -3)"
  fi
}

assert_not_contains() {
  local desc="$1" result="$2" unexpected="$3"
  if echo "$result" | grep -qF "$unexpected"; then
    fail "$desc" "does NOT contain '$unexpected'" "$(echo "$result" | head -3)"
  else
    pass "$desc"
  fi
}

assert_equals() {
  local desc="$1" result="$2" expected="$3"
  if [ "$result" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc" "'$expected'" "'$(echo "$result" | head -1)'"
  fi
}

echo "=== KubeClaw Admin Shell Integration Tests ==="
echo ""

# ── 1. Unknown tool ──────────────────────────────────────────────────────────
echo "[1/11] Unknown tool"
result=$(run_tool "nonexistent" "{}")
assert_equals "unknown tool returns error" "$result" "Unknown tool: nonexistent"

# ── 2. list_groups (initial state) ───────────────────────────────────────────
echo "[2/11] list_groups (initial)"
result=$(run_tool "list_groups" "{}")
# May have existing groups or be empty — just check it doesn't error
if [ -n "$result" ]; then
  pass "list_groups returns output"
else
  fail "list_groups returns output" "non-empty output" "(empty)"
fi

# ── 3. list_channels ────────────────────────────────────────────────────────
echo "[3/11] list_channels"
result=$(run_tool "list_channels" "{}")
assert_contains "lists telegram" "$result" "telegram:"
assert_contains "lists discord" "$result" "discord:"
assert_contains "lists slack" "$result" "slack:"
assert_contains "lists whatsapp" "$result" "whatsapp:"
assert_contains "lists irc" "$result" "irc:"

# ── 4. list_scheduled_tasks ─────────────────────────────────────────────────
echo "[4/11] list_scheduled_tasks"
result=$(run_tool "list_scheduled_tasks" "{}")
# Should be empty (we cleaned up earlier) or have tasks — either is valid
if [ -n "$result" ]; then
  pass "list_scheduled_tasks returns output"
else
  fail "list_scheduled_tasks returns output" "non-empty output" "(empty)"
fi

# ── 5. get_sessions ─────────────────────────────────────────────────────────
echo "[5/11] get_sessions"
result=$(run_tool "get_sessions" "{}")
if [ -n "$result" ]; then
  pass "get_sessions returns output"
else
  fail "get_sessions returns output" "non-empty output" "(empty)"
fi

# ── 6. get_orchestrator_status ──────────────────────────────────────────────
echo "[6/11] get_orchestrator_status"
result=$(run_tool "get_orchestrator_status" "{}")
assert_contains "shows orchestrator name" "$result" "Orchestrator: kubeclaw-orchestrator"
assert_contains "shows ready status" "$result" "Ready:"
assert_contains "shows channel pods section" "$result" "Channel pods:"

# ── 7. register_group ──────────────────────────────────────────────────────
echo "[7/11] register_group"
result=$(run_tool "register_group" '{"jid":"test:integration","name":"Integration Test","folder":"test-integration","trigger":"@Test"}')
assert_contains "register returns confirmation" "$result" "Registered group"
assert_contains "register shows name" "$result" "Integration Test"
assert_contains "register shows JID" "$result" "test:integration"

# ── 8. list_groups (after register) ─────────────────────────────────────────
echo "[8/11] list_groups (after register)"
result=$(run_tool "list_groups" "{}")
assert_contains "registered group appears in list" "$result" "test:integration"
assert_contains "group name appears" "$result" "Integration Test"
assert_contains "folder appears" "$result" "test-integration"

# ── 9. clear_conversation ──────────────────────────────────────────────────
echo "[9/11] clear_conversation"
result=$(run_tool "clear_conversation" '{"folder":"test-integration"}')
assert_contains "clear returns confirmation" "$result" "Cleared conversation history"
assert_contains "clear shows folder" "$result" "test-integration"

# ── 10. deregister_group ───────────────────────────────────────────────────
echo "[10/11] deregister_group"
result=$(run_tool "deregister_group" '{"jid":"test:integration"}')
assert_contains "deregister returns confirmation" "$result" "Removed group"
assert_contains "deregister shows name" "$result" "Integration Test"

# ── 11. list_groups (after deregister) ─────────────────────────────────────
echo "[11/11] list_groups (after deregister)"
result=$(run_tool "list_groups" "{}")
assert_not_contains "deregistered group is gone" "$result" "test:integration"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
