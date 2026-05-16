import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleSkillsCommand,
  resetReviewCursors,
} from './skills-commands.js';
import { writeCandidate, acceptCandidate } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import { _initTestDatabase } from '../db.js';

function mkSkill(name: string): SkillFile {
  return {
    frontmatter: { name, description: `d-${name}`, created: '2026-05-16', source: 'manual' },
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
    expect(handleSkillsCommand(root, GROUP, JID, '/skills disable alpha')).toMatch(/disabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).not.toContain('alpha');
    expect(handleSkillsCommand(root, GROUP, JID, '/skills enable alpha')).toMatch(/enabled/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).toContain('alpha');
  });

  it('unknown verb', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills frobnicate');
    expect(reply).toMatch(/unknown/i);
  });

  it('plain /skills shows help', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills');
    expect(reply).toMatch(/list|review|show|accept|reject|disable|enable|prune/);
  });

  it('prune-confirm — usage when no arg', () => {
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune-confirm');
    expect(reply).toMatch(/usage/i);
  });

  it('prune-confirm — deletes the skill', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const reply = handleSkillsCommand(root, GROUP, JID, '/skills prune-confirm alpha');
    expect(reply).toMatch(/pruned/i);
    expect(handleSkillsCommand(root, GROUP, JID, '/skills list')).toMatch(/no skills/i);
  });
});
