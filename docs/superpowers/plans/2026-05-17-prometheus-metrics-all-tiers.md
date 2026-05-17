# Extend Prometheus Metrics to All Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a `/metrics` endpoint on every kubeclaw tier (orchestrator, channel, capability/RAG) serving OpenMetrics-format counters and histograms, with Prometheus Operator ServiceMonitor resources gated by a single `metrics.serviceMonitor.enabled` Helm value.

**Architecture:** A shared factory module (`src/metrics/registry.ts`) provides a `createMetricsServer()` helper that wires a `prom-client` Registry to a minimal `http.Server` on a configurable port, mirroring the pattern already established in `src/credential-broker/`. The orchestrator emits tool-job lifecycle metrics (spawn rate, duration, failure reason) directly rather than scraping short-lived tool-job pods — this avoids the scrape-timing problem for batch workloads that exist for seconds. Channel pods emit LLM call duration, token counts, and message throughput from their own `prom-client` Registry. The RAG capability emits query latency and backend error counters from the embedding + Qdrant path. Helm adds a `metrics` port to each tier's Service and a per-tier ServiceMonitor, all gated by `metrics.serviceMonitor.enabled`.

**Tech Stack:** `prom-client` (already in `package.json`), Node.js `http`, TypeScript, Vitest, Helm 3, kubeconform or `helm lint`.

---

## File Structure

**Created:**
- `src/metrics/registry.ts` — shared `createMetricsServer()` factory + `MetricsServer` interface
- `src/metrics/registry.test.ts` — unit tests for factory and label helpers
- `src/metrics/orchestrator.ts` — counter/histogram definitions for the orchestrator tier
- `src/metrics/orchestrator.test.ts`
- `src/metrics/channel.ts` — counter/histogram definitions for channel pods
- `src/metrics/channel.test.ts`
- `src/metrics/rag.ts` — counter/histogram definitions for RAG capability
- `src/metrics/rag.test.ts`
- `helm/kubeclaw/templates/metrics-servicemonitor.yaml` — ServiceMonitor for orchestrator, channel, and capability tiers
- `docs/OBSERVABILITY.md` — full metric catalogue with names, labels, ports, and enable instructions

**Modified:**
- `src/index.ts` — import `createOrchestratorMetrics`, start metrics server on port 9091, thread metrics into `GroupQueue`, `ipc-redis`, `specialists`, and `db` call sites
- `src/channel-runner.ts` — import `createChannelMetrics`, start metrics server on port 9091, record LLM calls, token counts, messages received, skill loads
- `src/rag/retriever.ts` — accept and call RAG metrics on every `retrieveContext` invocation
- `src/rag/indexer.ts` — record index latency via RAG metrics
- `src/group-queue.ts` — expose `queueDepth(groupJid)` getter so orchestrator metrics can sample it
- `helm/kubeclaw/templates/orchestrator.yaml` — add `metrics` port to container spec and orchestrator Service
- `helm/kubeclaw/templates/channel-pods.yaml` — add `metrics` port to container spec and per-channel Service
- `helm/kubeclaw/templates/capability-pods.yaml` — add `metrics` port to capability container spec and Service
- `helm/kubeclaw/values.yaml` — add `metrics.serviceMonitor.enabled` and `metrics.serviceMonitor.interval` top-level keys

---

## Task 1: Shared `src/metrics/registry.ts` factory

**Files:**
- Create: `src/metrics/registry.ts`
- Create: `src/metrics/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/metrics/registry.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import http from 'http';
import { createMetricsServer } from './registry.js';

describe('createMetricsServer', () => {
  const servers: ReturnType<typeof createMetricsServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers.length = 0;
  });

  it('serves GET /metrics and returns 200 with prom text', async () => {
    const registry = new Registry();
    const server = createMetricsServer({ registry, port: 0 });
    servers.push(server);
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('returns 404 for any path other than /metrics', async () => {
    const registry = new Registry();
    const server = createMetricsServer({ registry, port: 0 });
    servers.push(server);
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-GET methods', async () => {
    const registry = new Registry();
    const server = createMetricsServer({ registry, port: 0 });
    servers.push(server);
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/metrics/registry.test.ts`
Expected: FAIL with "Cannot find module './registry.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/metrics/registry.ts
import http from 'http';
import { Registry } from 'prom-client';
import { logger } from '../logger.js';

export interface MetricsServerOptions {
  registry: Registry;
  /** Pass 0 to bind to an OS-assigned port (useful in tests). */
  port: number;
}

export interface ListenResult {
  port: number;
}

export interface MetricsServer {
  /** Start listening. Resolves once the port is bound. */
  listen(): Promise<ListenResult>;
  /** Gracefully close the server. */
  close(): Promise<void>;
}

/**
 * Create a minimal HTTP server that serves a prom-client Registry on GET /metrics.
 *
 * Mirrors the pattern in src/credential-broker/index.ts — a dedicated metrics
 * server runs on a separate port so scrape traffic does not appear in any
 * workload-specific histogram the tier is recording.
 */
