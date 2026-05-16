import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listCandidates, listAcceptedSkills, writeCandidate, acceptCandidate } from './skill-store.js';
import { runCurator, CuratorDeps, CuratorLLMFn } from './skill-curator.js';

let root: string;
const GROUP = 'g1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

function deps(transcript: { role: string; content: string }[], llm: CuratorLLMFn): CuratorDeps {
  return {
    groupsRoot: root,
    getTranscript: () => transcript,
    llm,
  };
}

describe('runCurator', () => {
  it('does nothing when transcript is below threshold', async () => {
    const calls: number[] = [];
    const llm: CuratorLLMFn = async () => {
      calls.push(1);
      return [];
    };
    const res = await runCurator(GROUP, deps([{ role: 'user', content: 'hi' }], llm));
    expect(res.candidatesWritten).toBe(0);
    expect(calls).toEqual([]);
  });

  it('writes candidates for each LLM-returned new entry', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () => [
      { action: 'new', target: null, name: 'alpha', description: 'alpha', body: 'A' },
      { action: 'new', target: null, name: 'beta', description: 'beta', body: 'B' },
    ];
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(2);
    const cands = listCandidates(root, GROUP);
    expect(cands.map((c) => c.skill.frontmatter.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('writes an edit candidate referencing existing skill', async () => {
    const id = writeCandidate(root, GROUP, {
      frontmatter: { name: 'foo', description: 'foo', created: '2026-05-16', source: 'manual' },
      body: 'old body',
    });
    acceptCandidate(root, GROUP, id);
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () => [
      { action: 'edit', target: 'foo', name: 'foo', description: 'foo updated', body: 'new body' },
    ];
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(1);
    const cands = listCandidates(root, GROUP);
    expect(cands).toHaveLength(1);
    expect(cands[0].skill.body).toContain('new body');
    // accepted skill is unchanged until user accepts the candidate
    expect(listAcceptedSkills(root, GROUP)[0].body).toContain('old body');
  });

  it('edit proposal candidate carries target in frontmatter', async () => {
    const id = writeCandidate(root, GROUP, {
      frontmatter: { name: 'foo', description: 'foo', created: '2026-05-16', source: 'manual' },
      body: 'old',
    });
    acceptCandidate(root, GROUP, id);
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () => [
      { action: 'edit', target: 'foo', name: 'foo-edit', description: 'better foo', body: 'new content' },
    ];
    await runCurator(GROUP, deps(transcript, llm));
    const cands = listCandidates(root, GROUP);
    expect(cands).toHaveLength(1);
    expect(cands[0].skill.frontmatter.target).toBe('foo');
  });

  it('ignores entries with missing required fields', async () => {
    const transcript = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `t${i}` }));
    const llm: CuratorLLMFn = async () =>
      [
        { action: 'new', target: null, name: '', description: 'd', body: 'b' },
        { action: 'new', target: null, name: 'good', description: 'd', body: 'b' },
      ] as any;
    const res = await runCurator(GROUP, deps(transcript, llm));
    expect(res.candidatesWritten).toBe(1);
    expect(listCandidates(root, GROUP)[0].skill.frontmatter.name).toBe('good');
  });
});
