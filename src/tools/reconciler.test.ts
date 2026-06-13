import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { registerTool } from '../skills/orchestrator/tool-registry.js';
import {
  mergeCatalog,
  renderCatalog,
  ToolReconciler,
  resolveToolByName,
} from './reconciler.js';
import { ToolSpec } from './types.js';

const t = (name: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description: 'd',
  parameters: {},
  image: 'img:1',
  pattern: 'http',
  ...extra,
});

describe('mergeCatalog', () => {
  it('overrides win and result is name-sorted', () => {
    const merged = mergeCatalog(
      [t('b'), t('a', { image: 'baseline:1' })],
      [t('a', { image: 'override:1' })],
    );
    expect(merged.map((x) => x.name)).toEqual(['a', 'b']);
    expect(merged[0].image).toBe('override:1');
  });
});

describe('renderCatalog', () => {
  it('produces version-1 wire JSON', () => {
    const json = JSON.parse(renderCatalog([t('a')], 5));
    expect(json.version).toBe(1);
    expect(json.generation).toBe(5);
    expect(json.tools).toHaveLength(1);
  });
});

describe('ToolReconciler', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('merges baseline + overrides and applies the ConfigMap with a bumped generation', async () => {
    registerTool(t('override-tool'));
    const applied: string[] = [];
    const r = new ToolReconciler({
      baselineLoader: () => [t('baseline-tool')],
      configMapApply: async (rendered) => {
        applied.push(rendered);
      },
    });
    await r.apply();
    expect(applied).toHaveLength(1);
    const wire = JSON.parse(applied[0]);
    expect(wire.generation).toBe(1);
    expect(wire.tools.map((x: ToolSpec) => x.name).sort()).toEqual([
      'baseline-tool',
      'override-tool',
    ]);
  });

  it('rolls back generation when apply fails', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const r = new ToolReconciler({ baselineLoader: () => [], configMapApply: apply });
    await expect(r.apply()).rejects.toThrow('boom');
    await r.apply(); // succeeds
    // First call attempted generation 1 (then rolled back); the successful
    // second call must ALSO be generation 1 — proving the failure didn't bump it.
    expect(JSON.parse(apply.mock.calls[0][0] as string).generation).toBe(1);
    expect(JSON.parse(apply.mock.calls[1][0] as string).generation).toBe(1);
  });
});

describe('resolveToolByName', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('finds an override tool by name', () => {
    registerTool(t('weather', { image: 'w:9' }));
    const found = resolveToolByName('weather', () => []);
    expect(found?.image).toBe('w:9');
  });

  it('finds a baseline tool by name', () => {
    const found = resolveToolByName('bl', () => [t('bl')]);
    expect(found?.name).toBe('bl');
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveToolByName('nope', () => [])).toBeUndefined();
  });
});
