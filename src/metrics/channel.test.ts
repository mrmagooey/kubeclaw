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
    const counter = metrics.find(
      (m) => m.name === 'kubeclaw_channel_messages_received_total',
    );
    expect(counter?.values[0]?.value).toBe(2);
    expect(counter?.values[0]?.labels?.channel_kind).toBe('telegram');
  });

  it('recordLlmCall observes duration and increments with provider/model/success labels', async () => {
    const registry = new Registry();
    const m = createChannelMetrics(registry);
    m.recordLlmCall({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      success: true,
      durationMs: 1200,
    });
    const metrics = await registry.getMetricsAsJSON();
    const hist = metrics.find(
      (m) => m.name === 'kubeclaw_channel_llm_call_duration_seconds',
    );
    const sum = hist?.values.find(
      (v) => v.metricName === 'kubeclaw_channel_llm_call_duration_seconds_sum',
    );
    expect(sum?.value).toBeCloseTo(1.2, 2);
  });

  it('recordTokens increments with direction/provider/model labels', async () => {
    const registry = new Registry();
    const m = createChannelMetrics(registry);
    m.recordTokens({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      direction: 'input',
      count: 500,
    });
    m.recordTokens({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      direction: 'output',
      count: 300,
    });
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find(
      (m) => m.name === 'kubeclaw_channel_tokens_total',
    );
    const inputRow = counter?.values.find(
      (v) => v.labels?.direction === 'input',
    );
    expect(inputRow?.value).toBe(500);
  });
});
