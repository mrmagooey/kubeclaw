import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { createMetrics } from './metrics.js';

describe('createMetrics', () => {
  let registry: Registry;
  let metrics: ReturnType<typeof createMetrics>;

  beforeEach(() => {
    registry = new Registry();
    metrics = createMetrics(registry);
  });

  it('registers credential_broker_authz_total counter', async () => {
    const text = await registry.metrics();
    expect(text).toContain('credential_broker_authz_total');
  });

  it('registers credential_broker_authz_duration_seconds histogram', async () => {
    const text = await registry.metrics();
    expect(text).toContain('credential_broker_authz_duration_seconds');
  });

  it('registers credential_broker_secret_read_failures_total counter', async () => {
    const text = await registry.metrics();
    expect(text).toContain('credential_broker_secret_read_failures_total');
  });

  it('registers credential_broker_config_reloads_total counter', async () => {
    const text = await registry.metrics();
    expect(text).toContain('credential_broker_config_reloads_total');
  });

  it('increments authz_total on record()', async () => {
    metrics.recordAuthz({
      status: 200,
      mappingId: 'anthropic',
      identity: 'sa/tool-job',
      auditOnly: false,
    });
    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_authz_total\{[^}]+\} 1/);
  });

  it('observes authz_duration_seconds on record()', async () => {
    metrics.recordAuthz({
      status: 200,
      mappingId: 'anthropic',
      identity: 'sa/tool-job',
      auditOnly: false,
      durationMs: 42,
    });
    const text = await registry.metrics();
    expect(text).toContain('credential_broker_authz_duration_seconds_sum');
  });

  it('increments secret_read_failures_total on recordSecretFailure()', async () => {
    metrics.recordSecretFailure({ secretName: 'kubeclaw-secrets' });
    const text = await registry.metrics();
    expect(text).toMatch(
      /credential_broker_secret_read_failures_total\{[^}]+\} 1/,
    );
  });

  it('increments config_reloads_total on recordConfigReload()', async () => {
    metrics.recordConfigReload({ result: 'success' });
    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_config_reloads_total\{[^}]+\} 1/);
  });
});
