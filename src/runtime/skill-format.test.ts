import { describe, it, expect } from 'vitest';
import {
  parseSkill,
  serializeSkill,
  validateSlug,
  parseBootstrapSkillFrontmatter,
  SkillFile,
  type KnownManifest,
} from './skill-format.js';

describe('skill-format', () => {
  describe('parseSkill', () => {
    it('parses frontmatter and body', () => {
      const raw =
        '---\nname: prefer-rg\ndescription: use ripgrep\ncreated: 2026-05-16\nsource: manual\n---\n\nWhen searching, use rg.\n';
      const parsed = parseSkill(raw);
      expect(parsed.frontmatter.name).toBe('prefer-rg');
      expect(parsed.frontmatter.description).toBe('use ripgrep');
      expect(parsed.frontmatter.created).toBe('2026-05-16');
      expect(parsed.frontmatter.source).toBe('manual');
      expect(parsed.body.trim()).toBe('When searching, use rg.');
    });

    it('rejects file with missing frontmatter', () => {
      expect(() => parseSkill('just a body, no frontmatter')).toThrow(
        /frontmatter/i,
      );
    });

    it('rejects frontmatter missing required field', () => {
      const raw = '---\nname: foo\n---\nbody\n';
      expect(() => parseSkill(raw)).toThrow(/description/);
    });

    it('preserves multi-paragraph body verbatim', () => {
      const body = 'Para 1.\n\nPara 2 with `code`.\n\n- bullet\n';
      const raw = `---\nname: x\ndescription: x\ncreated: 2026-05-16\nsource: manual\n---\n\n${body}`;
      expect(parseSkill(raw).body.trimEnd()).toBe(body.trimEnd());
    });

    it('parses file that ends without trailing newline', () => {
      const raw =
        '---\nname: foo\ndescription: bar\ncreated: 2026-05-16\nsource: manual\n---';
      const parsed = parseSkill(raw);
      expect(parsed.frontmatter.name).toBe('foo');
      expect(parsed.body).toBe('');
    });

    it('parses optional target field', () => {
      const raw =
        '---\nname: foo\ndescription: d\ncreated: 2026-05-16\nsource: manual\ntarget: original\n---\n\nbody\n';
      const parsed = parseSkill(raw);
      expect(parsed.frontmatter.target).toBe('original');
    });

    it('parses without target field (undefined)', () => {
      const raw =
        '---\nname: foo\ndescription: d\ncreated: 2026-05-16\nsource: manual\n---\n\nbody\n';
      const parsed = parseSkill(raw);
      expect(parsed.frontmatter.target).toBeUndefined();
    });
  });

  describe('serializeSkill', () => {
    it('round-trips through parseSkill', () => {
      const skill: SkillFile = {
        frontmatter: {
          name: 'prefer-rg',
          description: 'use ripgrep',
          created: '2026-05-16',
          source: 'manual',
        },
        body: 'When searching, use rg.\n',
      };
      const serialized = serializeSkill(skill);
      const reparsed = parseSkill(serialized);
      expect(reparsed.frontmatter).toEqual(skill.frontmatter);
      expect(reparsed.body.trim()).toBe(skill.body.trim());
    });

    it('round-trips with target field', () => {
      const skill: SkillFile = {
        frontmatter: {
          name: 'foo',
          description: 'd',
          created: '2026-05-16',
          source: 'manual',
          target: 'orig',
        },
        body: 'body\n',
      };
      const reparsed = parseSkill(serializeSkill(skill));
      expect(reparsed.frontmatter.target).toBe('orig');
    });

    it('omits target line when undefined', () => {
      const skill: SkillFile = {
        frontmatter: {
          name: 'foo',
          description: 'd',
          created: '2026-05-16',
          source: 'manual',
        },
        body: 'body\n',
      };
      expect(serializeSkill(skill)).not.toContain('target:');
    });
  });

  describe('validateSlug', () => {
    it('accepts kebab-case', () => {
      expect(validateSlug('prefer-rg-over-grep')).toBe(true);
    });
    it('rejects spaces, caps, dots, underscores', () => {
      expect(validateSlug('Prefer RG')).toBe(false);
      expect(validateSlug('prefer.rg')).toBe(false);
      expect(validateSlug('prefer_rg')).toBe(false);
      expect(validateSlug('')).toBe(false);
      expect(validateSlug('_starts-with-underscore')).toBe(false);
    });
  });
});

// ─── parseBootstrapSkillFrontmatter (Story 179) ───────────────────────────────

