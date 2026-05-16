import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  readSkill,
  writeCandidate,
  acceptCandidate,
  rejectCandidate,
  disableSkill,
  enableSkill,
  pruneSkill,
} from './skill-store.js';
import { SkillFile } from './skill-format.js';

function mkSkill(overrides: Partial<SkillFile['frontmatter']> = {}): SkillFile {
  return {
    frontmatter: {
      name: 'demo',
      description: 'demo skill',
      created: '2026-05-16',
      source: 'manual',
      ...overrides,
    },
    body: 'Use the demo pattern.\n',
  };
}

let groupsRoot: string;
const GROUP = 'g1';

beforeEach(() => {
  groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-store-'));
  fs.mkdirSync(path.join(groupsRoot, GROUP), { recursive: true });
});

describe('skill-store', () => {
  it('returns empty arrays for fresh group', () => {
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listCandidates(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
  });

  it('writes and lists a candidate', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'foo' }));
    const cands = listCandidates(groupsRoot, GROUP);
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(id);
    expect(cands[0].skill.frontmatter.name).toBe('foo');
  });

  it('acceptCandidate moves to accepted', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'foo' }));
    acceptCandidate(groupsRoot, GROUP, id);
    expect(listCandidates(groupsRoot, GROUP)).toHaveLength(0);
    const accepted = listAcceptedSkills(groupsRoot, GROUP);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].frontmatter.name).toBe('foo');
  });

  it('acceptCandidate refuses if accepted name already exists', () => {
    writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    const id2 = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    const firstId = listCandidates(groupsRoot, GROUP)[0].id;
    acceptCandidate(groupsRoot, GROUP, firstId);
    expect(() => acceptCandidate(groupsRoot, GROUP, id2)).toThrow(/already exists/);
  });

  it('rejectCandidate deletes the candidate file', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill());
    rejectCandidate(groupsRoot, GROUP, id);
    expect(listCandidates(groupsRoot, GROUP)).toEqual([]);
  });

  it('disableSkill moves to _archive', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    disableSkill(groupsRoot, GROUP, 'x');
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP).map((s) => s.frontmatter.name)).toEqual(['x']);
  });

  it('enableSkill moves back from _archive', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    disableSkill(groupsRoot, GROUP, 'x');
    enableSkill(groupsRoot, GROUP, 'x');
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
    expect(listAcceptedSkills(groupsRoot, GROUP).map((s) => s.frontmatter.name)).toEqual(['x']);
  });

  it('pruneSkill deletes accepted skill outright', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'x' }));
    acceptCandidate(groupsRoot, GROUP, id);
    pruneSkill(groupsRoot, GROUP, 'x');
    expect(listAcceptedSkills(groupsRoot, GROUP)).toEqual([]);
    expect(listArchived(groupsRoot, GROUP)).toEqual([]);
  });

  it('readSkill returns null for unknown skill', () => {
    expect(readSkill(groupsRoot, GROUP, 'nonexistent')).toBeNull();
  });

  it('writeCandidate sanitizes filename from slug', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'my-skill' }));
    const candFile = path.join(groupsRoot, GROUP, 'skills', '_candidates', `${id}.md`);
    expect(fs.existsSync(candFile)).toBe(true);
  });

  it('writeCandidate rejects invalid slug', () => {
    expect(() => writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'Bad Name' }))).toThrow(/slug/);
  });

  it('rejectCandidate throws on missing id', () => {
    expect(() => rejectCandidate(groupsRoot, GROUP, 'nope')).toThrow(/not found/);
  });

  it('acceptCandidate with target archives existing skill and writes candidate at target slug', () => {
    // Create and accept an initial skill named 'foo'
    const id1 = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'foo' }));
    acceptCandidate(groupsRoot, GROUP, id1);
    expect(listAcceptedSkills(groupsRoot, GROUP)).toHaveLength(1);
    expect(listAcceptedSkills(groupsRoot, GROUP)[0].frontmatter.name).toBe('foo');

    // Stage an edit candidate that targets 'foo' but has a different candidate name
    const id2 = writeCandidate(groupsRoot, GROUP, {
      frontmatter: {
        name: 'foo-edit-candidate',
        description: 'updated description',
        created: '2026-05-16',
        source: 'curator',
        target: 'foo',
      },
      body: 'NEW BODY\n',
    });
    acceptCandidate(groupsRoot, GROUP, id2);

    // After accepting, exactly one accepted skill exists at the target slug
    const accepted = listAcceptedSkills(groupsRoot, GROUP);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].frontmatter.name).toBe('foo');
    expect(accepted[0].frontmatter.target).toBeUndefined();
    expect(accepted[0].body).toContain('NEW BODY');

    // The superseded version is in the archive
    const archived = listArchived(groupsRoot, GROUP);
    expect(archived.length).toBeGreaterThanOrEqual(1);
  });

  it('acceptCandidate with target does not overwrite when no target field — still throws', () => {
    const id1 = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    acceptCandidate(groupsRoot, GROUP, id1);
    const id2 = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'dup' }));
    expect(() => acceptCandidate(groupsRoot, GROUP, id2)).toThrow(/already exists/);
  });

  it('listCandidates ignores underscore- and dot-prefixed files', () => {
    const id = writeCandidate(groupsRoot, GROUP, mkSkill({ name: 'real' }));
    const dir = path.join(groupsRoot, GROUP, 'skills', '_candidates');
    fs.writeFileSync(path.join(dir, '_hidden.md'), 'noise');
    fs.writeFileSync(path.join(dir, '.dotfile.md'), 'noise');
    const cands = listCandidates(groupsRoot, GROUP);
    expect(cands.map((c) => c.id)).toEqual([id]);
  });
});
