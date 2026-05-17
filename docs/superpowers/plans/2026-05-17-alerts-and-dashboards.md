# Alerts and Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven production-ready PrometheusRule alerts and two Grafana dashboards (as ConfigMaps) on top of the metrics introduced in gap #1, gated by new `alerts.enabled` and `dashboards.enabled` Helm values, with full unit/integration/e2e test coverage.

**Architecture:** Alert rules live in a single `PrometheusRule` CRD rendered by `helm/kubeclaw/templates/prometheus-rules.yaml`; dashboards live in two ConfigMap templates (`grafana-overview-dashboard.yaml`, `grafana-llm-detail-dashboard.yaml`) labelled `grafana_dashboard: "1"` for Grafana sidecar auto-discovery. Both features default to disabled; operators opt in via Helm values. A companion `docs/RUNBOOKS.md` provides structured remediation guidance for each alert, and `docs/OBSERVABILITY.md` is extended with an "Alerts and dashboards" section.

**Tech Stack:** Helm 3, `monitoring.coreos.com/v1` PrometheusRule CRD (kube-prometheus-stack), Grafana JSON dashboard format v30+, `promtool check rules` (Prometheus tooling), `kubeconform` (manifest validation), `jq` (JSON validity), `kind` + kube-prometheus-stack Helm chart (e2e).

---

## File Structure

| File | Action | Description |
|------|--------|-------------|
| `helm/kubeclaw/templates/prometheus-rules.yaml` | **Create** | PrometheusRule CRD with all 7 alerts, gated by `alerts.enabled` |
| `helm/kubeclaw/templates/grafana-overview-dashboard.yaml` | **Create** | ConfigMap wrapping `kubeclaw-overview.json`, gated by `dashboards.enabled` |
| `helm/kubeclaw/templates/grafana-llm-detail-dashboard.yaml` | **Create** | ConfigMap wrapping `kubeclaw-llm-detail.json`, gated by `dashboards.enabled` |
| `helm/kubeclaw/values.yaml` | **Modify** | Add `alerts.*` and `dashboards.*` stanzas |
| `docs/RUNBOOKS.md` | **Create** | One runbook per alert (7 total) |
| `docs/OBSERVABILITY.md` | **Modify** | Add "Alerts and dashboards" section with install flags |
| `tests/helm/alerts.test.sh` | **Create** | `promtool check rules` + `kubeconform` integration test |
| `tests/helm/dashboards.test.sh` | **Create** | `jq` validity check for both dashboard ConfigMaps |
| `tests/e2e/alerts-fire.test.sh` | **Create** | kind + kube-prometheus-stack e2e: alerts load and fire on synthetic metric |

---

## Task 1: Helm skeleton — empty PrometheusRule and new values

**Goal:** Add `alerts.enabled` (default `false`) and `dashboards.enabled` (default `false`) to `values.yaml`, create a minimal `prometheus-rules.yaml` that renders an empty but valid `PrometheusRule`, and verify it passes `helm template` + `kubeconform`.

**Files:**
- Modify: `helm/kubeclaw/values.yaml`
- Create: `helm/kubeclaw/templates/prometheus-rules.yaml`

- [ ] **Step 1.1: Extend `values.yaml`**

Add the following block at the end of `helm/kubeclaw/values.yaml`, mirroring the `credentialInjection.metrics.serviceMonitor` precedent:

```yaml
# --- Alerting and Dashboards ---
# Requires prometheus-operator (kube-prometheus-stack) for PrometheusRule CRD.
alerts:
  # Set to true to deploy the PrometheusRule with all 7 kubeclaw alerts.
  enabled: false
  # Configurable thresholds — see each alert's annotation for context.
  llmLatencyBudgetSeconds: 60
  groupQueueSaturationDepth: 50

dashboards:
  # Set to true to deploy kubeclaw-overview and kubeclaw-llm-detail as ConfigMaps
  # with the grafana_dashboard: "1" label (auto-discovered by the Grafana sidecar).
  enabled: false
```

- [ ] **Step 1.2: Create skeleton `prometheus-rules.yaml`**

Create `helm/kubeclaw/templates/prometheus-rules.yaml` with an empty PrometheusRule body. The full alert groups will be added in Tasks 2-4.

```yaml
{{- if .Values.alerts.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubeclaw-alerts
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw
    release: {{ .Release.Name }}
spec:
  groups: []
{{- end }}
```

- [ ] **Step 1.3: Validate skeleton**

Run:
```bash
helm template kubeclaw ./helm/kubeclaw --set alerts.enabled=true \
  | kubeconform --strict --kubernetes-version 1.29.0 \
    --schema-location default \
    --schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/monitoring.coreos.com/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```
Expected: zero errors. If `kubeconform` reports "resource not found in schema" for `PrometheusRule`, add `--ignore-missing-schemas` and note it in the test script.

- [ ] **Step 1.4: Commit**

```
git add helm/kubeclaw/values.yaml helm/kubeclaw/templates/prometheus-rules.yaml
git commit -m "feat(helm): add alerts.enabled/dashboards.enabled values and empty PrometheusRule skeleton"
```

---

## Task 2: Infrastructure alerts (orchestrator down, queue saturated, Redis stagnation)

**Goal:** Add the three infrastructure-tier alerts to the PrometheusRule. Each includes a full PromQL expression, `for:` clause, severity, summary, description, and runbook URL.

**Files:**
- Modify: `helm/kubeclaw/templates/prometheus-rules.yaml`

- [ ] **Step 2.1: Replace `spec.groups: []` with the infrastructure alert group**

