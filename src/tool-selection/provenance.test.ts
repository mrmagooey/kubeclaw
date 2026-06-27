import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import {
  recordAutoTool,
  touchAutoTool,
  recordAutoToolUse,
  getAutoTool,
  listAutoTools,
  pruneStaleAutoTools,
} from './provenance.js';

describe('provenance store', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('records and reads back an auto tool', () => {
    recordAutoTool({
      name: 'extract_metadata',
      provenance: 'library',
      scopeGroup: null,
      now: 1000,
    });
    const m = getAutoTool('extract_metadata');
    expect(m?.provenance).toBe('library');
    expect(m?.acquiredAt).toBe(1000);
    expect(m?.lastUsedAt).toBe(1000);
  });

  it('touch updates last_used_at only', () => {
    recordAutoTool({
      name: 't',
      provenance: 'discovered',
      scopeGroup: 'g',
      now: 1000,
    });
    touchAutoTool('t', 5000);
    const m = getAutoTool('t');
    expect(m?.acquiredAt).toBe(1000);
    expect(m?.lastUsedAt).toBe(5000);
  });

  it('recordAutoToolUse touches an auto tool', () => {
    recordAutoTool({
      name: 't',
      provenance: 'discovered',
      scopeGroup: 'g',
      now: 1000,
    });
    expect(recordAutoToolUse('t', 5000)).toBe(true);
    expect(getAutoTool('t')?.lastUsedAt).toBe(5000);
  });

  it('recordAutoToolUse is a no-op for a non-auto/unknown tool', () => {
    expect(recordAutoToolUse('not-registered', 5000)).toBe(false);
    expect(getAutoTool('not-registered')).toBeUndefined();
  });

  it('prunes only tools idle beyond the TTL', () => {
    recordAutoTool({
      name: 'old',
      provenance: 'discovered',
      scopeGroup: 'g',
      now: 0,
    });
    recordAutoTool({
      name: 'fresh',
      provenance: 'discovered',
      scopeGroup: 'g',
      now: 9000,
    });
    const pruned = pruneStaleAutoTools(10000, 5000); // ttl 5s
    expect(pruned).toEqual(['old']);
    expect(getAutoTool('old')).toBeUndefined();
    expect(getAutoTool('fresh')).toBeDefined();
  });

  it('lists all auto tools', () => {
    recordAutoTool({
      name: 'a',
      provenance: 'catalog',
      scopeGroup: null,
      now: 1,
    });
    recordAutoTool({
      name: 'b',
      provenance: 'library',
      scopeGroup: 'g',
      now: 2,
    });
    const all = listAutoTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
