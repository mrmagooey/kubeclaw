import { describe, it, expect, afterEach } from 'vitest';
import { Registry } from 'prom-client';
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
