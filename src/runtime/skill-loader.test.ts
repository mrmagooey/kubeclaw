import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _initTestDatabase, getSkillLoadStats } from '../db.js';
import { writeCandidate, acceptCandidate } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import { loadSkills, SKILL_CAP } from './skill-loader.js';

function mkSkill(name: string, description = `desc-${name}`): SkillFile {
  return {
    frontmatter: { name, description, created: '2026-05-16', source: 'manual' },
    body: `body of ${name}\n`,
  };
}

function acceptN(root: string, group: string, n: number, prefix = 'sk'): void {
  for (let i = 0; i < n; i++) {
    const id = writeCandidate(root, group, mkSkill(`${prefix}-${i}`));
    acceptCandidate(root, group, id);
  }
}

let root: string;
const GROUP = 'g1';

beforeEach(async () => {
  await _initTestDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

describe('loadSkills', () => {
  it('returns empty suffix and no telemetry when no skills', () => {
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toBe('');
    expect(res.loadedSkills).toEqual([]);
    expect(getSkillLoadStats(GROUP)).toEqual([]);
  });

  it('concatenates skill bodies under a Learned skills header', () => {
    const id = writeCandidate(root, GROUP, mkSkill('alpha'));
    acceptCandidate(root, GROUP, id);
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toContain('## Learned skills');
    expect(res.promptSuffix).toContain('body of alpha');
    expect(res.loadedSkills).toEqual(['alpha']);
  });

  it('separates multiple skill bodies with horizontal rules', () => {
    acceptN(root, GROUP, 3);
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix.match(/---/g)?.length).toBeGreaterThanOrEqual(2);
    expect(res.loadedSkills).toHaveLength(3);
  });

  it('records a telemetry row per loaded skill', () => {
    acceptN(root, GROUP, 2);
    loadSkills(root, GROUP);
    const stats = getSkillLoadStats(GROUP);
    expect(stats.map((s) => s.skill_name).sort()).toEqual(['sk-0', 'sk-1']);
    expect(stats.every((s) => s.load_count === 1)).toBe(true);
  });

  it('caps at SKILL_CAP, preferring most recently loaded skills', () => {
    acceptN(root, GROUP, SKILL_CAP + 2);
    const first = loadSkills(root, GROUP);
    expect(first.loadedSkills).toHaveLength(SKILL_CAP);
    const second = loadSkills(root, GROUP);
    expect(second.loadedSkills).toHaveLength(SKILL_CAP);
  });

  it('ignores _candidates and _archive directories', () => {
    writeCandidate(root, GROUP, mkSkill('not-yet'));
    const res = loadSkills(root, GROUP);
    expect(res.promptSuffix).toBe('');
    expect(res.loadedSkills).toEqual([]);
  });
});
