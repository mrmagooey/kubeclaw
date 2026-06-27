import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { recordAutoTool, getAutoTool } from './provenance.js';
import { registerTool, listToolOverrides } from '../skills/orchestrator/tool-registry.js';
import { sweepStaleAutoTools } from './sweep.js';
import type { ToolSpec } from '../tools/types.js';

const spec: ToolSpec = { name: 'stale_tool', description: 'd', parameters: {}, image: 'i', pattern: 'file' };

describe('sweepStaleAutoTools', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('removes the override and provenance for an idle auto tool and reconciles', async () => {
    registerTool(spec);
    recordAutoTool({ name: 'stale_tool', provenance: 'discovered', scopeGroup: 'g', now: 0 });
    let reconciled = 0;
    const pruned = await sweepStaleAutoTools({ now: 10_000, ttlMs: 5_000, reconcile: async () => { reconciled++; } });
    expect(pruned).toEqual(['stale_tool']);
    expect(getAutoTool('stale_tool')).toBeUndefined();
    expect(listToolOverrides().some((t) => t.name === 'stale_tool')).toBe(false);
    expect(reconciled).toBe(1);
  });

  it('does not reconcile when nothing is stale', async () => {
    let reconciled = 0;
    await sweepStaleAutoTools({ now: 1, ttlMs: 5_000, reconcile: async () => { reconciled++; } });
    expect(reconciled).toBe(0);
  });
});
