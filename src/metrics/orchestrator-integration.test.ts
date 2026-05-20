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
    m.recordToolJobFailure({
      image: 'ghcr.io/kubeclaw/tool:v1',
      reason: 'timeout',
    });
    m.recordToolJobDuration({
      image: 'ghcr.io/kubeclaw/tool:v1',
      success: false,
      durationMs: 600000,
    });

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
