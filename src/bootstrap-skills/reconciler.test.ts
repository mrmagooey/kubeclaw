import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeSkills, BootstrapSkillReconciler } from './reconciler.js';
import type { BootstrapSkillEntry } from './reconciler.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { registerBootstrapSkill } from '../skills/orchestrator/bootstrap-skill-registry.js';
import type { KnownManifest } from '../runtime/skill-format.js';

const KNOWN_MANIFESTS: KnownManifest[] = [
  { channelType: 'telegram', manifestVersion: '1.0.0' },
  { channelType: 'discord', manifestVersion: '2.0.0' },
];

function makeMarkdown(
  overrides: {
    name?: string;
    channelType?: string;
    manifestVersion?: string;
  } = {},
): string {
  const name = overrides.name ?? 'bootstrap-telegram';
  const channelType = overrides.channelType ?? 'telegram';
  const manifestVersion = overrides.manifestVersion ?? '1.0.0';
  return [
    '---',
    `name: ${name}`,
    `description: Bootstrap ${channelType}`,
    `created: 2026-06-06`,
    `source: manual`,
    `bootstrap:`,
    `  channelType: ${channelType}`,
    `  manifestVersion: ${manifestVersion}`,
    `  expectedQuestions:`,
    `    - "What is your bot token?"`,
    '---',
    '',
    'Skill body.',
  ].join('\n');
}

// Helper to build a baseline entry
function makeBaseline(
  name: string,
  channelType = 'telegram',
): BootstrapSkillEntry {
  return {
    name,
    channel_type: channelType,
    manifest_version: '1.0.0',
    content_hash: 'aaa000',
    source: 'helm-baseline',
    registered_at: '2026-01-01T00:00:00.000Z',
    registered_by: 'helm',
    markdown: makeMarkdown({ name, channelType }),
  };
}

describe('mergeSkills', () => {
  it('admin override wins on name collision (AC1)', () => {
    const baseline = [makeBaseline('bootstrap-telegram', 'telegram')];
    const overrides: BootstrapSkillEntry[] = [
      {
        name: 'bootstrap-telegram',
        channel_type: 'telegram',
        manifest_version: '2.0.0',
        content_hash: 'hash-admin',
        source: 'admin-registered',
        registered_at: '2026-06-01T00:00:00.000Z',
        registered_by: 'admin',
      },
    ];
    const merged = mergeSkills(baseline, overrides);
    expect(merged).toHaveLength(1);
    expect(merged[0].content_hash).toBe('hash-admin');
    expect(merged[0].source).toBe('admin-registered');
  });

  it('keeps baseline-only and override-only entries (AC1)', () => {
    const baseline = [
      makeBaseline('bootstrap-telegram'),
      makeBaseline('bootstrap-discord', 'discord'),
    ];
    const overrides: BootstrapSkillEntry[] = [
      {
        name: 'bootstrap-slack',
        channel_type: 'slack',
        manifest_version: '1.0.0',
        content_hash: 'hash-slack',
        source: 'admin-registered',
        registered_at: '2026-06-01T00:00:00.000Z',
        registered_by: 'admin',
      },
    ];
    const merged = mergeSkills(baseline, overrides);
    expect(merged.map((e) => e.name).sort()).toEqual([
      'bootstrap-discord',
      'bootstrap-slack',
      'bootstrap-telegram',
    ]);
  });

  it('returns empty when both inputs are empty', () => {
    expect(mergeSkills([], [])).toEqual([]);
  });

  it('returns sorted output by name (AC1)', () => {
    const merged = mergeSkills(
      [
        makeBaseline('bootstrap-telegram'),
        makeBaseline('bootstrap-discord', 'discord'),
      ],
      [],
    );
    expect(merged.map((e) => e.name)).toEqual([
      'bootstrap-discord',
      'bootstrap-telegram',
    ]);
  });
});

describe('BootstrapSkillReconciler.apply', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('calls configMapApply with merged entries JSON', async () => {
    registerBootstrapSkill(
      {
        name: 'bootstrap-telegram',
        markdown: makeMarkdown({ name: 'bootstrap-telegram' }),
      },
      KNOWN_MANIFESTS,
    );
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new BootstrapSkillReconciler({
      baselineLoader: () => [makeBaseline('bootstrap-discord', 'discord')],
      configMapApply: apply,
    });
    await r.apply();
    expect(apply).toHaveBeenCalledOnce();
    const arg: string = apply.mock.calls[0][0];
    const parsed = JSON.parse(arg) as { skills: Array<{ name: string }> };
    const names = parsed.skills.map((e) => e.name).sort();
    expect(names).toEqual(['bootstrap-discord', 'bootstrap-telegram']);
  });

  it('admin override wins on collision in reconcile output (AC1)', async () => {
    const adminMarkdown = makeMarkdown({
      name: 'bootstrap-telegram',
      manifestVersion: '1.0.0',
    });
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown: adminMarkdown },
      KNOWN_MANIFESTS,
    );
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new BootstrapSkillReconciler({
      baselineLoader: () => [
        { ...makeBaseline('bootstrap-telegram'), content_hash: 'helm-hash' },
      ],
      configMapApply: apply,
    });
    await r.apply();
    const parsed = JSON.parse(apply.mock.calls[0][0]) as {
      skills: Array<{ name: string; source: string; content_hash: string }>;
    };
    const telegram = parsed.skills.find((e) => e.name === 'bootstrap-telegram');
    expect(telegram?.source).toBe('admin-registered');
    expect(telegram?.content_hash).not.toBe('helm-hash');
  });

  it('increments generation on each successful apply', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const r = new BootstrapSkillReconciler({
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
    const r = new BootstrapSkillReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });
    await expect(r.apply()).rejects.toThrow('k8s error');
    await r.apply();
    // second call should have generation=1 (not 2) because first failed
    const gen = JSON.parse(apply.mock.calls[1][0]).generation;
    expect(gen).toBe(1);
  });

  it('serializes concurrent apply calls', async () => {
    const resolveFns: Array<() => void> = [];
    const apply = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => resolveFns.push(resolve)),
      );
    const r = new BootstrapSkillReconciler({
      baselineLoader: () => [],
      configMapApply: apply,
    });

    registerBootstrapSkill(
      {
        name: 'bootstrap-telegram',
        markdown: makeMarkdown({ name: 'bootstrap-telegram' }),
      },
      KNOWN_MANIFESTS,
    );
    const p1 = r.apply();
    await Promise.resolve();

    const discordMarkdown = makeMarkdown({
      name: 'bootstrap-discord',
      channelType: 'discord',
      manifestVersion: '2.0.0',
    });
    registerBootstrapSkill(
      { name: 'bootstrap-discord', markdown: discordMarkdown },
      KNOWN_MANIFESTS,
    );
    const p2 = r.apply();

    resolveFns[0]!();
    await p1;
    resolveFns[1]!();
    await p2;

    const secondPayload = JSON.parse(apply.mock.calls[1][0]) as {
      skills: Array<{ name: string }>;
    };
    const names = secondPayload.skills.map((e) => e.name).sort();
    expect(names).toEqual(['bootstrap-discord', 'bootstrap-telegram']);
  });
});
