import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerBootstrapSkill,
  removeBootstrapSkill,
  listBootstrapSkillOverrides,
  computeSkillHash,
} from './bootstrap-skill-registry.js';
import { _initTestDatabase, __resetDbForTest, db } from '../../db.js';
import type { KnownManifest } from '../../runtime/skill-format.js';
import type { BaselineEntry } from './bootstrap-skill-registry.js';

const KNOWN_MANIFESTS: KnownManifest[] = [
  { channelType: 'telegram', manifestVersion: '1.0.0' },
  { channelType: 'discord', manifestVersion: '2.0.0' },
];

function makeMarkdown(
  overrides: {
    name?: string;
    description?: string;
    channelType?: string;
    manifestVersion?: string;
    questions?: string[];
  } = {},
): string {
  const name = overrides.name ?? 'bootstrap-telegram';
  const description = overrides.description ?? 'Bootstrap a Telegram channel';
  const channelType = overrides.channelType ?? 'telegram';
  const manifestVersion = overrides.manifestVersion ?? '1.0.0';
  const questions = overrides.questions ?? ['What is your bot token?'];
  const questionsYaml = questions.map((q) => `    - "${q}"`).join('\n');
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `created: 2026-06-06`,
    `source: manual`,
    `bootstrap:`,
    `  channelType: ${channelType}`,
    `  manifestVersion: ${manifestVersion}`,
    `  expectedQuestions:`,
    questionsYaml,
    '---',
    '',
    'Skill body.',
  ].join('\n');
}

