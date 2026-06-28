import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _initTestDatabase,
  getSkillLoadStats,
  recordSkillLoad,
} from '../db.js';
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

  /**
   * Gap 2 — cap-20 ranking under volume.
   *
   * Create 30 accepted skills, pre-seed load stats so the first 20 have
   * distinct, strictly-increasing last_loaded timestamps and the last 10 have
   * no load history.  Assert that loadSkills selects exactly SKILL_CAP (20)
   * skills, that those 20 are the ones with the highest last_loaded values,
   * and that each selected skill has a new load event recorded.
   */
  it('selects exactly SKILL_CAP most-recently-loaded skills when > SKILL_CAP exist', async () => {
    const TOTAL = 30; // 30 > SKILL_CAP (20)
    const names: string[] = [];

    // Accept 30 skills
    for (let i = 0; i < TOTAL; i++) {
      const name = `vol-skill-${String(i).padStart(2, '0')}`;
      names.push(name);
      const id = writeCandidate(root, GROUP, mkSkill(name));
      acceptCandidate(root, GROUP, id);
    }

    // Pre-seed load stats: give the first 20 skills load timestamps
    // with strictly increasing values so ranking is unambiguous.
    // Skills vol-skill-00..vol-skill-19 get timestamps 1000,2000,...,20000.
    const BASE_TS = 1_000_000_000_000; // well in the past, distinct from Date.now()
    const topSkills = names.slice(0, SKILL_CAP); // 20 skills with history
    const bottomSkills = names.slice(SKILL_CAP); // 10 skills with no history

    for (let i = 0; i < topSkills.length; i++) {
      // Ascending timestamps: vol-skill-19 has the highest last_loaded
      recordSkillLoad(GROUP, topSkills[i], BASE_TS + (i + 1) * 1000);
    }

    const res = loadSkills(root, GROUP);

    // Must select exactly SKILL_CAP skills
    expect(res.loadedSkills).toHaveLength(SKILL_CAP);

    // All 10 skills with no load history must be excluded
    for (const name of bottomSkills) {
      expect(res.loadedSkills).not.toContain(name);
    }

    // All 20 pre-seeded skills (the ones with history) must be selected
    for (const name of topSkills) {
      expect(res.loadedSkills).toContain(name);
    }

    // The prompt suffix must contain exactly SKILL_CAP skill bodies
    for (const name of topSkills) {
      expect(res.promptSuffix).toContain(`body of ${name}`);
    }
    for (const name of bottomSkills) {
      expect(res.promptSuffix).not.toContain(`body of ${name}`);
    }

    // loadSkills must record a NEW load event for each selected skill on top
    // of the single pre-seed, so load_count must be >= 2. (A bare has() check
    // would pass tautologically from the pre-seed alone.)
    const stats = getSkillLoadStats(GROUP);
    const statMap = new Map(stats.map((s) => [s.skill_name, s]));
    for (const name of topSkills) {
      expect(
        statMap.get(name)?.load_count ?? 0,
        `expected a fresh load event recorded for ${name}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('cap-20 selection is deterministic: same skills selected on repeated calls', async () => {
    const TOTAL = 25;
    const names: string[] = [];

    for (let i = 0; i < TOTAL; i++) {
      const name = `det-skill-${String(i).padStart(2, '0')}`;
      names.push(name);
      const id = writeCandidate(root, GROUP, mkSkill(name));
      acceptCandidate(root, GROUP, id);
    }

    // Give all skills load history so ranking is fully determined by timestamp
    const BASE_TS = 2_000_000_000_000;
    for (let i = 0; i < names.length; i++) {
      recordSkillLoad(GROUP, names[i], BASE_TS + i * 1000);
    }

    const first = loadSkills(root, GROUP);
    // Reset DB and reload the same load stats to check stability
    await _initTestDatabase();
    for (let i = 0; i < names.length; i++) {
      recordSkillLoad(GROUP, names[i], BASE_TS + i * 1000);
    }
    const second = loadSkills(root, GROUP);

    // Same set of skills selected both times (order may vary; use sets)
    expect(new Set(first.loadedSkills)).toEqual(new Set(second.loadedSkills));
    expect(first.loadedSkills).toHaveLength(SKILL_CAP);
  });
});
