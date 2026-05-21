/**
 * Skills History End-to-End Tests
 *
 * Exercises `/skills history` end-to-end using real filesystem and real
 * SQLite (in-memory via _initTestDatabase). No live Kubernetes cluster is
 * required.
 *
 * Namespace: kubeclaw-e2e-skills-history  Port: 14146
 *
 * Scenarios:
 *   1. `/skills history` returns a row per skill after skill loads recorded
 *   2. `/skills history` returns empty message when no loads in group
 *   3. `/skills history 5` returns at most 5 rows ordered by count desc
 *   4. `/skills history 0` defaults to 10 rows
 *   5. `/skills history abc` (non-numeric) defaults to 10 rows
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _initTestDatabase, __resetDbForTest, recordSkillLoad } from '../src/db.js';
import { handleSkillsCommand, resetReviewCursors } from '../src/runtime/skills-commands.js';

let tmpGroupsDir: string;
const GROUP = 'e2e-skills-history';
const JID = 'http:peter';

beforeEach(async () => {
  await _initTestDatabase();
  __resetDbForTest();
  resetReviewCursors();
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-history-e2e-'));
  fs.mkdirSync(path.join(tmpGroupsDir, GROUP), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(tmpGroupsDir)) {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  }
});

describe('/skills history e2e', () => {
  it('returns at least one row after a skill load is recorded', () => {
    recordSkillLoad(GROUP, 'my-skill', Date.now());
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history');
    expect(reply).toContain('my-skill');
    expect(reply).toMatch(/1x\s+my-skill/);
  });

  it('returns "No skill load history" when no loads recorded for group', () => {
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history');
    expect(reply).toBe('No skill load history for this group.');
  });

  it('aggregates counts correctly — 3 loads shows 3x', () => {
    const now = Date.now();
    recordSkillLoad(GROUP, 'heavy-skill', now);
    recordSkillLoad(GROUP, 'heavy-skill', now + 1);
    recordSkillLoad(GROUP, 'heavy-skill', now + 2);
    recordSkillLoad(GROUP, 'light-skill', now + 3);
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history');
    expect(reply).toMatch(/3x\s+heavy-skill/);
    expect(reply).toMatch(/1x\s+light-skill/);
    // heavy-skill appears before light-skill (count desc)
    expect(reply.indexOf('heavy-skill')).toBeLessThan(reply.indexOf('light-skill'));
  });

  it('/skills history 5 returns at most 5 rows', () => {
    const now = Date.now();
    for (let i = 1; i <= 8; i++) {
      recordSkillLoad(GROUP, `skill-${i}`, now + i);
    }
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history 5');
    const rows = reply.split('\n').filter((l) => /\d+x\s+/.test(l));
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('/skills history 0 defaults to 10 rows', () => {
    const now = Date.now();
    for (let i = 1; i <= 15; i++) {
      recordSkillLoad(GROUP, `skill-${i}`, now + i);
    }
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history 0');
    const rows = reply.split('\n').filter((l) => /\d+x\s+/.test(l));
    expect(rows.length).toBe(10);
  });

  it('/skills history abc (non-numeric) defaults to 10 rows', () => {
    const now = Date.now();
    for (let i = 1; i <= 15; i++) {
      recordSkillLoad(GROUP, `skill-${i}`, now + i);
    }
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history abc');
    const rows = reply.split('\n').filter((l) => /\d+x\s+/.test(l));
    expect(rows.length).toBe(10);
  });

  it('is group-scoped — loads from another group do not appear', () => {
    recordSkillLoad('other-group', 'foreign-skill', Date.now());
    const reply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills history');
    expect(reply).toBe('No skill load history for this group.');
  });
});