const KNOWN_MANIFESTS: KnownManifest[] = [
  { channelType: 'telegram', manifestVersion: '1.0.0' },
  { channelType: 'discord', manifestVersion: '2.0.0' },
];

function makeBootstrapMarkdown(
  overrides: {
    name?: string;
    description?: string;
    channelType?: string;
    manifestVersion?: string;
    expectedQuestions?: string[];
    body?: string;
  } = {},
): string {
  const name = overrides.name ?? 'bootstrap-telegram';
  const description = overrides.description ?? 'Bootstrap a Telegram channel';
  const channelType = overrides.channelType ?? 'telegram';
  const manifestVersion = overrides.manifestVersion ?? '1.0.0';
  const questions = overrides.expectedQuestions ?? ['What is your bot token?'];
  const questionsYaml = questions.map((q) => `      - "${q}"`).join('\n');
  const body = overrides.body ?? 'Skill body content here.';
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
    body,
  ].join('\n');
}

describe('parseBootstrapSkillFrontmatter', () => {
  it('parses valid bootstrap skill frontmatter', () => {
    const raw = makeBootstrapMarkdown();
    const result = parseBootstrapSkillFrontmatter(
      raw,
      KNOWN_MANIFESTS,
      'bootstrap-telegram',
    );
    expect(result.name).toBe('bootstrap-telegram');
    expect(result.description).toBe('Bootstrap a Telegram channel');
    expect(result.bootstrap.channelType).toBe('telegram');
    expect(result.bootstrap.manifestVersion).toBe('1.0.0');
    expect(result.bootstrap.expectedQuestions).toEqual([
      'What is your bot token?',
    ]);
  });

  it('rejects when name in frontmatter does not match expectedName arg (AC3a)', () => {
    const raw = makeBootstrapMarkdown({ name: 'bootstrap-telegram' });
    expect(() =>
      parseBootstrapSkillFrontmatter(raw, KNOWN_MANIFESTS, 'bootstrap-discord'),
    ).toThrow(
      /frontmatter name mismatch.*expected bootstrap-discord.*got bootstrap-telegram/i,
    );
  });

  it('rejects when description is missing (AC3b)', () => {
    // parseSkill will throw on missing description
    const raw = [
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
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(/description/i);
  });

  it('rejects when bootstrap.channelType is missing (AC3c)', () => {
    const raw = [
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
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(/frontmatter missing required field: bootstrap\.channelType/i);
  });

  it('rejects when bootstrap.manifestVersion not in knownManifests for channelType (AC3d)', () => {
    const raw = makeBootstrapMarkdown({
      channelType: 'telegram',
      manifestVersion: '9.9.9',
    });
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(
      /bootstrap\.manifestVersion does not match any registered manifest for channelType=telegram/,
    );
  });

  it('rejects skill with typo in channelType (e.g. "telegramm") (AC3f)', () => {
    const raw = makeBootstrapMarkdown({
      channelType: 'telegramm',
      manifestVersion: '1.0.0',
    });
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(
      /bootstrap\.manifestVersion does not match any registered manifest for channelType=telegramm/,
    );
  });

  it('rejects when bootstrap.expectedQuestions is missing (AC3e)', () => {
    const raw = [
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
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(
      /frontmatter missing required field: bootstrap\.expectedQuestions/i,
    );
  });

  it('rejects when bootstrap.expectedQuestions is empty array (AC3e)', () => {
    const raw = makeBootstrapMarkdown({ expectedQuestions: [] });
    expect(() =>
      parseBootstrapSkillFrontmatter(
        raw,
        KNOWN_MANIFESTS,
        'bootstrap-telegram',
      ),
    ).toThrow(
      /frontmatter missing required field: bootstrap\.expectedQuestions/i,
    );
  });

  it('accepts multiple expectedQuestions', () => {
    const raw = makeBootstrapMarkdown({
      expectedQuestions: ['Question 1?', 'Question 2?', 'Question 3?'],
    });
    const result = parseBootstrapSkillFrontmatter(
      raw,
      KNOWN_MANIFESTS,
      'bootstrap-telegram',
    );
    expect(result.bootstrap.expectedQuestions).toHaveLength(3);
  });

  it('works without expectedName arg (name not checked)', () => {
    const raw = makeBootstrapMarkdown({
      name: 'bootstrap-discord',
      channelType: 'discord',
      manifestVersion: '2.0.0',
    });
    const result = parseBootstrapSkillFrontmatter(raw, KNOWN_MANIFESTS);
    expect(result.name).toBe('bootstrap-discord');
  });
});
