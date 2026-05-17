/**
 * Tests that the GroupQueue.queueDepth() → setGroupQueueDepth wiring works
 * correctly when called from outside index.ts (mirrors the setInterval logic).
 */
import { describe, it, expect, vi } from 'vitest';
import { GroupQueue } from '../group-queue.js';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './orchestrator.js';

describe('queue depth wiring', () => {
  it('setGroupQueueDepth reflects queueDepth() from GroupQueue', async () => {
    const registry = new Registry();
    const metrics = createOrchestratorMetrics(registry);

    const queue = new GroupQueue();
    // Use enqueueTask to push a pending task — the task fn never resolves so
    // we can measure depth before it drains.
    let resolveTask!: () => void;
    const neverSettles = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    queue.enqueueTask('jid-1', 'task-running', () => neverSettles);
    // Enqueue a second item for the same jid while first is active:
    // this sets pendingMessages=true
    queue.enqueueMessageCheck('jid-1');

    const depth = queue.queueDepth('jid-1');
    // pendingMessages flag = 1 (the running task itself is not counted)
    expect(depth).toBeGreaterThanOrEqual(1);

    metrics.setGroupQueueDepth({ group: 'group-folder-1' }, depth);

    const metricsJson = await registry.getMetricsAsJSON();
    const gauge = metricsJson.find((m) => m.name === 'kubeclaw_group_queue_depth');
    expect(gauge).toBeDefined();
    const row = gauge?.values.find((v) => v.labels?.group === 'group-folder-1');
    expect(row?.value).toBeGreaterThanOrEqual(1);

    // Resolve the stuck task to avoid dangling promises
    resolveTask();
  });

  it('setGroupQueueDepth sets gauge to 0 when queue is idle', async () => {
    const registry = new Registry();
    const metrics = createOrchestratorMetrics(registry);

    const queue = new GroupQueue();
    const depth = queue.queueDepth('empty-jid');
    expect(depth).toBe(0);

    metrics.setGroupQueueDepth({ group: 'empty-group' }, depth);

    const metricsJson = await registry.getMetricsAsJSON();
    const gauge = metricsJson.find((m) => m.name === 'kubeclaw_group_queue_depth');
    const row = gauge?.values.find((v) => v.labels?.group === 'empty-group');
    expect(row?.value).toBe(0);
  });
});