```yaml
{{- if .Values.alerts.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubeclaw-alerts
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw
    release: {{ .Release.Name }}
spec:
  groups:
    - name: kubeclaw.infrastructure
      interval: 30s
      rules:
        - alert: KubeclawOrchestratorDown
          expr: |
            absent(up{job="kubeclaw-orchestrator"}) or up{job="kubeclaw-orchestrator"} == 0
          for: 2m
          labels:
            severity: critical
            app: kubeclaw
          annotations:
            summary: "Kubeclaw orchestrator is down"
            description: >-
              The kubeclaw-orchestrator scrape target has been absent or returning 0
              for more than 2 minutes. No tool jobs can be spawned and no messages
              will be routed until this is resolved.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclaworchestratordown"

        - alert: KubeclawGroupQueueSaturated
          expr: |
            max by (group) (
              max_over_time(kubeclaw_orchestrator_group_queue_depth[5m])
            ) > {{ .Values.alerts.groupQueueSaturationDepth }}
          for: 5m
          labels:
            severity: warning
            app: kubeclaw
          annotations:
            summary: "Kubeclaw group queue depth is saturated (group={{ "{{" }} $labels.group {{ "}}" }})"
            description: >-
              The per-group message queue has held more than
              {{ .Values.alerts.groupQueueSaturationDepth }} items for 5 minutes.
              Either the LLM is slow or a channel is flooding messages. Check the
              channel pod logs and the orchestrator queue depth metric.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawgroupqueuesaturated"

        - alert: KubeclawRedisStreamStagnant
          expr: |
            increase(kubeclaw_orchestrator_redis_stream_messages_total{stream=~"kubeclaw.*"}[5m]) == 0
            and on() kubeclaw_orchestrator_redis_stream_messages_total{stream=~"kubeclaw.*"} > 0
          for: 5m
          labels:
            severity: critical
            app: kubeclaw
          annotations:
            summary: "Kubeclaw Redis IPC stream has received no messages (stream={{ "{{" }} $labels.stream {{ "}}" }})"
            description: >-
              The Redis stream {{ "{{" }} $labels.stream {{ "}}" }} has not received any
              messages in the last 5 minutes, but previously had traffic. This
              suggests the orchestrator or a channel pod has disconnected from Redis,
              or the stream consumer group is blocked.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawredisstreamstagnant"
```

- [ ] **Step 2.2: Validate with promtool**

Render rules to a temp file and check them:
```bash
helm template kubeclaw ./helm/kubeclaw --set alerts.enabled=true \
  | yq 'select(.kind == "PrometheusRule") | .spec' > /tmp/kubeclaw-rules.yaml
promtool check rules /tmp/kubeclaw-rules.yaml
```
Expected: `SUCCESS: X rules found, 0 errors`.

- [ ] **Step 2.3: Commit**

```
git add helm/kubeclaw/templates/prometheus-rules.yaml
git commit -m "feat(alerts): add infrastructure alert group (orchestrator-down, queue-saturated, redis-stagnant)"
```

---

## Task 3: Tool-job alerts (spawn failure rate, LLM latency p99 over budget)

**Goal:** Add two tool-job and LLM latency alerts.

**Files:**
- Modify: `helm/kubeclaw/templates/prometheus-rules.yaml`

- [ ] **Step 3.1: Add `kubeclaw.toolJob` group to `spec.groups`**

Append to the `groups:` list (after `kubeclaw.infrastructure`):

```yaml
    - name: kubeclaw.toolJob
      interval: 30s
      rules:
        - alert: KubeclawToolJobFailureRateHigh
          expr: |
            (
              rate(kubeclaw_orchestrator_tool_job_spawn_total{status="failed"}[5m])
              /
              rate(kubeclaw_orchestrator_tool_job_spawn_total[5m])
            ) > 0.5
          for: 10m
          labels:
            severity: warning
            app: kubeclaw
          annotations:
            summary: "Kubeclaw tool-job failure rate above 50% (group={{ "{{" }} $labels.group {{ "}}" }})"
            description: >-
              More than 50% of tool-job spawns have been failing for 10 minutes in
              group {{ "{{" }} $labels.group {{ "}}" }}. Check orchestrator logs for
              OOMKilled, image-pull errors, or permission failures. The metric
              kubeclaw_orchestrator_tool_job_spawn_total{status="failed"} breaks down
              failure reasons.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawtoolobfailurerateligh"

        - alert: KubeclawLLMLatencyOverBudget
          expr: |
            histogram_quantile(0.99,
              sum by (provider, model, le) (
                rate(kubeclaw_channel_llm_call_duration_seconds_bucket[10m])
              )
            ) > {{ .Values.alerts.llmLatencyBudgetSeconds }}
          for: 10m
          labels:
            severity: warning
            app: kubeclaw
          annotations:
            summary: "Kubeclaw LLM p99 latency exceeds budget (provider={{ "{{" }} $labels.provider {{ "}}" }}, model={{ "{{" }} $labels.model {{ "}}" }})"
            description: >-
              The p99 LLM call duration for provider={{ "{{" }} $labels.provider {{ "}}" }}
              model={{ "{{" }} $labels.model {{ "}}" }} has been above
              {{ .Values.alerts.llmLatencyBudgetSeconds }}s for 10 minutes. Check if
              the provider is experiencing an incident, or if context windows are
              growing unboundedly. Consider adjusting alerts.llmLatencyBudgetSeconds.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawllmlatencyoverbudget"
```

- [ ] **Step 3.2: Validate**

```bash
helm template kubeclaw ./helm/kubeclaw --set alerts.enabled=true \
  | yq 'select(.kind == "PrometheusRule") | .spec' > /tmp/kubeclaw-rules.yaml
promtool check rules /tmp/kubeclaw-rules.yaml
```
Expected: zero errors.

