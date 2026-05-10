import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInstall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockList = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockEntries = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('./capabilities/index.js', () => ({
  installCapability: mockInstall,
  removeCapability: mockRemove,
  listCapabilities: mockList,
  getEntriesForChannel: mockEntries,
  notifyAllChannels: mockNotify,
}));

import {
  deployMcpServer,
  removeMcpServer,
  listMcpServers,
  getServersForChannel,
  notifyAllChannels,
  syncFromValues,
} from './mcp-registry.js';

beforeEach(() => {
  mockInstall.mockClear();
  mockRemove.mockClear();
  mockList.mockClear();
  mockEntries.mockClear();
  mockNotify.mockClear();
});

describe('mcp-registry shim', () => {
  it('deployMcpServer delegates to installCapability with kind=mcp', async () => {
    await deployMcpServer({ name: 'weather', image: 'mcp/weather:1.0' });
    expect(mockInstall).toHaveBeenCalledWith({
      name: 'weather',
      image: 'mcp/weather:1.0',
      kind: 'mcp',
    });
  });

  it('removeMcpServer delegates to removeCapability', async () => {
    await removeMcpServer('weather');
    expect(mockRemove).toHaveBeenCalledWith('weather');
  });

  it('listMcpServers returns only mcp-kind capabilities', () => {
    mockList.mockReturnValueOnce([
      { kind: 'mcp', name: 'a', image: 'mcp/a:1' },
      { kind: 'rag', name: 'r', image: 'q', backend: 'qdrant' },
    ]);
    const result = listMcpServers();
    expect(result.map((s) => s.name)).toEqual(['a']);
  });

  it('getServersForChannel maps mcp entries to {name,url,allowedTools}', () => {
    mockEntries.mockReturnValueOnce([
      {
        kind: 'mcp',
        name: 'weather',
        endpoint: 'http://kubeclaw-cap-weather:3000',
        kindMetadata: { path: '/mcp', allowedTools: ['get_forecast'] },
      },
      {
        kind: 'rag',
        name: 'r',
        endpoint: 'http://r:6333',
        kindMetadata: { backend: 'qdrant' },
      },
    ]);
    const result = getServersForChannel('http');
    expect(result).toEqual([
      {
        name: 'weather',
        url: 'http://kubeclaw-cap-weather:3000/mcp',
        allowedTools: ['get_forecast'],
      },
    ]);
  });

  it('notifyAllChannels delegates to capabilities notify', async () => {
    await notifyAllChannels();
    expect(mockNotify).toHaveBeenCalledOnce();
  });

  it('syncFromValues calls installCapability for each spec', async () => {
    await syncFromValues([
      { name: 'a', image: 'mcp/a:1' },
      { name: 'b', image: 'mcp/b:1' },
    ]);
    expect(mockInstall).toHaveBeenCalledTimes(2);
  });
});
