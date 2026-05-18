import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { setCapability } from './db.js';
import { getMcpEntriesAsync } from './client.js';
import { cacheSchemas } from '../per-group-capabilities/schema-cache.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('getMcpEntriesAsync', () => {
  it('returns cluster-scoped mcp entries', async () => {
    setCapability({
      name: 'qdrant',
      kind: 'mcp',
      image: 'qdrant:1',
      port: 6333,
    });
    const entries = await getMcpEntriesAsync('telegram', undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('mcp');
  });

  it('emits mcp-group entries with pending-schema when no cache', async () => {
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
    });
    const entries = await getMcpEntriesAsync('telegram', undefined);
    const group = entries.find((e) => e.kind === 'mcp-group');
    expect(group?.state).toBe('pending-schema');
  });

  it('emits mcp-group entries with ready + schemas when cached', async () => {
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
    });
    cacheSchemas('echo', 'echo:1', [{ name: 'echo', inputSchema: {} }]);
    const entries = await getMcpEntriesAsync('telegram', undefined);
    const group = entries.find((e) => e.kind === 'mcp-group');
    expect(group?.state).toBe('ready');
    if (group?.kind === 'mcp-group') {
      expect(group.toolSchemas).toHaveLength(1);
    }
  });

  it('respects channel ACL on cluster mcp', async () => {
    setCapability({
      name: 'qdrant',
      kind: 'mcp',
      image: 'q:1',
      channels: ['discord'],
    });
    const tel = await getMcpEntriesAsync('telegram', undefined);
    const dis = await getMcpEntriesAsync('discord', undefined);
    expect(tel).toEqual([]);
    expect(dis).toHaveLength(1);
  });

  it('respects channel ACL on group-scoped capability', async () => {
    setCapability({
      name: 'echo',
      kind: 'mcp',
      image: 'echo:1',
      scope: 'group',
      channels: ['discord'],
    });
    cacheSchemas('echo', 'echo:1', [{ name: 'echo', inputSchema: {} }]);
    const tel = await getMcpEntriesAsync('telegram', undefined);
    const dis = await getMcpEntriesAsync('discord', undefined);
    expect(tel).toEqual([]);
    expect(dis).toHaveLength(1);
  });
});