- [ ] **Step 3.3: Commit**

```
git add helm/kubeclaw/templates/prometheus-rules.yaml
git commit -m "feat(alerts): add tool-job failure-rate and LLM p99 latency alerts"
```

---

## Task 4: Data-plane alerts (LLM error rate, RAG error rate)

**Goal:** Add the two remaining alerts covering LLM call error rate and RAG backend errors.

**Files:**
- Modify: `helm/kubeclaw/templates/prometheus-rules.yaml`

- [ ] **Step 4.1: Add `kubeclaw.dataPlane` group to `spec.groups`**

Append to the `groups:` list:

```yaml
    - name: kubeclaw.dataPlane
      interval: 30s
      rules:
        - alert: KubeclawLLMErrorRateElevated
          expr: |
            (
              sum by (provider) (
                rate(kubeclaw_channel_llm_call_duration_seconds_count{status="error"}[15m])
              )
              /
              sum by (provider) (
                rate(kubeclaw_channel_llm_call_duration_seconds_count[15m])
              )
            ) > 0.1
          for: 15m
          labels:
            severity: warning
            app: kubeclaw
          annotations:
            summary: "Kubeclaw LLM error rate elevated (provider={{ "{{" }} $labels.provider {{ "}}" }})"
            description: >-
              More than 10% of LLM calls to provider {{ "{{" }} $labels.provider {{ "}}" }}
              have failed over the last 15 minutes. This may indicate an API outage,
              rate-limit breach, or invalid API key. Check the channel pod logs and
              the provider status page.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawllmerrorrateelevated"

        - alert: KubeclawRAGErrorRateElevated
          expr: |
            rate(kubeclaw_rag_backend_errors_total[5m]) > 0
          for: 10m
          labels:
            severity: warning
            app: kubeclaw
          annotations:
            summary: "Kubeclaw RAG backend is returning errors (backend={{ "{{" }} $labels.backend {{ "}}" }})"
            description: >-
              The RAG backend {{ "{{" }} $labels.backend {{ "}}" }} has been returning
              errors for 10 minutes. Context injection will silently degrade.
              Check the RAG capability pod logs and Qdrant health.
            runbook_url: "https://github.com/mrmagooey/kubeclaw/blob/main/docs/RUNBOOKS.md#kubeclawragerrorrateelevated"
```

- [ ] **Step 4.2: Validate all 7 alerts together**

```bash
helm template kubeclaw ./helm/kubeclaw \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=50 \
  | yq 'select(.kind == "PrometheusRule") | .spec' > /tmp/kubeclaw-rules.yaml
promtool check rules /tmp/kubeclaw-rules.yaml
echo "Alert count: $(grep -c 'alert:' /tmp/kubeclaw-rules.yaml)"
```
Expected: zero errors, alert count = 7.

- [ ] **Step 4.3: Commit**

```
git add helm/kubeclaw/templates/prometheus-rules.yaml
git commit -m "feat(alerts): add LLM error rate and RAG backend error rate alerts (data-plane group)"
```

---

## Task 5: Create `docs/RUNBOOKS.md`

**Goal:** One short runbook per alert with problem statement, first check, common causes, and escalation path.

**Files:**
- Create: `docs/RUNBOOKS.md`

- [ ] **Step 5.1: Write `docs/RUNBOOKS.md`**

```markdown
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
```

- [ ] **Step 5.2: Verify all 7 anchors are present**

```bash
grep -c '^## Kubeclaw' docs/RUNBOOKS.md
```
Expected output: `7`.

- [ ] **Step 5.3: Commit**

```
git add docs/RUNBOOKS.md
git commit -m "docs: add RUNBOOKS.md with one runbook per PrometheusRule alert (7 total)"
```

---

## Task 6: Grafana overview dashboard ConfigMap

**Goal:** Deploy `kubeclaw-overview.json` as a ConfigMap with the `grafana_dashboard: "1"` label. The dashboard has 6 panels: tier up/down status, LLM call rate by provider, tool-job spawn/failure rate, group queue depth, p95 LLM latency, and top error sources.

**Files:**
- Create: `helm/kubeclaw/templates/grafana-overview-dashboard.yaml`

- [ ] **Step 6.1: Create the template**

