import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeCatalog,
  renderCatalog,
  SpecialistReconciler,
} from './reconciler.js';
import { parseSpecialists } from './types.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { registerSpecialist } from '../skills/orchestrator/specialist-registry.js';

describe('mergeCatalog', () => {
  it('override wins on name collision', () => {
    const baseline = [{ name: 'A', prompt: 'baseline' }];
    const overrides = [{ name: 'A', prompt: 'override' }];
    expect(mergeCatalog(baseline, overrides)).toEqual([
      { name: 'A', prompt: 'override' },
    ]);
  });

  it('keeps baseline-only and override-only entries', () => {
    const merged = mergeCatalog(
      [
        { name: 'A', prompt: 'a' },
        { name: 'B', prompt: 'b' },
      ],
      [
        { name: 'B', prompt: 'b2' },
        { name: 'C', prompt: 'c' },
      ],
    );
    expect(merged.map((s) => s.name).sort()).toEqual(['A', 'B', 'C']);
    expect(merged.find((s) => s.name === 'B')!.prompt).toBe('b2');
  });

  it('returns sorted output when inputs are unsorted', () => {
    const merged = mergeCatalog(
      [
        { name: 'Z', prompt: 'z' },
        { name: 'A', prompt: 'a' },
      ],
      [],
    );
    expect(merged.map((s) => s.name)).toEqual(['A', 'Z']);
  });

  it('returns empty array when both inputs are empty', () => {
    expect(mergeCatalog([], [])).toEqual([]);
  });
});

describe('renderCatalog', () => {
  it('produces parseable wire format with monotonic generation', () => {
    const r1 = renderCatalog([{ name: 'A', prompt: 'p' }], 5);
    expect(JSON.parse(r1).generation).toBe(5);
    expect(JSON.parse(r1).version).toBe(1);
  });

  it('includes specialists in output', () => {
    const rendered = renderCatalog([{ name: 'A', prompt: 'p' }], 1);
    const parsed = JSON.parse(rendered);
    expect(parsed.specialists).toHaveLength(1);
    expect(parsed.specialists[0].name).toBe('A');
  });
});

describe('SpecialistReconciler.apply', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('writes a merged ConfigMap via the k8s client', async () => {
    registerSpecialist({ name: 'OnlyOverride', prompt: 'x' });
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => [{ name: 'Baseline', prompt: 'b' }],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const body = JSON.parse(apply.mock.calls[0][0]);
    expect(
      body.specialists.map((s: { name: string }) => s.name).sort(),
    ).toEqual(['Baseline', 'OnlyOverride']);
  });

  it('increments generation on each successful apply', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });
    await r.apply();
    await r.apply();
    const gen1 = JSON.parse(apply.mock.calls[0][0]).generation;
    const gen2 = JSON.parse(apply.mock.calls[1][0]).generation;
    expect(gen2).toBeGreaterThan(gen1);
  });

  it('does not bump generation when configMapApply throws', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error('k8s error'))
      .mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });
    await expect(r.apply()).rejects.toThrow('k8s error');
    await r.apply();
    // second call should have generation=1 (not 2) because first failed
    const gen = JSON.parse(apply.mock.calls[1][0]).generation;
    expect(gen).toBe(1);
  });

  it('merges baseline and overrides correctly', async () => {
    registerSpecialist({ name: 'Override', prompt: 'override-prompt' });
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => [
        { name: 'BaseOnly', prompt: 'base' },
        { name: 'Override', prompt: 'original' },
      ],
      configMapApply: apply,
    });
    await r.apply();
    const body = JSON.parse(apply.mock.calls[0][0]);
    const names = body.specialists.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['BaseOnly', 'Override']);
    const override = body.specialists.find(
      (s: { name: string }) => s.name === 'Override',
    );
    expect(override.prompt).toBe('override-prompt');
  });

  it('renders Researcher baseline entry with all fields via ConfigMap apply', async () => {
    const researcherBaseline = [
      {
        name: 'Researcher',
        prompt:
          'You are a web-research specialist. When given a topic or question:\n' +
          '1. Search for relevant, current information using available search tools.\n' +
          '2. Fetch and read promising sources to gather details.\n' +
          '3. Synthesise findings into a concise, structured summary with:\n' +
          '   - A one-paragraph executive summary.\n' +
          '   - Key facts as a bulleted list.\n' +
          '   - Source URLs cited inline.\n' +
          'Stay factual; note when information is uncertain or conflicting.\n',
        triggers: ['researcher'],
        llmProvider: 'openrouter',
        memory: { isolated: false },
        tools: ['web_search', 'web_fetch'],
      },
    ];

    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new SpecialistReconciler({
      baselineLoader: () => researcherBaseline,
      configMapApply: apply,
    });
    await r.apply();

    expect(apply).toHaveBeenCalledOnce();
    const rendered: string = apply.mock.calls[0][0];

    // Round-trip: parseSpecialists must accept the rendered JSON.
    const parseResult = parseSpecialists(rendered);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return; // type narrowing

    // The entry must survive the merge/render round-trip intact.
    const researcher = parseResult.specialists.find((s) => s.name === 'Researcher');
    expect(researcher, 'Researcher entry missing from rendered catalog').toBeDefined();
    expect(researcher!.triggers).toEqual(['researcher']);
    expect(researcher!.llmProvider).toBe('openrouter');
    expect(researcher!.memory?.isolated).toBe(false);
    expect(researcher!.tools).toEqual(['web_search', 'web_fetch']);
    expect(researcher!.prompt).toContain('web-research specialist');
  });
});
