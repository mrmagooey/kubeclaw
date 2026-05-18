import { describe, it, expect } from 'vitest';
import type { CapabilityDiscoveryEntry, GroupMcpEntry } from './types.js';

describe('CapabilityDiscoveryEntry — GroupMcpEntry variant', () => {
  it('accepts mcp-group variant with state: ready', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [{ name: 'echo', inputSchema: {} }],
    };
    const union: CapabilityDiscoveryEntry = entry;
    expect(union.kind).toBe('mcp-group');
  });

  it('accepts mcp-group variant with state: pending-schema', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'pending-schema',
    };
    expect(entry.state).toBe('pending-schema');
  });

  it('accepts mcp-group variant with state: failed and error', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'failed',
      error: 'scrape timed out',
    };
    expect(entry.error).toBe('scrape timed out');
  });

  it('mcp-group entry includes optional allowedTools', () => {
    const entry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [{ name: 'echo', inputSchema: {} }],
      allowedTools: ['echo'],
    };
    expect(entry.allowedTools).toEqual(['echo']);
  });
});