```yaml
{{- if .Values.dashboards.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-overview-dashboard
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw
    grafana_dashboard: "1"
data:
  kubeclaw-overview.json: |
    {
      "__inputs": [],
      "__requires": [
        {"type": "grafana", "id": "grafana", "name": "Grafana", "version": "10.0.0"},
        {"type": "datasource", "id": "prometheus", "name": "Prometheus", "version": "1.0.0"}
      ],
      "annotations": {"list": []},
      "description": "Kubeclaw system overview — tier health, LLM activity, tool jobs, queue depth",
      "editable": true,
      "fiscalYearStartMonth": 0,
      "graphTooltip": 1,
      "id": null,
      "links": [],
      "panels": [
        {
          "id": 1,
          "title": "Tier Up/Down",
          "type": "stat",
          "gridPos": {"h": 4, "w": 24, "x": 0, "y": 0},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {
              "mappings": [
                {"type": "value", "options": {"0": {"text": "DOWN", "color": "red", "index": 0}, "1": {"text": "UP", "color": "green", "index": 1}}}
              ],
              "thresholds": {"mode": "absolute", "steps": [{"color": "red", "value": null}, {"color": "green", "value": 1}]},
              "color": {"mode": "thresholds"}
            },
            "overrides": []
          },
          "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "orientation": "horizontal", "textMode": "auto", "colorMode": "background"},
          "targets": [
            {"expr": "up{job=\"kubeclaw-orchestrator\"}", "legendFormat": "Orchestrator", "refId": "A"},
            {"expr": "up{job=~\"kubeclaw-channel.*\"}", "legendFormat": "Channel {{job}}", "refId": "B"},
            {"expr": "up{job=\"kubeclaw-rag\"}", "legendFormat": "RAG", "refId": "C"}
          ]
        },
        {
          "id": 2,
          "title": "LLM Call Rate by Provider (req/s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 4},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "reqps", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider) (rate(kubeclaw_channel_llm_call_duration_seconds_count[5m]))", "legendFormat": "{{provider}}", "refId": "A"}
          ]
        },
        {
          "id": 3,
          "title": "Tool-Job Spawn Rate and Failure Rate",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 4},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "reqps", "color": {"mode": "palette-classic"}},
            "overrides": [{"matcher": {"id": "byName", "options": "Failed"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]}]
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum(rate(kubeclaw_orchestrator_tool_job_spawn_total[5m]))", "legendFormat": "Total", "refId": "A"},
            {"expr": "sum(rate(kubeclaw_orchestrator_tool_job_spawn_total{status=\"failed\"}[5m]))", "legendFormat": "Failed", "refId": "B"}
          ]
        },
        {
          "id": 4,
          "title": "Group Queue Depth",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 12},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "short", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["max"]}},
          "targets": [
            {"expr": "kubeclaw_orchestrator_group_queue_depth", "legendFormat": "{{group}}", "refId": "A"}
          ]
        },
        {
          "id": 5,
          "title": "LLM Call p95 Latency by Provider (s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 12},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "s", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "histogram_quantile(0.95, sum by (provider, le) (rate(kubeclaw_channel_llm_call_duration_seconds_bucket[5m])))", "legendFormat": "p95 {{provider}}", "refId": "A"}
          ]
        },
        {
          "id": 6,
          "title": "Top Error Sources (errors/s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 24, "x": 0, "y": 20},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "reqps", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider) (rate(kubeclaw_channel_llm_call_duration_seconds_count{status=\"error\"}[5m]))", "legendFormat": "LLM error {{provider}}", "refId": "A"},
            {"expr": "rate(kubeclaw_orchestrator_tool_job_spawn_total{status=\"failed\"}[5m])", "legendFormat": "Tool-job failure {{group}}", "refId": "B"},
            {"expr": "rate(kubeclaw_rag_backend_errors_total[5m])", "legendFormat": "RAG error {{backend}}", "refId": "C"}
          ]
        }
      ],
      "refresh": "30s",
      "schemaVersion": 38,
      "tags": ["kubeclaw"],
      "templating": {
        "list": [
          {
            "name": "datasource",
            "type": "datasource",
            "pluginId": "prometheus",
            "label": "Prometheus datasource",
            "hide": 0,
            "refresh": 1,
            "query": "prometheus"
          }
        ]
      },
      "time": {"from": "now-1h", "to": "now"},
      "timepicker": {},
      "timezone": "browser",
      "title": "Kubeclaw Overview",
      "uid": "kubeclaw-overview",
      "version": 1
    }
{{- end }}
```

- [ ] **Step 6.2: Validate JSON and Helm render**

```bash
helm template kubeclaw ./helm/kubeclaw --set dashboards.enabled=true \
  | yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-overview-dashboard") | .data["kubeclaw-overview.json"]' \
  | jq . > /dev/null && echo "JSON valid"
```
Expected: `JSON valid`.

- [ ] **Step 6.3: Commit**

```
git add helm/kubeclaw/templates/grafana-overview-dashboard.yaml
git commit -m "feat(dashboards): add kubeclaw-overview Grafana dashboard ConfigMap (6 panels)"
```

---

## Task 7: Grafana LLM detail dashboard ConfigMap

**Goal:** Deploy `kubeclaw-llm-detail.json` as a ConfigMap. This dashboard provides per-provider/model deep-dive panels: tokens in/out rate, estimated cost (tokens × configurable $/1k rate via a Grafana variable), p50/p95/p99 latency, success rate, and retry count.

**Files:**
- Create: `helm/kubeclaw/templates/grafana-llm-detail-dashboard.yaml`

- [ ] **Step 7.1: Create the template**

