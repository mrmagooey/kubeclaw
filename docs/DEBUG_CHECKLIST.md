# KubeClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position

When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)

Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds

`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

## Quick Status Check

```bash
# 1. Is the orchestrator running?
kubectl get pods -n kubeclaw -l app=kubeclaw-orchestrator

# 2. Any running tool jobs?
kubectl get jobs -n kubeclaw --field-selector=status.active=1

# 3. Recent tool jobs (last 10)
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -10

# 4. Recent errors in orchestrator log?
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=100 | grep -E '"level":50|"level":40'

# 5. Is Redis healthy?
kubectl get pods -n kubeclaw -l app=kubeclaw-redis

# 6. Are groups loaded?
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=200 | grep groupCount
```

## Session Transcript Branching

```bash
# Check for concurrent CLI processes in session debug logs
ls -la data/sessions/<group>/.claude/debug/

# Count unique SDK processes that handled messages
# Each .txt file = one CLI subprocess. Multiple = concurrent queries.

# Check parentUuid branching in transcript
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## Tool Job Timeout Investigation

```bash
# Check for timed-out jobs (activeDeadlineSeconds exceeded)
kubectl get jobs -n kubeclaw -o json | \
  jq '.items[] | select(.status.conditions[]?.reason == "DeadlineExceeded") | .metadata.name'

# View logs for a specific job
kubectl logs job/<job-name> -n kubeclaw

# Check job events
kubectl describe job <job-name> -n kubeclaw
```

## Agent Not Responding

```bash
# Check if messages are being received from WhatsApp
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw | grep 'New messages' | tail -10

# Check if messages are being processed (jobs created)
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw | grep -E 'Creating job|Job created' | tail -10

# Check the queue state — any active jobs?
kubectl get jobs -n kubeclaw --field-selector=status.active=1

# Check lastAgentTimestamp vs latest message timestamp
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  sqlite3 /app/store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## PVC Mount Issues

```bash
# Check PVC status
kubectl get pvc -n kubeclaw

# Check PVC usage from orchestrator
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  df -h /app/groups /app/store

# Verify the groups PVC is mounted correctly
kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath='{.spec.template.spec.volumes}' | jq .

# Check group's container config in DB
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  sqlite3 /app/store/messages.db "SELECT name, container_config FROM registered_groups;"

# List files in a group's workspace
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  ls -la /app/groups/<group-folder>/
```

## WhatsApp Auth Issues

```bash
# Check if QR code was requested (means auth expired)
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw | grep -E 'QR|authentication required|qr' | tail -5

# Check auth files exist in the store PVC
kubectl exec -it deployment/kubeclaw-orchestrator -n kubeclaw -- \
  ls -la /app/store/auth/

# Re-authenticate if needed (run locally, not in pod)
npm run auth
```

## Service Management

```bash
# Restart the orchestrator
kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw

# View live logs
kubectl logs -f deployment/kubeclaw-orchestrator -n kubeclaw

# Stop the orchestrator
kubectl scale deployment kubeclaw-orchestrator --replicas=0 -n kubeclaw

# Start the orchestrator
kubectl scale deployment kubeclaw-orchestrator --replicas=1 -n kubeclaw

# Rebuild after code changes
npm run build && \
  docker build -t kubeclaw-orchestrator:latest . && \
  kind load docker-image kubeclaw-orchestrator:latest && \
  kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw
```