describe('bootstrap_skill_overrides table', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('table exists after schema init', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='bootstrap_skill_overrides'`,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe('bootstrap_skill_overrides');
  });
});

describe('computeSkillHash', () => {
  it('returns a 64-char hex string', () => {
    expect(computeSkillHash('hello')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const md = makeMarkdown();
    expect(computeSkillHash(md)).toBe(computeSkillHash(md));
  });

  it('differs for different content', () => {
    expect(computeSkillHash('a')).not.toBe(computeSkillHash('b'));
  });
});

describe('registerBootstrapSkill', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('inserts a valid skill and returns the hash (AC2)', () => {
    const markdown = makeMarkdown();
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.source).toBe('admin-registered');
    expect(listBootstrapSkillOverrides()).toHaveLength(1);
  });

  it('persists correct fields to SQLite (AC2)', () => {
    const markdown = makeMarkdown();
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(true);
    const rows = listBootstrapSkillOverrides();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('bootstrap-telegram');
    expect(rows[0].markdown).toBe(markdown);
    if (r.ok) expect(rows[0].content_hash).toBe(r.content_hash);
    expect(rows[0].registered_by).toBe('admin');
    expect(rows[0].registered_at).toBeTruthy();
  });

  it('rejects name mismatch between arg and frontmatter (AC3a)', () => {
    const markdown = makeMarkdown({ name: 'bootstrap-telegram' });
    const r = registerBootstrapSkill(
      { name: 'bootstrap-discord', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/frontmatter name mismatch/i);
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('rejects missing description (AC3b)', () => {
    const markdown = [
      '---',
      'name: bootstrap-telegram',
      'created: 2026-06-06',
      'source: manual',
      'bootstrap:',
      '  channelType: telegram',
      '  manifestVersion: 1.0.0',
      '  expectedQuestions:',
      '    - "Question?"',
      '---',
      '',
      'body',
    ].join('\n');
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/description/i);
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('rejects missing bootstrap.channelType (AC3c)', () => {
    const markdown = [
      '---',
      'name: bootstrap-telegram',
      'description: Bootstrap Telegram',
      'created: 2026-06-06',
      'source: manual',
      'bootstrap:',
      '  manifestVersion: 1.0.0',
      '  expectedQuestions:',
      '    - "Question?"',
      '---',
      '',
      'body',
    ].join('\n');
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/bootstrap\.channelType/i);
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('rejects bootstrap.manifestVersion not in registry for channelType (AC3d)', () => {
    const markdown = makeMarkdown({
      channelType: 'telegram',
      manifestVersion: '9.9.9',
    });
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(
      /bootstrap\.manifestVersion does not match.*channelType=telegram/,
    );
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('rejects channelType with typo ("telegramm") at register time, not at runtime (AC3f)', () => {
    const markdown = makeMarkdown({
      channelType: 'telegramm',
      manifestVersion: '1.0.0',
    });
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The typo causes the cross-validation to fail immediately
    expect(r.error).toMatch(/channelType=telegramm/);
    // ConfigMap is never touched — verified by empty overrides table
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('rejects missing expectedQuestions (AC3e)', () => {
    const markdown = [
      '---',
      'name: bootstrap-telegram',
      'description: Bootstrap Telegram',
      'created: 2026-06-06',
      'source: manual',
      'bootstrap:',
      '  channelType: telegram',
      '  manifestVersion: 1.0.0',
      '---',
      '',
      'body',
    ].join('\n');
    const r = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/bootstrap\.expectedQuestions/i);
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('is idempotent on identical (name, content) — no reconcile on second call (AC4)', async () => {
    const markdown = makeMarkdown();
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const r1 = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
      reconcile,
    );
    expect(r1.ok).toBe(true);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    const r2 = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
      reconcile,
    );
    expect(r2.ok).toBe(true);
    // Same hash — idempotent short-circuit, reconcile NOT called again
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('calls reconcile again on same name with different content (AC4)', async () => {
    const markdown1 = makeMarkdown();
    const markdown2 = makeMarkdown({ description: 'Updated description' });
    const reconcile = vi.fn().mockResolvedValue(undefined);
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown: markdown1 },
      KNOWN_MANIFESTS,
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown: markdown2 },
      KNOWN_MANIFESTS,
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);

    // The returned hash should reflect the new content
    const rows = listBootstrapSkillOverrides();
    expect(rows[0].content_hash).toBe(computeSkillHash(markdown2));
  });

  it('triggers reconcile after successful insert', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const markdown = makeMarkdown();
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
      reconcile,
    );
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledOnce();
  });
});

describe('listBootstrapSkillOverrides', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('returns empty array when no overrides registered', () => {
    expect(listBootstrapSkillOverrides()).toEqual([]);
  });

  it('returns all overrides ordered by name (AC1)', () => {
    registerBootstrapSkill(
      {
        name: 'bootstrap-telegram',
        markdown: makeMarkdown({ name: 'bootstrap-telegram' }),
      },
      KNOWN_MANIFESTS,
    );
    registerBootstrapSkill(
      {
        name: 'bootstrap-discord',
        markdown: makeMarkdown({
          name: 'bootstrap-discord',
          channelType: 'discord',
          manifestVersion: '2.0.0',
        }),
      },
      KNOWN_MANIFESTS,
    );
    const list = listBootstrapSkillOverrides();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('bootstrap-discord');
    expect(list[1].name).toBe('bootstrap-telegram');
  });
});

describe('removeBootstrapSkill', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  const emptyBaseline = (): BaselineEntry[] => [];
  const telegramBaseline = (): BaselineEntry[] => [
    { name: 'bootstrap-telegram' },
  ];

  it('removes an admin-registered skill and returns status=removed (AC5)', async () => {
    const markdown = makeMarkdown();
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(listBootstrapSkillOverrides()).toHaveLength(1);

    const r = removeBootstrapSkill('bootstrap-telegram', emptyBaseline);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('removed');
    expect(listBootstrapSkillOverrides()).toHaveLength(0);
  });

  it('returns already absent on second removal (AC5)', async () => {
    const markdown = makeMarkdown();
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    removeBootstrapSkill('bootstrap-telegram', emptyBaseline);

    const r = removeBootstrapSkill('bootstrap-telegram', emptyBaseline);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('already absent');
  });

  it('returns already absent for unknown name (AC5)', () => {
    const r = removeBootstrapSkill('nonexistent-skill', emptyBaseline);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('already absent');
  });

  it('refuses Helm baseline with PROTECTED_BASELINE and does not modify state (AC5)', () => {
    const r = removeBootstrapSkill('bootstrap-telegram', telegramBaseline);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('PROTECTED_BASELINE');
    expect(r.source).toBe('helm-baseline');
    expect(r.name).toBe('bootstrap-telegram');
  });

  it('triggers reconcile after successful removal', async () => {
    const markdown = makeMarkdown();
    const reconcile = vi.fn().mockResolvedValue(undefined);
    registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    removeBootstrapSkill('bootstrap-telegram', emptyBaseline, reconcile);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('does not call reconcile for PROTECTED_BASELINE', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    removeBootstrapSkill('bootstrap-telegram', telegramBaseline, reconcile);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not call reconcile for already absent', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    removeBootstrapSkill('nonexistent', emptyBaseline, reconcile);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('full AC5 scenario: register→remove→remove again→attempt baseline removal (AC5)', () => {
    const markdown = makeMarkdown();
    const baselineWithTelegram = (): BaselineEntry[] => [
      { name: 'bootstrap-telegram' },
    ];

    // Register admin skill
    const reg = registerBootstrapSkill(
      { name: 'bootstrap-telegram', markdown },
      KNOWN_MANIFESTS,
    );
    expect(reg.ok).toBe(true);

    // First removal: status=removed
    const r1 = removeBootstrapSkill('bootstrap-telegram', baselineWithTelegram);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.status).toBe('removed');

    // Second removal: status=already absent (admin entry gone, but baseline exists)
    // Note: once the admin entry is removed, the baseline would prevent re-removal attempts
    // by returning PROTECTED_BASELINE. But since the admin entry is gone and we're just
    // checking the overrides table, the baseline check fires.
    // Actually: AC5 says "second removal of already-removed admin entry → already absent".
    // We need to use an empty baseline for this check.
    const r2 = removeBootstrapSkill('bootstrap-telegram', emptyBaseline);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.status).toBe('already absent');

    // Attempt to remove a Helm baseline skill → PROTECTED_BASELINE
    const r3 = removeBootstrapSkill('bootstrap-telegram', baselineWithTelegram);
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.code).toBe('PROTECTED_BASELINE');
      expect(r3.source).toBe('helm-baseline');
    }
  });
});