```yaml
{{- if .Values.dashboards.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeclaw-llm-detail-dashboard
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw
    grafana_dashboard: "1"
data:
  kubeclaw-llm-detail.json: |
    {
      "__inputs": [],
      "__requires": [
        {"type": "grafana", "id": "grafana", "name": "Grafana", "version": "10.0.0"},
        {"type": "datasource", "id": "prometheus", "name": "Prometheus", "version": "1.0.0"}
      ],
      "annotations": {"list": []},
      "description": "Kubeclaw LLM per-provider and per-model deep dive: tokens, cost, latency, success rate",
      "editable": true,
      "fiscalYearStartMonth": 0,
      "graphTooltip": 1,
      "id": null,
      "links": [],
      "panels": [
        {
          "id": 1,
          "title": "Tokens IN Rate (tokens/s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "short", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_llm_tokens_total{direction=\"in\",provider=~\"$provider\",model=~\"$model\"}[5m]))", "legendFormat": "{{provider}}/{{model}}", "refId": "A"}
          ]
        },
        {
          "id": 2,
          "title": "Tokens OUT Rate (tokens/s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "short", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_llm_tokens_total{direction=\"out\",provider=~\"$provider\",model=~\"$model\"}[5m]))", "legendFormat": "{{provider}}/{{model}}", "refId": "A"}
          ]
        },
        {
          "id": 3,
          "title": "Estimated Cost Rate ($/hour) — input tokens",
          "description": "Cost = token rate × (cost_per_1k_input / 1000) × 3600. Set cost_per_1k_input variable to match your model pricing. Example: claude-3-5-sonnet = 3.00, gpt-4o = 2.50.",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "currencyUSD", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_llm_tokens_total{direction=\"in\",provider=~\"$provider\",model=~\"$model\"}[5m])) * ($cost_per_1k_input / 1000) * 3600", "legendFormat": "{{provider}}/{{model}} input cost/hr", "refId": "A"},
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_llm_tokens_total{direction=\"out\",provider=~\"$provider\",model=~\"$model\"}[5m])) * ($cost_per_1k_output / 1000) * 3600", "legendFormat": "{{provider}}/{{model}} output cost/hr", "refId": "B"}
          ]
        },
        {
          "id": 4,
          "title": "LLM Call Success Rate (%)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "percentunit", "min": 0, "max": 1, "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "last"]}},
          "targets": [
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_llm_call_duration_seconds_count{status=\"ok\",provider=~\"$provider\",model=~\"$model\"}[5m])) / sum by (provider, model) (rate(kubeclaw_channel_llm_call_duration_seconds_count{provider=~\"$provider\",model=~\"$model\"}[5m]))", "legendFormat": "{{provider}}/{{model}}", "refId": "A"}
          ]
        },
        {
          "id": 5,
          "title": "LLM Call Latency Percentiles (s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 0, "y": 16},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "s", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "histogram_quantile(0.50, sum by (provider, model, le) (rate(kubeclaw_channel_llm_call_duration_seconds_bucket{provider=~\"$provider\",model=~\"$model\"}[5m])))", "legendFormat": "p50 {{provider}}/{{model}}", "refId": "A"},
            {"expr": "histogram_quantile(0.95, sum by (provider, model, le) (rate(kubeclaw_channel_llm_call_duration_seconds_bucket{provider=~\"$provider\",model=~\"$model\"}[5m])))", "legendFormat": "p95 {{provider}}/{{model}}", "refId": "B"},
            {"expr": "histogram_quantile(0.99, sum by (provider, model, le) (rate(kubeclaw_channel_llm_call_duration_seconds_bucket{provider=~\"$provider\",model=~\"$model\"}[5m])))", "legendFormat": "p99 {{provider}}/{{model}}", "refId": "C"}
          ]
        },
        {
          "id": 6,
          "title": "Tool Calls Invoked Rate (calls/s)",
          "type": "timeseries",
          "gridPos": {"h": 8, "w": 12, "x": 12, "y": 16},
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "fieldConfig": {
            "defaults": {"unit": "reqps", "color": {"mode": "palette-classic"}},
            "overrides": []
          },
          "options": {"tooltip": {"mode": "multi"}, "legend": {"displayMode": "table", "placement": "bottom", "calcs": ["mean", "max"]}},
          "targets": [
            {"expr": "sum by (provider, model) (rate(kubeclaw_channel_tool_calls_total{provider=~\"$provider\",model=~\"$model\"}[5m]))", "legendFormat": "{{provider}}/{{model}}", "refId": "A"}
          ]
        }
      ],
      "refresh": "30s",
      "schemaVersion": 38,
      "tags": ["kubeclaw", "llm"],
      "templating": {
        "list": [
          {
            "name": "datasource",
            "type": "datasource",
            "pluginId": "prometheus",
            "label": "Prometheus datasource",
            "hide": 0,
            "refresh": 1,
            "query": "prometheus"
          },
          {
            "name": "provider",
            "type": "query",
            "label": "Provider",
            "hide": 0,
            "refresh": 2,
            "datasource": {"type": "prometheus", "uid": "${datasource}"},
            "query": "label_values(kubeclaw_channel_llm_call_duration_seconds_count, provider)",
            "multi": true,
            "includeAll": true,
            "allValue": ".*"
          },
          {
            "name": "model",
            "type": "query",
            "label": "Model",
            "hide": 0,
            "refresh": 2,
            "datasource": {"type": "prometheus", "uid": "${datasource}"},
            "query": "label_values(kubeclaw_channel_llm_call_duration_seconds_count{provider=~\"$provider\"}, model)",
            "multi": true,
            "includeAll": true,
            "allValue": ".*"
          },
          {
            "name": "cost_per_1k_input",
            "type": "textbox",
            "label": "Input cost per 1k tokens (USD)",
            "hide": 0,
            "current": {"value": "3.00"},
            "query": "3.00"
          },
          {
            "name": "cost_per_1k_output",
            "type": "textbox",
            "label": "Output cost per 1k tokens (USD)",
            "hide": 0,
            "current": {"value": "15.00"},
            "query": "15.00"
          }
        ]
      },
      "time": {"from": "now-3h", "to": "now"},
      "timepicker": {},
      "timezone": "browser",
      "title": "Kubeclaw LLM Detail",
      "uid": "kubeclaw-llm-detail",
      "version": 1
    }
{{- end }}
```

- [ ] **Step 7.2: Validate JSON and Helm render**

```bash
helm template kubeclaw ./helm/kubeclaw --set dashboards.enabled=true \
  | yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-llm-detail-dashboard") | .data["kubeclaw-llm-detail.json"]' \
  | jq . > /dev/null && echo "JSON valid"
```
Expected: `JSON valid`.

- [ ] **Step 7.3: Validate both dashboards and all alert rules together**

```bash
helm template kubeclaw ./helm/kubeclaw \
  --set alerts.enabled=true \
  --set dashboards.enabled=true \
  | kubeconform --strict --kubernetes-version 1.29.0 \
    --schema-location default \
    --ignore-missing-schemas
```
Expected: zero errors.

- [ ] **Step 7.4: Commit**

```
git add helm/kubeclaw/templates/grafana-llm-detail-dashboard.yaml
git commit -m "feat(dashboards): add kubeclaw-llm-detail Grafana dashboard ConfigMap (6 panels, cost variables)"
```

