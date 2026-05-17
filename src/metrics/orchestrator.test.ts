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
