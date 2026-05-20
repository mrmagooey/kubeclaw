import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { scrapeMissingSchemas } from './schema-scraper.js';
import { upsertInstance } from './db.js';
import { getCachedSchemas } from './schema-cache.js';
import type { CapabilitySpec } from '../capabilities/types.js';

const echoSpec: CapabilitySpec = {
  name: 'echo',
  kind: 'mcp',
  image: 'kubeclaw-echo-mcp:test',
  scope: 'group',
};

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('scrapeMissingSchemas', () => {
  it('skips capabilities with no per-group Deployment yet', async () => {
    const client = new FakePerGroupK8sClient();
    const fakeMcpClient = vi.fn();
    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList: fakeMcpClient,
    });
    expect(fakeMcpClient).not.toHaveBeenCalled();
  });

  it('scales up, scrapes, caches, scales down for one (capability, image)', async () => {
    const client = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    setTimeout(() => client.markReady('kubeclaw', 'mcp-echo-h1'), 5);

    const callToolsList = vi
      .fn()
      .mockResolvedValue([
        {
          name: 'echo',
          description: 'echoes',
          inputSchema: { type: 'object' },
        },
      ]);

    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList,
    });

    expect(callToolsList).toHaveBeenCalledWith(
      'http://mcp-echo-h1.kubeclaw.svc.cluster.local:3000',
    );
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toEqual([
      { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
    ]);
    const dep = await client.readDeployment('kubeclaw', 'mcp-echo-h1');
    expect(dep?.spec?.replicas).toBe(0);
  });

  it('skips when schema already cached', async () => {
    const client = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    const { cacheSchemas } = await import('./schema-cache.js');
    cacheSchemas('echo', 'kubeclaw-echo-mcp:test', [
      { name: 'echo', inputSchema: {} },
    ]);
    const callToolsList = vi.fn();
    await scrapeMissingSchemas({
      client,
      namespace: 'kubeclaw',
      specs: [echoSpec],
      callToolsList,
    });
    expect(callToolsList).not.toHaveBeenCalled();
  });

  it('records failure attempt and gives up after 3 retries', async () => {
    const client = new FakePerGroupK8sClient();
    upsertInstance({
      groupFolder: 'Family',
      capabilityName: 'echo',
      groupHash: 'h1',
      deploymentName: 'mcp-echo-h1',
      serviceName: 'mcp-echo-h1',
    });
    await client.applyDeployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'mcp-echo-h1', namespace: 'kubeclaw' },
      spec: {
        replicas: 0,
        selector: { matchLabels: {} },
        template: { metadata: {}, spec: { containers: [] } },
      },
    });
    // Never mark ready -> waitForReady will time out with the short timeout below.
    const callToolsList = vi.fn();
    const state = { failures: new Map<string, number>() };
    for (let i = 0; i < 5; i++) {
      await scrapeMissingSchemas({
        client,
        namespace: 'kubeclaw',
        specs: [echoSpec],
        callToolsList,
        scrapeTimeoutMs: 30,
        failureState: state,
      });
    }
    expect(callToolsList).not.toHaveBeenCalled();
    expect(state.failures.get('echo|kubeclaw-echo-mcp:test')).toBe(3);
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toBeNull();
  });
});
