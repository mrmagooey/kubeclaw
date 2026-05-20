/**
 * Tests that setDbQueryCallback fires for hot-path db operations and that
 * the recorded data reaches the Prometheus histogram.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './orchestrator.js';
import {
  setDbQueryCallback,
  _initTestDatabase,
  storeMessage,
  getConversationHistory,
  getMessagesSince,
  __resetDbForTest,
} from '../db.js';

beforeEach(async () => {
  await _initTestDatabase();
});

afterEach(() => {
  __resetDbForTest();
  // Reset callback
  setDbQueryCallback(() => {});
});

describe('db query wiring', () => {
  it('storeMessage fires the db query callback with operation="storeMessage"', () => {
    const calls: Array<{ op: string; ms: number }> = [];
    setDbQueryCallback((op, ms) => calls.push({ op, ms }));

    storeMessage({
      id: 'msg-1',
      chat_jid: 'group-1@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Hello',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('storeMessage');
    expect(calls[0].ms).toBeGreaterThanOrEqual(0);
  });

  it('getConversationHistory fires the db query callback with operation="getConversationHistory"', () => {
    const calls: Array<{ op: string; ms: number }> = [];
    setDbQueryCallback((op, ms) => calls.push({ op, ms }));

    getConversationHistory('test-group');

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('getConversationHistory');
  });

  it('getMessagesSince fires the db query callback with operation="getMessagesSince"', () => {
    const calls: Array<{ op: string; ms: number }> = [];
    setDbQueryCallback((op, ms) => calls.push({ op, ms }));

    getMessagesSince('group-1@g.us', '', 'bot');

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('getMessagesSince');
  });

  it('recordDbQuery histogram is populated via the wired callback', async () => {
    const registry = new Registry();
    const metrics = createOrchestratorMetrics(registry);
    setDbQueryCallback((op, ms) =>
      metrics.recordDbQuery({ operation: op, durationMs: ms }),
    );

    getConversationHistory('test-group');
    storeMessage({
      id: 'msg-2',
      chat_jid: 'group-2@g.us',
      sender: 'user1',
      sender_name: 'User One',
      content: 'Hi',
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });

    const metricsJson = await registry.getMetricsAsJSON();
    const hist = metricsJson.find(
      (m) => m.name === 'kubeclaw_db_query_duration_seconds',
    );
    expect(hist).toBeDefined();
    const getHistRow = hist?.values.find(
      (v) =>
        v.labels?.operation === 'getConversationHistory' &&
        v.metricName?.endsWith('_count'),
    );
    expect(getHistRow?.value).toBe(1);
    const storeHistRow = hist?.values.find(
      (v) =>
        v.labels?.operation === 'storeMessage' &&
        v.metricName?.endsWith('_count'),
    );
    expect(storeHistRow?.value).toBe(1);
  });
});
