import { describe, it, expect } from 'vitest';
import {
  parseSkill,
  serializeSkill,
  validateSlug,
  SkillFile,
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
