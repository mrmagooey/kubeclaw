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
