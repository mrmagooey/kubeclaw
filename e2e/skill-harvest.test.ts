/**
 * Skill Harvest End-to-End Tests
 *
 * Exercises the full skill-harvest pipeline end-to-end using real filesystem
 * and real SQLite (in-memory via _initTestDatabase). No live Kubernetes cluster
 * is required — only the LLM-facing functions are stubbed.
 *
 * Scenarios:
 *   1. Pre-existing skill file loads into system prompt
 *   2. Candidate -> /skills review -> /skills accept -> appears in prompt
 *   3. propose_skill stages candidate, accept moves it, prompt includes it
 *   4. Curator stages candidates from transcript, user accepts, skill appears
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { proposeSkill } from '../src/runtime/tools/propose-skill.js';
import { runCurator } from '../src/runtime/skill-curator.js';
import { writeCandidate } from '../src/runtime/skill-store.js';
import { handleSkillsCommand, resetReviewCursors } from '../src/runtime/skills-commands.js';
import { __testing__ as runnerTesting } from '../src/runtime/direct-llm-runner.js';

let tmpGroupsDir: string;
const GROUP = 'g1';
const JID = 'http:peter';

beforeEach(async () => {
  await _initTestDatabase();
  __resetDbForTest();
  resetReviewCursors();
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-harvest-e2e-'));
  fs.mkdirSync(path.join(tmpGroupsDir, GROUP), { recursive: true });
  fs.writeFileSync(path.join(tmpGroupsDir, GROUP, 'CLAUDE.md'), 'BASE PROMPT');
});

afterEach(() => {
  if (fs.existsSync(tmpGroupsDir)) {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  }
});

describe('skill harvest e2e', () => {
  it('loads pre-existing skill into system prompt', () => {
    fs.mkdirSync(path.join(tmpGroupsDir, GROUP, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpGroupsDir, GROUP, 'skills', 'foo.md'),
      '---\nname: foo\ndescription: foo desc\ncreated: 2026-05-16\nsource: manual\n---\n\nFOO BODY\n',
    );

    const prompt = runnerTesting.loadSystemPromptForTest(GROUP, tmpGroupsDir);

    expect(prompt).toContain('BASE PROMPT');
    expect(prompt).toContain('## Learned skills');
    expect(prompt).toContain('FOO BODY');
  });

  it('full lifecycle: candidate -> /skills review -> /skills accept -> appears in prompt', () => {
    // Stage a candidate directly via writeCandidate
    const id = writeCandidate(tmpGroupsDir, GROUP, {
      frontmatter: {
        name: 'new-skill',
        description: 'desc',
        created: '2026-05-16',
        source: 'manual',
      },
      body: 'NEW SKILL BODY\n',
    });

    // Review — should see candidate id
    const reviewReply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills review');
    expect(reviewReply).toContain(id);

    // Accept
    const acceptReply = handleSkillsCommand(
      tmpGroupsDir,
      GROUP,
      JID,
      `/skills accept ${id}`,
    );
    expect(acceptReply).toMatch(/accepted/i);

    // Skill file should be on disk
    const acceptedPath = path.join(tmpGroupsDir, GROUP, 'skills', 'new-skill.md');
    expect(fs.existsSync(acceptedPath)).toBe(true);

    // Skill should appear in the system prompt
    const prompt = runnerTesting.loadSystemPromptForTest(GROUP, tmpGroupsDir);
    expect(prompt).toContain('NEW SKILL BODY');
  });

  it('propose_skill stages candidate, accept moves it, prompt includes it', async () => {
    const dupCheck = async () => ({ duplicate: false });

    const res = await proposeSkill(
      tmpGroupsDir,
      GROUP,
      {
        proposed_name: 'rg-over-grep',
        description: 'use ripgrep',
        body: 'Use rg --hidden',
        rationale: 'efficiency',
      },
      dupCheck,
    );

    expect(res.kind).toBe('staged');
    if (res.kind !== 'staged') throw new Error('expected staged');

    // Accept the candidate via skills-commands
    const acceptReply = handleSkillsCommand(
      tmpGroupsDir,
      GROUP,
      JID,
      `/skills accept ${res.candidateId}`,
    );
    expect(acceptReply).toMatch(/accepted/i);

    // Skill body should appear in system prompt
    const prompt = runnerTesting.loadSystemPromptForTest(GROUP, tmpGroupsDir);
    expect(prompt).toContain('Use rg --hidden');
  });

  it('curator stages candidates from transcript, user accepts, skill appears', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({
      role: 'user',
      content: `corrected: do X instead at turn ${i}`,
    }));

    const llm = async () => [
      {
        action: 'new' as const,
        target: null,
        name: 'do-x-instead',
        description: 'prefer X',
        body: 'Always do X instead.',
      },
    ];

    const res = await runCurator(GROUP, {
      groupsRoot: tmpGroupsDir,
      getTranscript: () => transcript,
      llm,
    });

    expect(res.candidatesWritten).toBe(1);

    // Review to get the candidate id
    const reviewReply = handleSkillsCommand(tmpGroupsDir, GROUP, JID, '/skills review');
    const match = reviewReply.match(/Candidate 1 of 1: (\S+)/);
    expect(match).not.toBeNull();
    const id = match![1];

    // Accept
    const acceptReply = handleSkillsCommand(
      tmpGroupsDir,
      GROUP,
      JID,
      `/skills accept ${id}`,
    );
    expect(acceptReply).toMatch(/accepted/i);

    // Skill body appears in prompt
    const prompt = runnerTesting.loadSystemPromptForTest(GROUP, tmpGroupsDir);
    expect(prompt).toContain('Always do X instead.');
  });
});
