/**
 * Tests that detectMentionedSpecialists calls the resolution callback,
 * which is what the orchestrator uses to record to Prometheus.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectMentionedSpecialists,
  setSpecialistResolutionCallback,
  type SpecialistDef,
} from '../specialists.js';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './orchestrator.js';

describe('specialist resolution wiring', () => {
  it('callback fires with specialist name on each resolution', () => {
    const captured: string[] = [];
    setSpecialistResolutionCallback((name) => captured.push(name));

    const available: SpecialistDef[] = [
      { name: 'Research', prompt: 'You are a researcher' },
      { name: 'Coder', prompt: 'You are a coder' },
    ];

    detectMentionedSpecialists('@Research please look this up', available);
    expect(captured).toEqual(['Research']);

    detectMentionedSpecialists('@Coder write a function', available);
    expect(captured).toEqual(['Research', 'Coder']);

    // Reset callback to avoid leaking state to other tests
    setSpecialistResolutionCallback(() => {});
  });

  it('recordSpecialistResolution is called via orchMetrics callback', async () => {
    const registry = new Registry();
    const metrics = createOrchestratorMetrics(registry);

    setSpecialistResolutionCallback((name) =>
      metrics.recordSpecialistResolution({ specialist: name }),
    );

    const available: SpecialistDef[] = [
      { name: 'Analyst', prompt: 'You are an analyst' },
    ];

    detectMentionedSpecialists('@Analyst check this', available);

    const metricsJson = await registry.getMetricsAsJSON();
    const counter = metricsJson.find(
      (m) => m.name === 'kubeclaw_specialist_resolutions_total',
    );
    expect(counter).toBeDefined();
    const row = counter?.values.find((v) => v.labels?.specialist === 'Analyst');
    expect(row?.value).toBe(1);

    // Reset
    setSpecialistResolutionCallback(() => {});
  });

  it('no callback: detectMentionedSpecialists still returns correct results', () => {
    setSpecialistResolutionCallback(() => {});
    const available: SpecialistDef[] = [
      { name: 'Helper', prompt: 'You are a helper' },
    ];
    const result = detectMentionedSpecialists('@Helper help me', available);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Helper');
  });
});