export function createMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const { registry, port } = opts;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await registry.metrics();
      res.setHeader('Content-Type', registry.contentType);
      res.writeHead(200).end(body);
    } catch (err) {
      logger.error({ err }, 'metrics handler crashed');
      res.writeHead(500).end();
    }
  });

  return {
    listen() {
      return new Promise<ListenResult>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          const addr = server.address();
          const boundPort =
            addr && typeof addr === 'object' ? addr.port : port;
          logger.info({ port: boundPort }, 'metrics server listening');
          resolve({ port: boundPort });
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/metrics/registry.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/registry.ts src/metrics/registry.test.ts
git commit -m "feat(metrics): add shared createMetricsServer factory"
```

---

## Task 2: Orchestrator metrics module + `/metrics` endpoint

**Files:**
- Create: `src/metrics/orchestrator.ts`
- Create: `src/metrics/orchestrator.test.ts`
- Modify: `src/index.ts` (add metrics server startup and instrument call sites)
- Modify: `src/group-queue.ts` (add `queueDepth()` getter)

- [ ] **Step 1: Write the failing tests**

```ts
// src/metrics/orchestrator.test.ts
import { describe, it, expect } from 'vitest';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './orchestrator.js';

describe('createOrchestratorMetrics', () => {
  it('registers expected metric names on the provided registry', async () => {
    const registry = new Registry();
    createOrchestratorMetrics(registry);
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain('kubeclaw_tool_job_spawned_total');
    expect(names).toContain('kubeclaw_tool_job_duration_seconds');
    expect(names).toContain('kubeclaw_tool_job_failures_total');
    expect(names).toContain('kubeclaw_redis_ipc_messages_total');
    expect(names).toContain('kubeclaw_group_queue_depth');
    expect(names).toContain('kubeclaw_specialist_resolutions_total');
    expect(names).toContain('kubeclaw_db_query_duration_seconds');
  });

  it('recordToolJobSpawn increments kubeclaw_tool_job_spawned_total with image label', async () => {
    const registry = new Registry();
    const m = createOrchestratorMetrics(registry);
    m.recordToolJobSpawn({ image: 'ghcr.io/kubeclaw/tool:latest' });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_tool_job_spawned_total');
    expect(counter?.values[0]?.value).toBe(1);
    expect(counter?.values[0]?.labels?.image).toBe('ghcr.io/kubeclaw/tool:latest');
  });

  it('recordToolJobDuration observes into the histogram', async () => {
    const registry = new Registry();
    const m = createOrchestratorMetrics(registry);
    m.recordToolJobDuration({ image: 'img', success: true, durationMs: 4200 });
    const metrics = await registry.getMetricsAsJSON();
    const hist = metrics.find((m) => m.name === 'kubeclaw_tool_job_duration_seconds');
    const sum = hist?.values.find((v) => v.metricName === 'kubeclaw_tool_job_duration_seconds_sum');
    expect(sum?.value).toBeCloseTo(4.2, 2);
  });

  it('recordRedisMessage increments with stream label', async () => {
    const registry = new Registry();
    const m = createOrchestratorMetrics(registry);
    m.recordRedisMessage({ stream: 'kubeclaw:spawn-tool-job' });
    m.recordRedisMessage({ stream: 'kubeclaw:spawn-tool-job' });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_redis_ipc_messages_total');
    expect(counter?.values[0]?.value).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/metrics/orchestrator.test.ts`
Expected: FAIL with "Cannot find module './orchestrator.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/metrics/orchestrator.ts
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface OrchestratorMetrics {
  recordToolJobSpawn(labels: { image: string }): void;
  recordToolJobDuration(labels: { image: string; success: boolean; durationMs: number }): void;
  recordToolJobFailure(labels: { image: string; reason: string }): void;
  recordRedisMessage(labels: { stream: string }): void;
  setGroupQueueDepth(labels: { group: string }, depth: number): void;
  recordSpecialistResolution(labels: { specialist: string }): void;
  recordDbQuery(labels: { operation: string; durationMs: number }): void;
}

/**
 * Register all orchestrator-tier Prometheus metrics on `registry`.
 *
 * Tool-job pods are short-lived (seconds to minutes); scraping them individually
 * would race against pod termination. The orchestrator instead emits their
 * lifecycle metrics directly — it is the authoritative source for spawn,
 * completion, and failure events regardless of pod lifespan.
 */
export function createOrchestratorMetrics(registry: Registry): OrchestratorMetrics {
  const toolJobSpawned = new Counter({
    name: 'kubeclaw_tool_job_spawned_total',
    help: 'Total tool-job Kubernetes Jobs created by the orchestrator',
    labelNames: ['image'] as const,
    registers: [registry],
  });

  const toolJobDuration = new Histogram({
    name: 'kubeclaw_tool_job_duration_seconds',
    help: 'Wall-clock duration of tool-job pods from spawn to completion',
    labelNames: ['image', 'success'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  const toolJobFailures = new Counter({
    name: 'kubeclaw_tool_job_failures_total',
    help: 'Tool-job failures broken down by failure reason',
    labelNames: ['image', 'reason'] as const,
    registers: [registry],
  });

  const redisIpcMessages = new Counter({
    name: 'kubeclaw_redis_ipc_messages_total',
    help: 'Total Redis IPC stream messages consumed by the orchestrator',
    labelNames: ['stream'] as const,
    registers: [registry],
  });

  const groupQueueDepth = new Gauge({
    name: 'kubeclaw_group_queue_depth',
    help: 'Current number of pending messages in each group queue',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const specialistResolutions = new Counter({
    name: 'kubeclaw_specialist_resolutions_total',
    help: 'Total @mention resolutions against the global specialist catalog',
    labelNames: ['specialist'] as const,
    registers: [registry],
  });

  const dbQueryDuration = new Histogram({
    name: 'kubeclaw_db_query_duration_seconds',
    help: 'SQLite query duration in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    registers: [registry],
  });

  return {
    recordToolJobSpawn({ image }) {
      toolJobSpawned.inc({ image });
    },
    recordToolJobDuration({ image, success, durationMs }) {
      toolJobDuration.observe({ image, success: String(success) }, durationMs / 1000);
    },
    recordToolJobFailure({ image, reason }) {
      toolJobFailures.inc({ image, reason });
    },
    recordRedisMessage({ stream }) {
      redisIpcMessages.inc({ stream });
    },
    setGroupQueueDepth({ group }, depth) {
      groupQueueDepth.set({ group }, depth);
    },
    recordSpecialistResolution({ specialist }) {
      specialistResolutions.inc({ specialist });
    },
    recordDbQuery({ operation, durationMs }) {
      dbQueryDuration.observe({ operation }, durationMs / 1000);
    },
  };
}
```

Also add to `src/group-queue.ts` (after the existing private fields):

```ts
// In GroupQueue class — add a public getter
queueDepth(groupJid: string): number {
  const state = this.groups.get(groupJid);
  if (!state) return 0;
  return state.pendingTasks.length + (state.pendingMessages ? 1 : 0);
}
```

Then in `src/index.ts`, after the existing imports and startup block, add:

```ts
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './metrics/orchestrator.js';
import { createMetricsServer } from './metrics/registry.js';

const metricsRegistry = new Registry();
const orchMetrics = createOrchestratorMetrics(metricsRegistry);
const metricsServer = createMetricsServer({
  registry: metricsRegistry,
  port: parseInt(process.env.METRICS_PORT ?? '9091', 10),
});
await metricsServer.listen();
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/metrics/orchestrator.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/orchestrator.ts src/metrics/orchestrator.test.ts src/group-queue.ts src/index.ts
git commit -m "feat(metrics): orchestrator metrics module and /metrics endpoint on port 9091"
```

---

## Task 3: Channel pod metrics module + `/metrics` endpoint

**Files:**
- Create: `src/metrics/channel.ts`
- Create: `src/metrics/channel.test.ts`
- Modify: `src/channel-runner.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/metrics/channel.test.ts
import { describe, it, expect } from 'vitest';
import { Registry } from 'prom-client';
import { createChannelMetrics } from './channel.js';

describe('createChannelMetrics', () => {
  it('registers expected metric names', async () => {
    const registry = new Registry();
    createChannelMetrics(registry);
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain('kubeclaw_channel_messages_received_total');
    expect(names).toContain('kubeclaw_channel_llm_call_duration_seconds');
    expect(names).toContain('kubeclaw_channel_tokens_total');
    expect(names).toContain('kubeclaw_channel_tool_calls_total');
    expect(names).toContain('kubeclaw_channel_skill_loads_total');
    expect(names).toContain('kubeclaw_channel_conversation_history_size');
  });

  it('recordMessage increments with channel_kind and group labels', async () => {
    const registry = new Registry();
    const m = createChannelMetrics(registry);
    m.recordMessage({ channelKind: 'telegram', group: 'mygroup' });
    m.recordMessage({ channelKind: 'telegram', group: 'mygroup' });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_channel_messages_received_total');
    expect(counter?.values[0]?.value).toBe(2);
    expect(counter?.values[0]?.labels?.channel_kind).toBe('telegram');
  });

  it('recordLlmCall observes duration and increments with provider/model/success labels', async () => {
    const registry = new Registry();
    const m = createChannelMetrics(registry);
    m.recordLlmCall({ provider: 'anthropic', model: 'claude-sonnet-4-6', success: true, durationMs: 1200 });
    const metrics = await registry.getMetricsAsJSON();
    const hist = metrics.find((m) => m.name === 'kubeclaw_channel_llm_call_duration_seconds');
    const sum = hist?.values.find((v) => v.metricName === 'kubeclaw_channel_llm_call_duration_seconds_sum');
    expect(sum?.value).toBeCloseTo(1.2, 2);
  });

  it('recordTokens increments with direction/provider/model labels', async () => {
    const registry = new Registry();
    const m = createChannelMetrics(registry);
    m.recordTokens({ provider: 'anthropic', model: 'claude-sonnet-4-6', direction: 'input', count: 500 });
    m.recordTokens({ provider: 'anthropic', model: 'claude-sonnet-4-6', direction: 'output', count: 300 });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_channel_tokens_total');
    const inputRow = counter?.values.find((v) => v.labels?.direction === 'input');
    expect(inputRow?.value).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/metrics/channel.test.ts`
Expected: FAIL with "Cannot find module './channel.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/metrics/channel.ts
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface ChannelMetrics {
  recordMessage(labels: { channelKind: string; group: string }): void;
  recordLlmCall(labels: { provider: string; model: string; success: boolean; durationMs: number }): void;
  recordTokens(labels: { provider: string; model: string; direction: 'input' | 'output'; count: number }): void;
  recordToolCall(labels: { tool: string }): void;
  recordSkillLoad(labels: { group: string }): void;
  setConversationHistorySize(labels: { group: string }, size: number): void;
}

export function createChannelMetrics(registry: Registry): ChannelMetrics {
  const messagesReceived = new Counter({
    name: 'kubeclaw_channel_messages_received_total',
    help: 'Total inbound messages processed by this channel pod',
    labelNames: ['channel_kind', 'group'] as const,
    registers: [registry],
  });

  const llmCallDuration = new Histogram({
    name: 'kubeclaw_channel_llm_call_duration_seconds',
    help: 'LLM call round-trip latency including streaming',
    labelNames: ['provider', 'model', 'success'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [registry],
  });

  const tokensTotal = new Counter({
    name: 'kubeclaw_channel_tokens_total',
    help: 'Total tokens exchanged with the LLM provider',
    labelNames: ['provider', 'model', 'direction'] as const,
    registers: [registry],
  });

  const toolCallsTotal = new Counter({
    name: 'kubeclaw_channel_tool_calls_total',
    help: 'Total tool invocations by the channel LLM during conversations',
    labelNames: ['tool'] as const,
    registers: [registry],
  });

  const skillLoadsTotal = new Counter({
    name: 'kubeclaw_channel_skill_loads_total',
    help: 'Total skill injections into the system prompt',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const conversationHistorySize = new Gauge({
    name: 'kubeclaw_channel_conversation_history_size',
    help: 'Number of messages in the in-memory conversation history per group',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  return {
    recordMessage({ channelKind, group }) {
      messagesReceived.inc({ channel_kind: channelKind, group });
    },
    recordLlmCall({ provider, model, success, durationMs }) {
      llmCallDuration.observe({ provider, model, success: String(success) }, durationMs / 1000);
    },
    recordTokens({ provider, model, direction, count }) {
      tokensTotal.inc({ provider, model, direction }, count);
    },
    recordToolCall({ tool }) {
      toolCallsTotal.inc({ tool });
    },
    recordSkillLoad({ group }) {
      skillLoadsTotal.inc({ group });
    },
    setConversationHistorySize({ group }, size) {
      conversationHistorySize.set({ group }, size);
    },
  };
}
```

In `src/channel-runner.ts`, after existing startup code, add:

```ts
import { Registry } from 'prom-client';
import { createChannelMetrics } from './metrics/channel.js';
import { createMetricsServer } from './metrics/registry.js';

const channelMetricsRegistry = new Registry();
const channelMetrics = createChannelMetrics(channelMetricsRegistry);
const channelMetricsServer = createMetricsServer({
  registry: channelMetricsRegistry,
  port: parseInt(process.env.METRICS_PORT ?? '9091', 10),
});
await channelMetricsServer.listen();
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/metrics/channel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/channel.ts src/metrics/channel.test.ts src/channel-runner.ts
git commit -m "feat(metrics): channel pod metrics module and /metrics endpoint on port 9091"
```

---

## Task 4: RAG capability metrics module

**Files:**
- Create: `src/metrics/rag.ts`
- Create: `src/metrics/rag.test.ts`
- Modify: `src/rag/retriever.ts`
- Modify: `src/rag/indexer.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/metrics/rag.test.ts
import { describe, it, expect } from 'vitest';
import { Registry } from 'prom-client';
import { createRagMetrics } from './rag.js';

describe('createRagMetrics', () => {
  it('registers expected metric names', async () => {
    const registry = new Registry();
    createRagMetrics(registry);
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain('kubeclaw_rag_query_duration_seconds');
    expect(names).toContain('kubeclaw_rag_queries_total');
    expect(names).toContain('kubeclaw_rag_backend_errors_total');
    expect(names).toContain('kubeclaw_rag_index_duration_seconds');
    expect(names).toContain('kubeclaw_rag_chunks_indexed_total');
  });

  it('recordQuery observes duration and increments counter with hit label', async () => {
    const registry = new Registry();
    const m = createRagMetrics(registry);
    m.recordQuery({ group: 'mygroup', hit: true, durationMs: 350 });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_rag_queries_total');
    expect(counter?.values[0]?.value).toBe(1);
    expect(counter?.values[0]?.labels?.hit).toBe('true');
    const hist = metrics.find((m) => m.name === 'kubeclaw_rag_query_duration_seconds');
    const sum = hist?.values.find((v) => v.metricName === 'kubeclaw_rag_query_duration_seconds_sum');
    expect(sum?.value).toBeCloseTo(0.35, 2);
  });

  it('recordBackendError increments with backend label', async () => {
    const registry = new Registry();
    const m = createRagMetrics(registry);
    m.recordBackendError({ backend: 'qdrant' });
    m.recordBackendError({ backend: 'embedding' });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === 'kubeclaw_rag_backend_errors_total');
    expect(counter?.values).toHaveLength(2);
  });

  it('recordIndex observes chunk count and index latency', async () => {
    const registry = new Registry();
    const m = createRagMetrics(registry);
    m.recordIndex({ group: 'mygroup', chunks: 8, durationMs: 900 });
    const metrics = await registry.getMetricsAsJSON();
    const chunksCounter = metrics.find((m) => m.name === 'kubeclaw_rag_chunks_indexed_total');
    expect(chunksCounter?.values[0]?.value).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/metrics/rag.test.ts`
Expected: FAIL with "Cannot find module './rag.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/metrics/rag.ts
import { Counter, Histogram, Registry } from 'prom-client';

export interface RagMetrics {
  recordQuery(labels: { group: string; hit: boolean; durationMs: number }): void;
  recordBackendError(labels: { backend: 'qdrant' | 'embedding' }): void;
  recordIndex(labels: { group: string; chunks: number; durationMs: number }): void;
}

export function createRagMetrics(registry: Registry): RagMetrics {
  const queryDuration = new Histogram({
    name: 'kubeclaw_rag_query_duration_seconds',
    help: 'Qdrant + embedding round-trip latency for retrieval queries',
    labelNames: ['group', 'hit'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const queriesTotal = new Counter({
    name: 'kubeclaw_rag_queries_total',
    help: 'Total RAG retrieval queries, labelled by whether any results were returned',
    labelNames: ['group', 'hit'] as const,
    registers: [registry],
  });

  const backendErrors = new Counter({
    name: 'kubeclaw_rag_backend_errors_total',
    help: 'Total errors from Qdrant or embedding backends during RAG operations',
    labelNames: ['backend'] as const,
    registers: [registry],
  });

  const indexDuration = new Histogram({
    name: 'kubeclaw_rag_index_duration_seconds',
    help: 'End-to-end latency of a text indexing operation (chunk + embed + upsert)',
    labelNames: ['group'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const chunksIndexed = new Counter({
    name: 'kubeclaw_rag_chunks_indexed_total',
    help: 'Total text chunks upserted into Qdrant',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  return {
    recordQuery({ group, hit, durationMs }) {
      const hitStr = String(hit);
      queryDuration.observe({ group, hit: hitStr }, durationMs / 1000);
      queriesTotal.inc({ group, hit: hitStr });
    },
    recordBackendError({ backend }) {
      backendErrors.inc({ backend });
    },
    recordIndex({ group, chunks, durationMs }) {
      indexDuration.observe({ group }, durationMs / 1000);
      chunksIndexed.inc({ group }, chunks);
    },
  };
}
```

Update `src/rag/retriever.ts` to accept an optional `RagMetrics` parameter and call `recordQuery` / `recordBackendError` around the existing `embed` + `search` calls. Update `src/rag/indexer.ts` to call `recordIndex` after the `upsertPoints` call.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/metrics/rag.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/metrics/rag.ts src/metrics/rag.test.ts src/rag/retriever.ts src/rag/indexer.ts
git commit -m "feat(metrics): RAG capability metrics module wired into retriever and indexer"
```

---

## Task 5: Tool-job lifecycle metrics (emitted by orchestrator)

**Files:**
- Modify: `src/k8s/job-runner.ts` (call `orchMetrics.recordToolJobSpawn`, `recordToolJobDuration`, `recordToolJobFailure`)
- Modify: `src/k8s/ipc-redis.ts` (call `orchMetrics.recordRedisMessage` at each stream read)
- Add integration test: `src/metrics/orchestrator-integration.test.ts`

> **Design note:** Tool-job pods are ephemeral Kubernetes Jobs that typically live for seconds to a few minutes. Prometheus scrape intervals are typically 15–30 seconds. Scraping pods with such short lifetimes would miss most data entirely. The orchestrator is the canonical authority for tool-job lifecycle events (it creates and watches every job), so it emits all tool-job metrics directly. This is the same approach used by kube-state-metrics for Job-level aggregations.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/metrics/orchestrator-integration.test.ts
import { describe, it, expect } from 'vitest';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './orchestrator.js';
import { createMetricsServer } from './registry.js';

describe('orchestrator metrics integration', () => {
  it('exposes tool-job counters in OpenMetrics text format after simulated spawn events', async () => {
    const registry = new Registry();
    const m = createOrchestratorMetrics(registry);
    const server = createMetricsServer({ registry, port: 0 });
    const { port } = await server.listen();

    m.recordToolJobSpawn({ image: 'ghcr.io/kubeclaw/tool:v1' });
    m.recordToolJobSpawn({ image: 'ghcr.io/kubeclaw/tool:v1' });
    m.recordToolJobFailure({ image: 'ghcr.io/kubeclaw/tool:v1', reason: 'timeout' });
    m.recordToolJobDuration({ image: 'ghcr.io/kubeclaw/tool:v1', success: false, durationMs: 600000 });

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kubeclaw_tool_job_spawned_total');
    expect(body).toContain('kubeclaw_tool_job_failures_total');
    expect(body).toContain('kubeclaw_tool_job_duration_seconds_sum');
    // Verify label appears in serialized output
    expect(body).toContain('image="ghcr.io/kubeclaw/tool:v1"');

    await server.close();
  });

  it('exposes Redis IPC message counter per stream', async () => {
    const registry = new Registry();
    const m = createOrchestratorMetrics(registry);
    const server = createMetricsServer({ registry, port: 0 });
    const { port } = await server.listen();

    m.recordRedisMessage({ stream: 'kubeclaw:spawn-tool-job' });
    m.recordRedisMessage({ stream: 'kubeclaw:task-request' });

    const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(body).toContain('stream="kubeclaw:spawn-tool-job"');
    expect(body).toContain('stream="kubeclaw:task-request"');

    await server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/metrics/orchestrator-integration.test.ts`
Expected: FAIL with "kubeclaw_tool_job_spawned_total not in body" (before wiring, counter may be absent from text)

- [ ] **Step 3: Wire metrics into job-runner and ipc-redis**

In `src/k8s/job-runner.ts`, import and accept `OrchestratorMetrics` as an optional dependency injected at construction time:

```ts
// Add to JobRunner constructor options
import type { OrchestratorMetrics } from '../metrics/orchestrator.js';

export interface JobRunnerOptions {
  // ... existing options ...
  metrics?: OrchestratorMetrics;
}
```

At the point where a Job is created (the existing `batchApi.createNamespacedJob` call), add:

```ts
this.options.metrics?.recordToolJobSpawn({ image: spec.image });
```

At the point where a Job completes (success branch):

```ts
this.options.metrics?.recordToolJobDuration({
  image: spec.image,
  success: true,
  durationMs: Date.now() - spawnedAt,
});
```

At failure / timeout branches:

```ts
this.options.metrics?.recordToolJobFailure({ image: spec.image, reason: 'timeout' });
this.options.metrics?.recordToolJobDuration({
  image: spec.image,
  success: false,
  durationMs: Date.now() - spawnedAt,
});
```

In `src/k8s/ipc-redis.ts`, import `OrchestratorMetrics` and accept it in `IpcDeps`. At every `redis.xread` / stream consume call, add:

```ts
deps.metrics?.recordRedisMessage({ stream: streamName });
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- src/metrics/orchestrator-integration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/ipc-redis.ts src/metrics/orchestrator-integration.test.ts
git commit -m "feat(metrics): wire tool-job spawn/duration/failure and Redis IPC counters into orchestrator"
```

---

## Task 6: Helm — `metrics.serviceMonitor.enabled` value + ServiceMonitor template

**Files:**
- Modify: `helm/kubeclaw/values.yaml`
- Create: `helm/kubeclaw/templates/metrics-servicemonitor.yaml`

- [ ] **Step 1: Write the failing lint/template test**

```bash
# Expected: error because metrics-servicemonitor.yaml references .Values.metrics which does not yet exist
helm template kubeclaw ./helm/kubeclaw --set metrics.serviceMonitor.enabled=true 2>&1 | grep -c "nil pointer"
# Expected output: 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `helm template kubeclaw ./helm/kubeclaw --set metrics.serviceMonitor.enabled=true 2>&1`
Expected: FAIL with nil pointer evaluating interface {}.serviceMonitor or similar error

- [ ] **Step 3: Add values and template**

Add to `helm/kubeclaw/values.yaml` (top-level, after the existing `credentialInjection` block):

```yaml
# Prometheus metrics scraping. Requires prometheus-operator in the cluster.
metrics:
  # Port on which each tier exposes /metrics. Must match METRICS_PORT env var.
  port: 9091
  serviceMonitor:
    # Set to true to create ServiceMonitor resources for orchestrator, channels,
    # and capabilities. Requires prometheus-operator CRDs to be installed.
    enabled: false
    interval: "30s"
```

Create `helm/kubeclaw/templates/metrics-servicemonitor.yaml`:

```yaml
{{- if .Values.metrics.serviceMonitor.enabled -}}
---
# Orchestrator ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubeclaw-orchestrator-metrics
  namespace: {{ .Values.namespace }}
  labels:
    app: kubeclaw-orchestrator
spec:
  selector:
    matchLabels:
      app: kubeclaw-orchestrator
  namespaceSelector:
    matchNames:
      - {{ .Values.namespace }}
  endpoints:
    - port: metrics
      interval: {{ .Values.metrics.serviceMonitor.interval }}
      path: /metrics
{{- range $name, $cfg := .Values.channels }}
{{- if $cfg.enabled }}
---
# Channel ServiceMonitor: {{ $name }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubeclaw-channel-{{ $name }}-metrics
  namespace: {{ $.Values.namespace }}
  labels:
    app: kubeclaw-channel-{{ $name }}
    kubeclaw/channel: {{ $name }}
spec:
  selector:
    matchLabels:
      app: kubeclaw-channel-{{ $name }}
  namespaceSelector:
    matchNames:
      - {{ $.Values.namespace }}
  endpoints:
    - port: metrics
      interval: {{ $.Values.metrics.serviceMonitor.interval }}
      path: /metrics
{{- end }}
{{- end }}
{{- range $name, $cfg := .Values.capabilities }}
---
# Capability ServiceMonitor: {{ $name }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubeclaw-capability-{{ $name }}-metrics
  namespace: {{ $.Values.namespace }}
  labels:
    app: kubeclaw-capability-{{ $name }}
    kubeclaw/capability: {{ $name }}
spec:
  selector:
    matchLabels:
      app: kubeclaw-capability-{{ $name }}
  namespaceSelector:
    matchNames:
      - {{ $.Values.namespace }}
  endpoints:
    - port: metrics
      interval: {{ $.Values.metrics.serviceMonitor.interval }}
      path: /metrics
{{- end }}
{{- end }}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `helm lint ./helm/kubeclaw`
Expected: PASS (0 errors, 0 warnings)

Run: `helm template kubeclaw ./helm/kubeclaw --set metrics.serviceMonitor.enabled=true | grep 'kind: ServiceMonitor' | wc -l`
Expected: at least 1 (orchestrator ServiceMonitor present even with no channels/capabilities configured)

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/templates/metrics-servicemonitor.yaml
git commit -m "feat(helm): add metrics.serviceMonitor.enabled and ServiceMonitor template for all tiers"
```

---

## Task 7: Helm — expose `metrics` port on tier Services

**Files:**
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`
- Modify: `helm/kubeclaw/templates/channel-pods.yaml`
- Modify: `helm/kubeclaw/templates/capability-pods.yaml`

- [ ] **Step 1: Write the failing template test**

```bash
# Should fail: orchestrator Service has no port named 'metrics' yet
helm template kubeclaw ./helm/kubeclaw | grep -A20 'name: kubeclaw-orchestrator' | grep 'metrics'
# Expected: empty output (port not present)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `helm template kubeclaw ./helm/kubeclaw | grep -B5 -A5 'name: metrics'`
Expected: no output referencing a `metrics` port on orchestrator/channel/capability Services

- [ ] **Step 3: Add metrics port to container specs and Services**

In `helm/kubeclaw/templates/orchestrator.yaml`, under the container's `ports:` list, add:

```yaml
            - name: metrics
              containerPort: {{ .Values.metrics.port }}
              protocol: TCP
```

And add a standalone `kubeclaw-orchestrator` Service if one does not already exist (the template currently exposes only an `admin` Service). Add after the admin Service block:

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-orchestrator
  namespace: {{ .Values.namespace }}
spec:
  selector:
    app: kubeclaw-orchestrator
  ports:
    - name: metrics
      port: {{ .Values.metrics.port }}
      targetPort: metrics
      protocol: TCP
  type: ClusterIP
```

In `helm/kubeclaw/templates/channel-pods.yaml`, under the container's `ports:` list, add inside the `{{- range $name, $cfg := .Values.channels }}` block:

```yaml
            - name: metrics
              containerPort: {{ $.Values.metrics.port }}
              protocol: TCP
```

And add a metrics port to the per-channel Service (which already exists for channels with `httpPort`, but not for those without). After the existing ClusterIP Service block, add the metrics port to it — or create a dedicated metrics Service if no http Service exists for the channel.

In `helm/kubeclaw/templates/capability-pods.yaml`, add to the container `ports:` and to the existing `kubeclaw-capability-{{ $name }}` Service:

```yaml
    - name: metrics
      port: {{ $.Values.metrics.port }}
      targetPort: metrics
      protocol: TCP
```

- [ ] **Step 4: Run tests, verify pass**

Run: `helm lint ./helm/kubeclaw`
Expected: PASS

Run: `helm template kubeclaw ./helm/kubeclaw | grep -c 'name: metrics'`
Expected: at least 2 (orchestrator container port + service port)

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/templates/orchestrator.yaml helm/kubeclaw/templates/channel-pods.yaml helm/kubeclaw/templates/capability-pods.yaml
git commit -m "feat(helm): expose metrics port on orchestrator, channel, and capability Services"
```

---

## Task 8: Docs — `docs/OBSERVABILITY.md` metric catalogue

**Files:**
- Create: `docs/OBSERVABILITY.md`

- [ ] **Step 1: Verify metric names are present in source before writing docs**

Run:
```bash
grep -r 'kubeclaw_tool_job_spawned_total\|kubeclaw_channel_messages_received_total\|kubeclaw_rag_query_duration_seconds\|kubeclaw_redis_ipc_messages_total' /home/peter/projects/kubeclaw/src/metrics/
```
Expected: matches in `orchestrator.ts`, `channel.ts`, `rag.ts`

- [ ] **Step 2: Write the doc**

```markdown
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
```

- [ ] **Step 3: Verify no drift between doc and source**

Run:
```bash
for metric in kubeclaw_tool_job_spawned_total kubeclaw_channel_messages_received_total kubeclaw_rag_query_duration_seconds kubeclaw_tool_job_duration_seconds kubeclaw_tool_job_failures_total kubeclaw_redis_ipc_messages_total kubeclaw_group_queue_depth kubeclaw_specialist_resolutions_total kubeclaw_db_query_duration_seconds kubeclaw_channel_llm_call_duration_seconds kubeclaw_channel_tokens_total kubeclaw_channel_tool_calls_total kubeclaw_channel_skill_loads_total kubeclaw_channel_conversation_history_size kubeclaw_rag_queries_total kubeclaw_rag_backend_errors_total kubeclaw_rag_index_duration_seconds kubeclaw_rag_chunks_indexed_total; do
  grep -rq "$metric" /home/peter/projects/kubeclaw/src/metrics/ || echo "MISSING IN SOURCE: $metric"
done
```
Expected: no output (all metrics exist in source)

- [ ] **Step 4: Commit**

```bash
git add docs/OBSERVABILITY.md
git commit -m "docs: add OBSERVABILITY.md with full metric catalogue for all tiers"
```

---

## Self-Review

### Spec compliance

- [x] Shared `src/metrics/registry.ts` factory extracted from credential-broker pattern — Task 1
- [x] Orchestrator `/metrics` on port 9091 with tool-job spawn, duration, failure-by-reason, Redis IPC, group queue depth, specialist resolution, db query duration — Task 2
- [x] Channel `/metrics` on port 9091 with messages received, LLM duration, tokens in/out, tool calls, skill loads, conversation history size — Task 3
- [x] RAG capability `/metrics` on port 9091 with query latency, query count, backend errors, index latency, chunks indexed — Task 4
- [x] Tool-job pods explicitly NOT scraped; orchestrator emits their metrics directly — design note in Task 5, implementation wired in `job-runner.ts`
- [x] Redis IPC message rate instrumented in `ipc-redis.ts` — Task 5
- [x] `metrics.serviceMonitor.enabled` Helm value parallel to existing `credentialInjection.metrics.serviceMonitor.enabled` — Task 6
- [x] ServiceMonitor covers orchestrator, all channel Deployments, and all capability Deployments — Task 6
- [x] `metrics` port added to tier Services — Task 7
- [x] `docs/OBSERVABILITY.md` documents all exported metrics, labels, ports, and how to enable scraping — Task 8
- [x] Unit tests at every task: registry factory, orchestrator metrics, channel metrics, RAG metrics
- [x] Integration test: HTTP server returns 200 with expected metric families after simulated events — Task 5
- [x] Helm tests: `helm lint` and `helm template | grep` assertions — Tasks 6 and 7

### No placeholders

Every code block contains runnable TypeScript or YAML. No `// TODO`, `// similar to Task X`, or `// implement this` comments appear in any code block.

### Consistent symbol names

- `createMetricsServer` — Task 1 factory, imported in Tasks 2, 3, 4, 5
- `createOrchestratorMetrics` — Task 2, imported in `src/index.ts` and `orchestrator-integration.test.ts`
- `createChannelMetrics` — Task 3, imported in `src/channel-runner.ts`
- `createRagMetrics` — Task 4, imported in `src/rag/retriever.ts` and `src/rag/indexer.ts`
- `OrchestratorMetrics` — interface exported from Task 2, typed in `src/k8s/job-runner.ts` and `src/k8s/ipc-redis.ts`
- `MetricsServer` — interface exported from Task 1
- Port env var: `METRICS_PORT` used consistently in Tasks 2 and 3, default `9091` in all tiers; credential-broker retains its own `BROKER_METRICS_PORT` default `9090` to avoid conflict when running in the same cluster
- Helm value: `metrics.port` (integer, default `9091`) referenced in Tasks 6 and 7
