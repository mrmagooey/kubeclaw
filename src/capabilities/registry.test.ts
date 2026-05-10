import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockApply = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDelete = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));

vi.mock('./reconciler.js', () => ({
  applySpec: mockApply,
  deleteSpec: mockDelete,
  reconcileAllOnStartup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: mockPublish })),
  getControlChannel: (n: string) => `kubeclaw:control:${n}`,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  installCapability,
  removeCapability,
  listCapabilities,
  getEntriesForChannel,
} from './registry.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
  mockApply.mockClear();
  mockDelete.mockClear();
  mockPublish.mockClear();
});

describe('registry', () => {
  it('install persists, applies, and notifies channels', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    expect(mockApply).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(1);
    expect(mockPublish).toHaveBeenCalled();
  });

  it('remove deletes K8s resources, removes DB row, notifies', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    mockPublish.mockClear();
    await removeCapability('weather');
    expect(mockDelete).toHaveBeenCalledOnce();
    expect(listCapabilities()).toHaveLength(0);
    expect(mockPublish).toHaveBeenCalled();
  });

  it('install of a duplicate name updates the spec', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'weather',
      image: 'mcp/weather:2.0',
    });
    const list = listCapabilities();
    expect(list).toHaveLength(1);
    expect(list[0].image).toBe('mcp/weather:2.0');
  });

  it('getEntriesForChannel returns only ACL-allowed entries', async () => {
    await installCapability({
      kind: 'mcp',
      name: 'public-mcp',
      image: 'mcp/public:1.0',
    });
    await installCapability({
      kind: 'mcp',
      name: 'slack-only',
      image: 'mcp/slack:1.0',
      channels: ['slack'],
    });
    await installCapability({
      kind: 'mcp',
      name: 'discord-only',
      image: 'mcp/discord:1.0',
      channels: ['discord'],
    });

    expect(getEntriesForChannel('slack').map((e) => e.name).sort()).toEqual([
      'public-mcp',
      'slack-only',
    ]);
    expect(getEntriesForChannel('http').map((e) => e.name).sort()).toEqual([
      'public-mcp',
    ]);
  });

  it("remove notifies a non-standard channel name that was ACL'd to the removed spec", async () => {
    await installCapability({
      kind: 'mcp',
      name: 'mychan-only',
      image: 'mcp/x:1.0',
      channels: ['mychan'], // not in KNOWN_CHANNELS
    });
    mockPublish.mockClear();
    await removeCapability('mychan-only');
    // mockPublish was called for each targeted channel, including mychan.
    const publishedChannels = mockPublish.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(publishedChannels).toContain('kubeclaw:control:mychan');
  });
});
