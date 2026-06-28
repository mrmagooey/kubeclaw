import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import {
  putPendingDiscovered,
  getPendingDiscovered,
  deletePendingDiscovered,
  prunePendingDiscovered,
} from './pending-discovered.js';
import type { ToolSpec } from '../tools/types.js';

const exampleSpec: ToolSpec = {
  name: 'smart_search',
  description: 'Web search via brave',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  image: 'registry.example.com/smart-search:latest@sha256:abc123',
  pattern: 'http',
  credentials: ['brave-search'],
  allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
  channels: ['http'],
};

describe('pending-discovered store', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('put/get round-trip preserves spec fidelity', () => {
    putPendingDiscovered({
      name: 'smart_search',
      spec: exampleSpec,
      scopeGroup: 'team-a',
      catalogId: 'brave-search',
      now: 1000,
    });

    const result = getPendingDiscovered('smart_search');
    expect(result).toBeDefined();
    expect(result!.spec).toEqual(exampleSpec);
    expect(result!.scopeGroup).toBe('team-a');
    expect(result!.catalogId).toBe('brave-search');
    expect(result!.createdAt).toBe(1000);
  });

  it('returns undefined for a missing name', () => {
    expect(getPendingDiscovered('nonexistent')).toBeUndefined();
  });

  it('stores a null scopeGroup', () => {
    putPendingDiscovered({
      name: 'smart_search',
      spec: exampleSpec,
      scopeGroup: null,
      catalogId: 'brave-search',
      now: 2000,
    });
    const result = getPendingDiscovered('smart_search');
    expect(result!.scopeGroup).toBeNull();
  });

  it('INSERT OR REPLACE overwrites an existing pending entry', () => {
    putPendingDiscovered({
      name: 'smart_search',
      spec: exampleSpec,
      scopeGroup: 'team-a',
      catalogId: 'brave-search',
      now: 1000,
    });

    const updatedSpec: ToolSpec = { ...exampleSpec, description: 'Updated' };
    putPendingDiscovered({
      name: 'smart_search',
      spec: updatedSpec,
      scopeGroup: 'team-b',
      catalogId: 'brave-search-v2',
      now: 2000,
    });

    const result = getPendingDiscovered('smart_search');
    expect(result!.spec.description).toBe('Updated');
    expect(result!.scopeGroup).toBe('team-b');
    expect(result!.catalogId).toBe('brave-search-v2');
    expect(result!.createdAt).toBe(2000);
  });

  it('delete removes the row', () => {
    putPendingDiscovered({
      name: 'smart_search',
      spec: exampleSpec,
      scopeGroup: 'team-a',
      catalogId: 'brave-search',
      now: 1000,
    });
    deletePendingDiscovered('smart_search');
    expect(getPendingDiscovered('smart_search')).toBeUndefined();
  });

  it('delete is a no-op for unknown names', () => {
    // Should not throw.
    deletePendingDiscovered('nonexistent');
  });

  it('prune removes only rows older than the TTL', () => {
    putPendingDiscovered({
      name: 'old_tool',
      spec: exampleSpec,
      scopeGroup: null,
      catalogId: 'brave-search',
      now: 0,
    });
    putPendingDiscovered({
      name: 'fresh_tool',
      spec: { ...exampleSpec, name: 'fresh_tool' },
      scopeGroup: null,
      catalogId: 'brave-search',
      now: 9000,
    });

    const pruned = prunePendingDiscovered(10000, 5000); // now=10000, ttl=5000ms
    expect(pruned).toEqual(['old_tool']);
    expect(getPendingDiscovered('old_tool')).toBeUndefined();
    expect(getPendingDiscovered('fresh_tool')).toBeDefined();
  });

  it('prune returns empty array when nothing is stale', () => {
    putPendingDiscovered({
      name: 'fresh_tool',
      spec: exampleSpec,
      scopeGroup: null,
      catalogId: 'brave-search',
      now: 9500,
    });
    const pruned = prunePendingDiscovered(10000, 5000);
    expect(pruned).toEqual([]);
  });
});
