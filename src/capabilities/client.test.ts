import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEntries = vi.hoisted(() => vi.fn());

vi.mock('./registry.js', () => ({
  getEntriesForChannel: mockEntries,
  listCapabilities: vi.fn().mockReturnValue([]),
  listCapabilitiesByKind: vi.fn().mockReturnValue([]),
  getCapabilityByName: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagEntry, getMcpEntries, getHttpEntry } from './client.js';

beforeEach(() => mockEntries.mockReset());

describe('client', () => {
  it('getRagEntry returns the first rag capability for the channel', () => {
    mockEntries.mockReturnValue([
      {
        kind: 'rag',
        name: 'main',
        endpoint: 'http://x',
        kindMetadata: { backend: 'qdrant' },
      },
      {
        kind: 'mcp',
        name: 'wx',
        endpoint: 'http://y',
        kindMetadata: { path: '/mcp' },
      },
    ]);
    expect(getRagEntry('http')?.name).toBe('main');
  });

  it('getRagEntry returns undefined when no rag is registered', () => {
    mockEntries.mockReturnValue([]);
    expect(getRagEntry('http')).toBeUndefined();
  });

  it('getMcpEntries returns only MCP entries', () => {
    mockEntries.mockReturnValue([
      {
        kind: 'rag',
        name: 'main',
        endpoint: '',
        kindMetadata: { backend: 'qdrant' },
      },
      { kind: 'mcp', name: 'wx', endpoint: '', kindMetadata: { path: '/mcp' } },
      {
        kind: 'mcp',
        name: 'cal',
        endpoint: '',
        kindMetadata: { path: '/mcp' },
      },
    ]);
    expect(getMcpEntries('http').map((e) => e.name)).toEqual(['wx', 'cal']);
  });

  it('getHttpEntry returns the named http entry when present', () => {
    mockEntries.mockReturnValue([
      { kind: 'http', name: 'cache', endpoint: 'http://c', kindMetadata: {} },
      {
        kind: 'http',
        name: 'shortener',
        endpoint: 'http://s',
        kindMetadata: {},
      },
    ]);
    expect(getHttpEntry('http', 'shortener')?.endpoint).toBe('http://s');
  });

  it('getHttpEntry returns undefined when no match', () => {
    mockEntries.mockReturnValue([]);
    expect(getHttpEntry('http', 'nope')).toBeUndefined();
  });
});
