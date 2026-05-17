# Observability — Prometheus Metrics

KubeClaw exposes Prometheus-compatible metrics from three long-lived tiers.
Short-lived tool-job pods are NOT scraped; the orchestrator emits their
lifecycle metrics directly (see design note in Task 5 of the implementation plan).

## Enabling scraping

Set `metrics.serviceMonitor.enabled: true` in `values.yaml` (requires
prometheus-operator CRDs). All tiers bind their metrics server on the port
defined by `metrics.port` (default `9091`) and serve OpenMetrics text at `GET /metrics`.

The credential-broker uses a separate value: `credentialInjection.metrics.serviceMonitor.enabled`.

---

## Orchestrator metrics (port 9091)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `kubeclaw_tool_job_spawned_total` | Counter | `image` | Tool-job Kubernetes Jobs created |
| `kubeclaw_tool_job_duration_seconds` | Histogram | `image`, `success` | Wall-clock duration from spawn to completion |
| `kubeclaw_tool_job_failures_total` | Counter | `image`, `reason` | Tool-job failures by failure reason (e.g. `timeout`, `oom`) |
| `kubeclaw_redis_ipc_messages_total` | Counter | `stream` | Redis IPC stream messages consumed |
| `kubeclaw_group_queue_depth` | Gauge | `group` | Pending messages in each group queue |
| `kubeclaw_specialist_resolutions_total` | Counter | `specialist` | @mention resolutions against global catalog |
| `kubeclaw_db_query_duration_seconds` | Histogram | `operation` | SQLite query latency |

## Channel pod metrics (port 9091)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `kubeclaw_channel_messages_received_total` | Counter | `channel_kind`, `group` | Inbound messages processed |
| `kubeclaw_channel_llm_call_duration_seconds` | Histogram | `provider`, `model`, `success` | LLM call round-trip latency |
| `kubeclaw_channel_tokens_total` | Counter | `provider`, `model`, `direction` | Tokens exchanged (`input`/`output`) |
| `kubeclaw_channel_tool_calls_total` | Counter | `tool` | Tool invocations by the channel LLM |
| `kubeclaw_channel_skill_loads_total` | Counter | `group` | Skill injections into the system prompt |
| `kubeclaw_channel_conversation_history_size` | Gauge | `group` | Conversation history message count |

## RAG capability metrics (port 9091)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `kubeclaw_rag_query_duration_seconds` | Histogram | `group`, `hit` | Retrieval query latency |
| `kubeclaw_rag_queries_total` | Counter | `group`, `hit` | Total retrieval queries |
| `kubeclaw_rag_backend_errors_total` | Counter | `backend` | Errors from `qdrant` or `embedding` backends |
| `kubeclaw_rag_index_duration_seconds` | Histogram | `group` | End-to-end index operation latency |
| `kubeclaw_rag_chunks_indexed_total` | Counter | `group` | Text chunks upserted into Qdrant |

## Credential-broker metrics (port 9090)

Documented separately. Enable with `credentialInjection.metrics.serviceMonitor.enabled: true`.

| Metric | Type | Labels |
|---|---|---|
| `credential_broker_authz_total` | Counter | `status`, `mapping_id`, `identity`, `audit_only` |
| `credential_broker_authz_duration_seconds` | Histogram | `mapping_id` |
| `credential_broker_secret_read_failures_total` | Counter | `secret_name` |
| `credential_broker_config_reloads_total` | Counter | `result` |