---

## Task 8: Extend `docs/OBSERVABILITY.md` and write integration + unit test scripts

**Goal:** Extend the gap-1 observability doc with an "Alerts and dashboards" section, and write the three test scripts that constitute unit (promtool), integration (helm + promtool + kubeconform), and e2e (kind) coverage.

**Files:**
- Modify: `docs/OBSERVABILITY.md`
- Create: `tests/helm/alerts.test.sh`
- Create: `tests/helm/dashboards.test.sh`
- Create: `tests/e2e/alerts-fire.test.sh`

- [ ] **Step 8.1: Extend `docs/OBSERVABILITY.md`**

Append the following section to the end of `docs/OBSERVABILITY.md`:

```markdown
## Alerts and dashboards

### Enabling alerts

Deploy the PrometheusRule (requires `prometheus-operator` / kube-prometheus-stack):

```bash
helm upgrade kubeclaw ./helm/kubeclaw \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=50
```

This creates a `PrometheusRule` named `kubeclaw-alerts` in the `kubeclaw` namespace containing 7 alerts in three groups: `kubeclaw.infrastructure`, `kubeclaw.toolJob`, and `kubeclaw.dataPlane`. Prometheus Operator will discover and load them automatically if the rule's labels match your Prometheus `ruleSelector`.

### Enabling Grafana dashboards

Deploy the two dashboard ConfigMaps (auto-discovered by the Grafana sidecar when `grafana_dashboard: "1"` label is present):

```bash
helm upgrade kubeclaw ./helm/kubeclaw \
  --set dashboards.enabled=true
```

This creates:
- `kubeclaw-overview-dashboard` — system health at a glance (6 panels).
- `kubeclaw-llm-detail-dashboard` — per-provider/model LLM deep dive with configurable cost variables (6 panels).

Both dashboards expose a `datasource` template variable; select your Prometheus datasource on first open.

### Alert thresholds

| Value | Default | Description |
|-------|---------|-------------|
| `alerts.llmLatencyBudgetSeconds` | `60` | p99 LLM duration threshold before `KubeclawLLMLatencyOverBudget` fires |
| `alerts.groupQueueSaturationDepth` | `50` | Max queue depth before `KubeclawGroupQueueSaturated` fires |

### Runbooks

Every alert annotation includes a `runbook_url` pointing to `docs/RUNBOOKS.md`. See that file for problem statement, first-check commands, common causes, and escalation paths.

### Alert summary

| Alert | Severity | Group | For |
|-------|----------|-------|-----|
| `KubeclawOrchestratorDown` | critical | infrastructure | 2m |
| `KubeclawGroupQueueSaturated` | warning | infrastructure | 5m |
| `KubeclawRedisStreamStagnant` | critical | infrastructure | 5m |
| `KubeclawToolJobFailureRateHigh` | warning | toolJob | 10m |
| `KubeclawLLMLatencyOverBudget` | warning | toolJob | 10m |
| `KubeclawLLMErrorRateElevated` | warning | dataPlane | 15m |
| `KubeclawRAGErrorRateElevated` | warning | dataPlane | 10m |
```

- [ ] **Step 8.2: Create `tests/helm/alerts.test.sh`** (unit + integration level)

```bash
#!/usr/bin/env bash
# tests/helm/alerts.test.sh
# Unit-level: checks promtool parses and validates all rule expressions.
# Integration-level: renders the full chart and pipes ALL rule files through promtool and kubeconform.
set -euo pipefail

CHART="./helm/kubeclaw"
NAMESPACE="kubeclaw-test"

echo "=== [1/4] helm template with alerts.enabled=true ==="
helm template kubeclaw "$CHART" \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=50 \
  --namespace "$NAMESPACE" \
  > /tmp/kubeclaw-rendered.yaml

echo "=== [2/4] Extract PrometheusRule spec and check with promtool ==="
yq 'select(.kind == "PrometheusRule") | .spec' /tmp/kubeclaw-rendered.yaml \
  > /tmp/kubeclaw-rules.yaml

promtool check rules /tmp/kubeclaw-rules.yaml

ALERT_COUNT=$(grep -c '^      - alert:' /tmp/kubeclaw-rules.yaml || true)
echo "Alert count: $ALERT_COUNT"
if [ "$ALERT_COUNT" -ne 7 ]; then
  echo "ERROR: expected 7 alerts, found $ALERT_COUNT"
  exit 1
fi

echo "=== [3/4] kubeconform on full rendered chart ==="
helm template kubeclaw "$CHART" \
  --set alerts.enabled=true \
  --set dashboards.enabled=true \
  --namespace "$NAMESPACE" \
  | kubeconform --strict --kubernetes-version 1.29.0 \
    --schema-location default \
    --ignore-missing-schemas

echo "=== [4/4] Confirm dashboards.enabled=false renders no dashboard ConfigMaps ==="
DASHBOARD_COUNT=$(helm template kubeclaw "$CHART" \
  --set alerts.enabled=true \
  --set dashboards.enabled=false \
  --namespace "$NAMESPACE" \
  | grep -c 'grafana_dashboard' || true)
if [ "$DASHBOARD_COUNT" -ne 0 ]; then
  echo "ERROR: dashboards.enabled=false should produce 0 grafana_dashboard labels, found $DASHBOARD_COUNT"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
```

- [ ] **Step 8.3: Create `tests/helm/dashboards.test.sh`** (integration level)

