# Kubeclaw Observability

This document describes the metrics, alerts, and dashboards available in kubeclaw.

## Metrics

Kubeclaw exposes Prometheus metrics from several tiers:

- **Orchestrator** — tool job lifecycle, group queue depth, Redis IPC stream activity
- **Channel** — LLM call duration, token counts, tool call counts
- **Credential Broker** — authz request latency and outcomes
- **RAG capability** — backend error counts

### Enabling the ServiceMonitor

If your cluster runs `prometheus-operator` (kube-prometheus-stack), enable the ServiceMonitor so Prometheus scrapes kubeclaw automatically:

```bash
helm upgrade kubeclaw ./helm/kubeclaw \
  --set credentialInjection.metrics.serviceMonitor.enabled=true
```

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
