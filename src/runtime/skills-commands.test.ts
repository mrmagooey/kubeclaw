import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleSkillsCommand,
  resetReviewCursors,
  MAX_SKILLS_HISTORY_LIMIT,
} from './skills-commands.js';
import { writeCandidate, acceptCandidate } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import { _initTestDatabase, recordSkillLoad } from '../db.js';

function mkSkill(name: string): SkillFile {
  return {
    frontmatter: {
      name,
      description: `d-${name}`,
      created: '2026-05-16',
      source: 'manual',
    },
    body: `body-${name}\n`,
  };
}

let root: string;
const GROUP = 'g1';
const JID = 'user@channel';

beforeEach(async () => {
  await _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-cmd-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
  resetReviewCursors();
});

describe('handleSkillsCommand', () => {
  it('list — empty state', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills list');
    expect(reply).toMatch(/no skills/i);
  });

  it('list — shows accepted skills', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills list');
    expect(reply).toContain('alpha');
  });

  it('show — prints skill body', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills show alpha');
    expect(reply).toContain('body-alpha');
  });

  it('show — unknown skill', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills show nope');
    expect(reply).toMatch(/not found/i);
  });

  it('review — empty queue', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(reply).toMatch(/no candidates/i);
  });

  it('review — walks candidates and accept advances cursor', () => {
    const id1 = writeCandidate(root, GROUP, mkSkill('a'));
    const id2 = writeCandidate(root, GROUP, mkSkill('b'));
    const first = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(first).toContain(id1);
    const acc = handleSkillsCommand(root, GROUP, JID, `/skills accept ${id1}`);
    expect(acc).toMatch(/accepted/i);
    const next = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(next).toContain(id2);
  });

  it('reject — removes candidate', () => {
    const id = writeCandidate(root, GROUP, mkSkill('x'));
    const reply = handleSkillsCommand(root, GROUP, JID, `/skills reject ${id}`);
    expect(reply).toMatch(/rejected/i);
    const after = handleSkillsCommand(root, GROUP, JID, '/skills review');
    expect(after).toMatch(/no candidates/i);
  });

  it('disable + enable round-trip', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    expect(
      handleSkillsCommand(root, GROUP, JID, '/skills disable alpha'),
    ).toMatch(/disabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).not.toContain(
      'alpha',
    );
    expect(
      handleSkillsCommand(root, GROUP, JID, '/skills enable alpha'),
    ).toMatch(/enabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).toContain(
      'alpha',
    );
  });

  it('unknown verb', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills frobnicate');
    expect(reply).toMatch(/unknown/i);
  });

  it('plain /skills shows help', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills');
    expect(reply).toMatch(
      /list|review|show|accept|reject|disable|enable|prune/,
    );
  });

  it('prune-confirm — usage when no arg', () => {
    const reply = handleSkillsCommand(
      root,
      GROUP,
      JID,
      '/skills prune-confirm',
    );
    expect(reply).toMatch(/usage/i);
  });

  it('prune-confirm — deletes the skill', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(
      root,
      GROUP,
      JID,
      '/skills prune-confirm alpha',
    );
    expect(reply).toMatch(/pruned/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).toMatch(
      /no skills/i,
    );
  });

  describe('/skills history', () => {
    it('returns empty message when no skill loads recorded', () => {
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history');
      expect(reply).toBe('No skill load history for this group.');
    });

    it('returns rows with count and name for 2 skills', () => {
      recordSkillLoad(GROUP, 'skill-alpha', 1000);
      recordSkillLoad(GROUP, 'skill-alpha', 2000);
      recordSkillLoad(GROUP, 'skill-beta', 3000);
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history');
      expect(reply).toContain('skill-alpha');
      expect(reply).toContain('skill-beta');
      expect(reply).toMatch(/2x\s+skill-alpha/);
      expect(reply).toMatch(/1x\s+skill-beta/);
    });

    it('orders by count descending', () => {
      recordSkillLoad(GROUP, 'low', 1000);
      recordSkillLoad(GROUP, 'high', 2000);
      recordSkillLoad(GROUP, 'high', 3000);
      recordSkillLoad(GROUP, 'high', 4000);
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history');
      const highIdx = reply.indexOf('high');
      const lowIdx = reply.indexOf('low');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('respects limit argument', () => {
      for (let i = 1; i <= 5; i++) {
        recordSkillLoad(GROUP, `skill-${i}`, i * 1000);
      }
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history 3');
      const lines = reply.split('\n').filter((l) => l.match(/\d+x\s+/));
      expect(lines.length).toBe(3);
    });

    it('defaults to 10 rows for limit 0', () => {
      for (let i = 1; i <= 12; i++) {
        recordSkillLoad(GROUP, `skill-${i}`, i * 1000);
      }
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history 0');
      const lines = reply.split('\n').filter((l) => l.match(/\d+x\s+/));
      expect(lines.length).toBe(10);
    });

    it('defaults to 10 rows for non-numeric limit', () => {
      for (let i = 1; i <= 12; i++) {
        recordSkillLoad(GROUP, `skill-${i}`, i * 1000);
      }
      const reply = handleSkillsCommand(
        root,
        GROUP,
        JID,
        '/skills history abc',
      );
      const lines = reply.split('\n').filter((l) => l.match(/\d+x\s+/));
      expect(lines.length).toBe(10);
    });

    it('caps at MAX_SKILLS_HISTORY_LIMIT even if larger limit provided', () => {
      expect(MAX_SKILLS_HISTORY_LIMIT).toBe(100);
      for (let i = 1; i <= 110; i++) {
        recordSkillLoad(GROUP, `skill-${i}`, i * 1000);
      }
      const reply = handleSkillsCommand(
        root,
        GROUP,
        JID,
        `/skills history 200`,
      );
      const lines = reply.split('\n').filter((l) => l.match(/\d+x\s+/));
      expect(lines.length).toBe(MAX_SKILLS_HISTORY_LIMIT);
    });

    it('is group-scoped — other group loads do not appear', () => {
      recordSkillLoad('other-group', 'foreign-skill', 1000);
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills history');
      expect(reply).toBe('No skill load history for this group.');
    });

    it('HELP text includes /skills history', () => {
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills help');
      expect(reply).toContain('/skills history');
    });
  });

  describe('/skills prune', () => {
    it('reports no stale skills when all were loaded recently', () => {
      const id = writeCandidate(root, GROUP, mkSkill('fresh'));
      acceptCandidate(root, GROUP, id);
      // Record a load within the last 60 days
      recordSkillLoad(GROUP, 'fresh', Date.now());
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune');
      expect(reply).toMatch(/no stale skills/i);
    });

    it('lists stale skills when a skill has never been loaded', () => {
      const id = writeCandidate(root, GROUP, mkSkill('stale-one'));
      acceptCandidate(root, GROUP, id);
      // No recordSkillLoad call — skill has never been loaded
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune');
      expect(reply).toContain('stale-one');
      expect(reply).toMatch(/prune-confirm/i);
    });

    it('lists only unloaded skills when some are fresh and some are stale', () => {
      const id1 = writeCandidate(root, GROUP, mkSkill('loaded-skill'));
      acceptCandidate(root, GROUP, id1);
      recordSkillLoad(GROUP, 'loaded-skill', Date.now());

      const id2 = writeCandidate(root, GROUP, mkSkill('stale-skill'));
      acceptCandidate(root, GROUP, id2);
      // stale-skill never loaded

      const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune');
      expect(reply).toContain('stale-skill');
      expect(reply).not.toContain('loaded-skill');
    });

    it('reports no stale skills when there are no accepted skills at all', () => {
      const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune');
      expect(reply).toMatch(/no stale skills/i);
    });
  });
});