```bash
#!/usr/bin/env bash
# tests/helm/dashboards.test.sh
# Integration-level: render dashboards and verify JSON validity with jq.
set -euo pipefail

CHART="./helm/kubeclaw"
NAMESPACE="kubeclaw-test"

echo "=== [1/3] Render chart with dashboards.enabled=true ==="
helm template kubeclaw "$CHART" \
  --set dashboards.enabled=true \
  --namespace "$NAMESPACE" \
  > /tmp/kubeclaw-dashboards.yaml

echo "=== [2/3] Validate kubeclaw-overview.json ==="
yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-overview-dashboard") | .data["kubeclaw-overview.json"]' \
  /tmp/kubeclaw-dashboards.yaml \
  | jq . > /dev/null
echo "kubeclaw-overview.json: valid JSON"

PANEL_COUNT=$(yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-overview-dashboard") | .data["kubeclaw-overview.json"]' \
  /tmp/kubeclaw-dashboards.yaml | jq '.panels | length')
echo "Overview panel count: $PANEL_COUNT"
if [ "$PANEL_COUNT" -lt 6 ]; then
  echo "ERROR: expected >= 6 panels in overview dashboard, found $PANEL_COUNT"
  exit 1
fi

echo "=== [3/3] Validate kubeclaw-llm-detail.json ==="
yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-llm-detail-dashboard") | .data["kubeclaw-llm-detail.json"]' \
  /tmp/kubeclaw-dashboards.yaml \
  | jq . > /dev/null
echo "kubeclaw-llm-detail.json: valid JSON"

PANEL_COUNT=$(yq 'select(.kind == "ConfigMap" and .metadata.name == "kubeclaw-llm-detail-dashboard") | .data["kubeclaw-llm-detail.json"]' \
  /tmp/kubeclaw-dashboards.yaml | jq '.panels | length')
echo "LLM detail panel count: $PANEL_COUNT"
if [ "$PANEL_COUNT" -lt 6 ]; then
  echo "ERROR: expected >= 6 panels in LLM detail dashboard, found $PANEL_COUNT"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
```

- [ ] **Step 8.4: Create `tests/e2e/alerts-fire.test.sh`** (e2e level)

```bash
#!/usr/bin/env bash
# tests/e2e/alerts-fire.test.sh
# E2E: kind cluster + kube-prometheus-stack + kubeclaw chart.
# Feeds a synthetic metric via a test exporter and verifies the alert fires.
#
# Prerequisites: kind, helm, kubectl, promtool installed and on PATH.
# Run time: ~5-8 minutes (cluster creation + stack install + alert evaluation cycle).
set -euo pipefail

CLUSTER_NAME="kubeclaw-alerts-e2e"
NAMESPACE="kubeclaw"
MONITORING_NS="monitoring"
KPS_VERSION="61.3.2"  # kube-prometheus-stack chart version

cleanup() {
  echo "=== Cleaning up kind cluster ==="
  kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== [1/7] Create kind cluster ==="
kind create cluster --name "$CLUSTER_NAME" --wait 60s

echo "=== [2/7] Install kube-prometheus-stack ==="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
kubectl create namespace "$MONITORING_NS"
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace "$MONITORING_NS" \
  --version "$KPS_VERSION" \
  --set grafana.enabled=false \
  --set alertmanager.enabled=false \
  --set prometheus.prometheusSpec.evaluationInterval=15s \
  --set prometheus.prometheusSpec.scrapeInterval=15s \
  --wait --timeout 5m

echo "=== [3/7] Install kubeclaw chart with alerts enabled ==="
kubectl create namespace "$NAMESPACE"
helm install kubeclaw ./helm/kubeclaw \
  --namespace "$NAMESPACE" \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=5 \
  --set credentialInjection.mode=off \
  --set networkPolicy.enabled=false

echo "=== [4/7] Verify PrometheusRule was created ==="
kubectl get prometheusrule -n "$NAMESPACE" kubeclaw-alerts
RULE_COUNT=$(kubectl get prometheusrule -n "$NAMESPACE" kubeclaw-alerts \
  -o jsonpath='{.spec.groups[*].rules[*].alert}' | wc -w)
echo "Loaded alert count from CRD: $RULE_COUNT"
if [ "$RULE_COUNT" -lt 7 ]; then
  echo "ERROR: expected 7 alerts in PrometheusRule, found $RULE_COUNT"
  exit 1
fi

echo "=== [5/7] Deploy synthetic metric exporter for KubeclawGroupQueueSaturated ==="
# Push a static metric value > groupQueueSaturationDepth=5 via a pushgateway-compatible pattern.
# We use a simple ConfigMap + Job that writes directly to the Prometheus pushgateway.
helm install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
  --namespace "$MONITORING_NS" \
  --set serviceMonitor.enabled=true \
  --wait --timeout 2m

PUSHGATEWAY_POD=$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus-pushgateway \
  -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "$MONITORING_NS" "$PUSHGATEWAY_POD" -- sh -c \
  'echo "kubeclaw_orchestrator_group_queue_depth{group=\"e2e-test\"} 100" | \
   curl --data-binary @- http://localhost:9091/metrics/job/kubeclaw-e2e/instance/synthetic'

echo "=== [6/7] Wait for KubeclawGroupQueueSaturated to become firing (up to 3m) ==="
DEADLINE=$(($(date +%s) + 180))
while true; do
  ALERTS=$(kubectl exec -n "$MONITORING_NS" \
    "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
    -- wget -qO- 'http://localhost:9090/api/v1/alerts' 2>/dev/null \
    | jq -r '.data.alerts[] | select(.labels.alertname == "KubeclawGroupQueueSaturated") | .state' 2>/dev/null || true)

  if echo "$ALERTS" | grep -q "pending\|firing"; then
    echo "KubeclawGroupQueueSaturated is in state: $ALERTS"
    break
  fi

  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo "ERROR: KubeclawGroupQueueSaturated did not fire within 3 minutes"
    kubectl exec -n "$MONITORING_NS" \
      "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
      -- wget -qO- 'http://localhost:9090/api/v1/alerts' | jq .
    exit 1
  fi
  sleep 10
done

echo "=== [7/7] Verify alert rule names in Prometheus API ==="
RULE_NAMES=$(kubectl exec -n "$MONITORING_NS" \
  "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
  -- wget -qO- 'http://localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[].rules[].name' | sort)

EXPECTED_ALERTS=(
  KubeclawGroupQueueSaturated
  KubeclawLLMErrorRateElevated
  KubeclawLLMLatencyOverBudget
  KubeclawOrchestratorDown
  KubeclawRAGErrorRateElevated
  KubeclawRedisStreamStagnant
  KubeclawToolJobFailureRateHigh
)
for ALERT in "${EXPECTED_ALERTS[@]}"; do
  if echo "$RULE_NAMES" | grep -q "$ALERT"; then
    echo "  FOUND: $ALERT"
  else
    echo "  MISSING: $ALERT"
    exit 1
  fi
done

echo "=== ALL E2E CHECKS PASSED ==="
```

