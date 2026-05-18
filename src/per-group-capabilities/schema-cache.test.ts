import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import {
  cacheSchemas,
  getCachedSchemas,
  clearCachedSchemas,
} from './schema-cache.js';

const schemas = [
  { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } },
];

beforeAll(async () => { await _initTestDatabase(); });
beforeEach(() => { __resetDbForTest(); });

describe('capability_tool_schemas', () => {
  it('round-trips a schema set', () => {
    cacheSchemas('echo', 'kubeclaw-echo-mcp:test', schemas);
    expect(getCachedSchemas('echo', 'kubeclaw-echo-mcp:test')).toEqual(schemas);
  });

  it('returns null for unknown (capability, image)', () => {
    expect(getCachedSchemas('nope', 'i:1')).toBeNull();
  });

  it('upsert overwrites previous schemas for same (capability, image)', () => {
    cacheSchemas('echo', 'i:1', schemas);
    cacheSchemas('echo', 'i:1', [{ name: 'echo2', inputSchema: {} }]);
    expect(getCachedSchemas('echo', 'i:1')?.[0].name).toBe('echo2');
  });

  it('different image tag is a distinct cache entry', () => {
    cacheSchemas('echo', 'i:1', schemas);
    expect(getCachedSchemas('echo', 'i:2')).toBeNull();
  });

  it('clearCachedSchemas removes the entry', () => {
    cacheSchemas('echo', 'i:1', schemas);
    clearCachedSchemas('echo', 'i:1');
    expect(getCachedSchemas('echo', 'i:1')).toBeNull();
  });
});
