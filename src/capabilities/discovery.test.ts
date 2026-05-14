import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _initTestDatabase } from '../db.js';

const mockXread = vi.hoisted(() => vi.fn());
const mockXrevrange = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));

vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    xread: mockXread,
    xrevrange: mockXrevrange,
    set: mockSet,
    publish: vi.fn().mockResolvedValue(1),
  })),
  // Dedicated stream-watcher connection used by watchRequests().
  getRedisStreamWatcher: vi.fn(() => ({
    xread: mockXread,
    xrevrange: mockXrevrange,
    set: mockSet,
  })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
  getDiscoveryRequestStream: () => 'kubeclaw:discovery:request',
  getDiscoveryResponseKey: (id: string) => `kubeclaw:discovery:response:${id}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./reconciler.js', () => ({
  applySpec: vi.fn().mockResolvedValue(undefined),
  deleteSpec: vi.fn().mockResolvedValue(undefined),
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));

import {
  startDiscoveryWatcher,
  stopDiscoveryWatcher,
  __handleRequestForTest,
} from './discovery.js';
import { __resetDbForTest } from '../db.js';
import { installCapability } from './registry.js';

beforeEach(async () => {
  // Initialize the in-memory DB once before each test
  await _initTestDatabase();
  __resetDbForTest();
  mockSet.mockClear();
  mockXread.mockClear();
});

describe('discovery', () => {
  it('answers a by-name request with a single entry', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await __handleRequestForTest({ requestId: 'r1', capability: 'weather' });
    const setArgs = mockSet.mock.calls[0];
    expect(setArgs[0]).toBe('kubeclaw:discovery:response:r1');
    const response = JSON.parse(setArgs[1]) as Array<{
      name: string;
      kind: string;
    }>;
    expect(response).toHaveLength(1);
    expect(response[0].kind).toBe('mcp');
  });

  it('returns capabilities filtered by channel ACL', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'private',
      image: 'mcp/private:1.0',
      channels: ['slack'],
    });
    await installCapability({
      kind: 'mcp',
      name: 'public',
      image: 'mcp/public:1.0',
    });
    await __handleRequestForTest({ requestId: 'r2', channel: 'http' });
    const response = JSON.parse(mockSet.mock.calls[0][1]) as Array<{
      name: string;
    }>;
    expect(response.map((r) => r.name).sort()).toEqual(['public']);
  });

  it('startDiscoveryWatcher is idempotent — second call is a no-op', () => {
    mockXrevrange.mockClear();
    startDiscoveryWatcher();
    startDiscoveryWatcher();
    // resolveStreamTip uses xrevrange; the second start would call it a second time
    // if it weren't guarded. The watch loop is async — wait a microtask so the loop body
    // begins executing before we count.
    return Promise.resolve().then(() => {
      expect(mockXrevrange).toHaveBeenCalledTimes(1);
      stopDiscoveryWatcher();
    });
  });

  it('returns empty array for unknown capability name', async () => {
    await __handleRequestForTest({
      requestId: 'r3',
      capability: 'does-not-exist',
    });
    const response = JSON.parse(mockSet.mock.calls[0][1]);
    expect(response).toEqual([]);
  });

  it('denies a by-name request when channel ACL excludes the requester', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'slack-only',
      image: 'mcp/x:1.0',
      channels: ['slack'],
    });
    await __handleRequestForTest({
      requestId: 'r4',
      capability: 'slack-only',
      channel: 'http',
    });
    const response = JSON.parse(mockSet.mock.calls[0][1]);
    expect(response).toEqual([]);
  });

  it('denies a by-name request without channel for ACL-restricted spec', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'restricted',
      image: 'mcp/x:1.0',
      channels: ['slack'],
    });
    await __handleRequestForTest({
      requestId: 'rNoChan',
      capability: 'restricted',
    });
    const response = JSON.parse(mockSet.mock.calls[0][1]);
    expect(response).toEqual([]);
  });

  it('allows a by-name request without channel for unrestricted spec', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'public',
      image: 'mcp/p:1.0',
    });
    await __handleRequestForTest({ requestId: 'rOpen', capability: 'public' });
    const response = JSON.parse(mockSet.mock.calls[0][1]);
    expect(response).toHaveLength(1);
    expect(response[0].name).toBe('public');
  });
});