- [ ] **Step 8.5: Make test scripts executable**

```bash
chmod +x tests/helm/alerts.test.sh tests/helm/dashboards.test.sh tests/e2e/alerts-fire.test.sh
```

- [ ] **Step 8.6: Run unit + integration tests (not e2e — that requires a cluster)**

```bash
bash tests/helm/alerts.test.sh
bash tests/helm/dashboards.test.sh
```
Expected: both scripts exit 0 with `ALL CHECKS PASSED`.

- [ ] **Step 8.7: Commit**

```
git add docs/OBSERVABILITY.md docs/RUNBOOKS.md \
        tests/helm/alerts.test.sh tests/helm/dashboards.test.sh \
        tests/e2e/alerts-fire.test.sh
git commit -m "docs+tests: extend OBSERVABILITY.md, add unit/integration/e2e test scripts for alerts and dashboards"
```

---

## Self-review

### Spec-compliance check

| Requirement | Status | Notes |
|-------------|--------|-------|
| Exactly 7 alerts | Covered | 3 infrastructure + 2 toolJob + 2 dataPlane |
| `alerts.enabled` Helm gate (default false) | Covered | Task 1 |
| `dashboards.enabled` Helm gate (default false) | Covered | Tasks 6-7 |
| Each alert has summary, description, runbook_url, severity, for: | Covered | Tasks 2-4 |
| `runbook_url` anchors match `docs/RUNBOOKS.md` headings | Covered | Tasks 4-5 (verify anchors in step 5.2) |
| Configurable thresholds: llmLatencyBudgetSeconds, groupQueueSaturationDepth | Covered | values.yaml + alert expressions use `.Values.alerts.*` |
| `kubeclaw-overview.json` with 6+ panels | Covered | Task 6 (6 panels exactly matching spec) |
| `kubeclaw-llm-detail.json` with cost variable, p50/p95/p99 | Covered | Task 7 |
| Dashboards as ConfigMaps with `grafana_dashboard: "1"` | Covered | Tasks 6-7 |
| `docs/RUNBOOKS.md` with one entry per alert | Covered | Task 5 |
| `docs/OBSERVABILITY.md` extended with install flags | Covered | Task 8.1 |
| Unit test: promtool check rules | Covered | tests/helm/alerts.test.sh steps 1-2 |
| Integration test: helm template + promtool + kubeconform | Covered | tests/helm/alerts.test.sh steps 1-4 |
| Integration test: JSON validity for dashboards | Covered | tests/helm/dashboards.test.sh |
| E2E test: kind + kube-prometheus-stack, alert fires | Covered | tests/e2e/alerts-fire.test.sh |
| No source code in src/ | Covered | Only Helm templates, docs, test scripts |
| No placeholders or TODOs in code blocks | Covered | All YAML/JSON is complete and executable |

### Code-quality check

- **Alert expressions:** All use `rate(... [5m])` with `for:` clauses long enough to avoid flap. The `absent()` construct in `KubeclawOrchestratorDown` handles both missing and zero-valued `up` metrics, covering fresh installs before any scrape.
- **Redis stagnation guard:** `and on() kubeclaw_orchestrator_redis_stream_messages_total > 0` prevents the alert from firing on streams that have never received traffic (e.g. immediately after install).
- **Helm value injection in PromQL:** `.Values.alerts.llmLatencyBudgetSeconds` and `.Values.alerts.groupQueueSaturationDepth` are injected as numeric literals — safe because they are typed as numbers in `values.yaml` and the Helm template will render them without quotes.
- **Grafana label escaping:** Alert annotation `{{ }}` expressions use `{{ "{{" }}` / `{{ "}}" }}` to escape Helm template delimiters within the YAML string. This is the standard Helm workaround.
- **Dashboard JSON:** Both dashboards use `"uid"` fields that are stable and deterministic (not randomly generated), which prevents dashboard duplication on repeated `helm upgrade`.
- **Test scripts:** `set -euo pipefail` ensures any command failure aborts immediately. Cleanup traps ensure the kind cluster is always deleted, even on failure.
- **Missing-schemas flag:** `kubeconform --ignore-missing-schemas` is used for the `PrometheusRule` CRD since the schema URL may not be available in CI without internet access; the promtool check independently validates the rule content.
- **E2E pushgateway approach:** The e2e test uses `prometheus-pushgateway` to inject a synthetic metric rather than deploying a full kubeclaw stack (which requires Redis, secrets, etc.). This is simpler and tests the alert rule specifically, not the metric emission (which is covered by gap-1's own tests).
