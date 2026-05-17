# Kubeclaw Alert Runbooks

One entry per PrometheusRule alert. Each anchor matches the `runbook_url` in the alert annotation.

---

## KubeclawOrchestratorDown

**Problem:** The `kubeclaw-orchestrator` Prometheus scrape target is returning `up=0` or is absent. No messages are being routed and no tool jobs can be spawned.

**First thing to check:**
```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-orchestrator
kubectl logs deployment/kubeclaw-orchestrator -n kubeclaw --tail=50
```
Look for OOMKilled, CrashLoopBackOff, or missing Redis connection errors.

**Common causes:**
- Pod OOMKilled: increase `orchestrator.resources.limits.memory` in Helm values.
- Redis unreachable: check `kubectl get pods -n kubeclaw -l app=kubeclaw-redis`.
- Image pull failure: verify `image.registry` and `image.tag` are correct and the image exists.
- Liveness probe failing: check `kubectl describe pod -n kubeclaw <pod-name>` for probe details.

**Escalation:** If the pod is healthy and the scrape target is still down, verify the Service and ServiceMonitor are present: `kubectl get servicemonitor -n kubeclaw`. Confirm Prometheus has network access to the kubeclaw namespace.

---

## KubeclawGroupQueueSaturated

**Problem:** The per-group message queue has held more than the configured depth (`alerts.groupQueueSaturationDepth`, default 50) for 5 minutes. Messages are queuing faster than they are being processed.

**First thing to check:**
```bash
kubectl logs -n kubeclaw deployment/kubeclaw-orchestrator --tail=100 | grep '"group"'
```
Check for slow LLM responses, stuck tool jobs, or a high-volume channel flooding messages.

**Common causes:**
- LLM provider slowdown: cross-check with `KubeclawLLMLatencyOverBudget`.
- Tool job backlog: `kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -20`.
- Channel bot loop: a misconfigured channel responding to its own messages.

**Escalation:** If queue depth does not drain after the LLM/tool-job situation is resolved, restart the orchestrator pod (`kubectl rollout restart deployment/kubeclaw-orchestrator -n kubeclaw`).

---

## KubeclawRedisStreamStagnant

**Problem:** A kubeclaw Redis stream that previously had traffic has received zero new messages for 5 minutes. This blocks all IPC between the orchestrator, channels, and capability pods.

**First thing to check:**
```bash
kubectl exec -n kubeclaw deployment/kubeclaw-orchestrator -- \
  redis-cli -h kubeclaw-redis XINFO STREAM kubeclaw:ipc
```
Check the `last-generated-id` timestamp and the consumer group lag.

**Common causes:**
- Redis pod restarted and stream consumers have not reconnected: restart orchestrator and channel pods.
- Network policy blocking Redis egress: `kubectl get networkpolicy -n kubeclaw`.
- Consumer group blocked on a poisoned message: manually acknowledge the oldest pending entry.

**Escalation:** If all consumers show zero pending and no new messages appear after pod restarts, dump the Redis stream (`XRANGE kubeclaw:ipc - + COUNT 10`) and check orchestrator logs for stream-read errors.

---

## KubeclawToolJobFailureRateHigh

**Problem:** More than 50% of tool-job spawns have failed over 10 minutes. Users will see tool invocation errors.

**First thing to check:**
```bash
kubectl get jobs -n kubeclaw --sort-by=.metadata.creationTimestamp | tail -10
kubectl describe job -n kubeclaw <failing-job-name>
```
Look at the job's pod status and exit code.

**Common causes:**
- Image pull failure: the tool-job image is unavailable or the `toolImageAllowlist` is blocking it.
- OOMKilled: the tool container is exceeding `agent.resources.limits.memory`.
- Permission denied: the job's service account is missing a required RBAC verb.
- Timeout: the agent exceeded `agent.timeoutSeconds`; increase or investigate runaway tools.

**Escalation:** Pull the failed pod logs: `kubectl logs -n kubeclaw job/<job-name>`. If the failure reason is unclear, temporarily raise log verbosity by setting `LOG_LEVEL=debug` on the orchestrator and restarting.

---

## KubeclawLLMLatencyOverBudget

**Problem:** The p99 LLM call duration has exceeded the configured budget (`alerts.llmLatencyBudgetSeconds`, default 60s) for 10 minutes. User-facing responses will be slow.

**First thing to check:**
```bash
kubectl logs -n kubeclaw -l kubeclaw-mode=channel --tail=100 | grep '"llm"'
```
Look for unusually large `prompt_tokens` values or retries.

**Common causes:**
- Provider incident: check the provider's status page (https://status.anthropic.com, https://status.openai.com).
- Context window growth: a group's conversation history may have grown very large; check `kubeclaw_channel_conversation_history_fetch_bytes`.
- Retry storms: a failing API key causing repeated retries inflating p99.

**Escalation:** If the provider is healthy and context size is reasonable, consider reducing `topK` for RAG (`rag.topK`) or implementing conversation truncation for the affected group.

---

## KubeclawLLMErrorRateElevated

**Problem:** More than 10% of LLM calls to a provider have returned errors over 15 minutes.

**First thing to check:**
```bash
kubectl logs -n kubeclaw -l kubeclaw-mode=channel --tail=200 | grep -i '"status":"error"'
```
Look for HTTP 401 (bad API key), 429 (rate limit), or 5xx (provider outage) error codes.

**Common causes:**
- Expired or invalid API key: rotate the key in `secrets.anthropicApiKey` / `secrets.openaiApiKey` and re-deploy.
- Rate limit exceeded: reduce concurrent tool jobs or add request throttling in the channel.
- Provider outage: wait for recovery; consider switching to a fallback provider via `secrets.openaiBaseUrl`.

**Escalation:** If rate-limit errors persist after reducing concurrency, contact the provider to request a quota increase.

---

## KubeclawRAGErrorRateElevated

**Problem:** The RAG capability backend is returning errors. Context retrieval will silently fail and agents will respond without injected memory.

**First thing to check:**
```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-qdrant
kubectl logs -n kubeclaw statefulset/kubeclaw-qdrant --tail=50
```
Verify Qdrant is running and the PVC is not full.

**Common causes:**
- Qdrant OOMKilled: increase `rag.resources.limits.memory`.
- PVC full: expand `rag.storage` and re-deploy Qdrant.
- Embedding API errors: the embedding provider key has expired or rate-limited (check `secrets.openaiApiKey` / `secrets.voyageApiKey`).
- Collection does not exist: Qdrant was reset without re-indexing; trigger a re-embed.

**Escalation:** If Qdrant is healthy and the embedding key is valid, check the RAG capability pod logs for connection errors to Qdrant (`kubectl logs -n kubeclaw -l app=kubeclaw-rag --tail=100`).
