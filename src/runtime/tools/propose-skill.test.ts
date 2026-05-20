import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listCandidates,
  writeCandidate,
  acceptCandidate,
} from '../skill-store.js';
import { proposeSkill, ProposeSkillArgs, DupCheckFn } from './propose-skill.js';

let root: string;
const GROUP = 'g1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-skill-'));
  fs.mkdirSync(path.join(root, GROUP), { recursive: true });
});

const novelDup: DupCheckFn = async () => ({ duplicate: false });
const dupOfFoo: DupCheckFn = async () => ({
  duplicate: true,
  existing: 'foo',
  suggestion: 'extend foo instead',
});

function mkArgs(name = 'bar'): ProposeSkillArgs {
  return {
    proposed_name: name,
    description: 'a brand new skill',
    body: 'do the thing this way',
    rationale: 'because peter said so',
  };
}

describe('proposeSkill', () => {
  it('writes a candidate when novel', async () => {
    const res = await proposeSkill(root, GROUP, mkArgs(), novelDup);
    expect(res.kind).toBe('staged');
    if (res.kind === 'staged') {
      expect(res.candidateId).toBeDefined();
      expect(res.preview).toContain('do the thing this way');
    }
    expect(listCandidates(root, GROUP)).toHaveLength(1);
  });

  it('does not write a candidate when duplicate detected', async () => {
    const res = await proposeSkill(root, GROUP, mkArgs(), dupOfFoo);
    expect(res.kind).toBe('duplicate');
    if (res.kind === 'duplicate') {
      expect(res.existing).toBe('foo');
    }
    expect(listCandidates(root, GROUP)).toHaveLength(0);
  });

  it('detects duplicate against an existing accepted skill via the dup-check', async () => {
    const id = writeCandidate(root, GROUP, {
      frontmatter: {
        name: 'foo',
        description: 'foo skill',
        created: '2026-05-16',
        source: 'manual',
      },
      body: 'foo body',
    });
    acceptCandidate(root, GROUP, id);

    const dup: DupCheckFn = vi.fn(async (_args, existing) => {
      expect(existing.map((s) => s.frontmatter.name)).toContain('foo');
      return { duplicate: true, existing: 'foo', suggestion: 'edit foo' };
    });

    const res = await proposeSkill(root, GROUP, mkArgs(), dup);
    expect(res.kind).toBe('duplicate');
    expect(dup).toHaveBeenCalledOnce();
  });

  it('rejects invalid slug before any LLM call', async () => {
    const dup: DupCheckFn = vi.fn(novelDup);
    const res = await proposeSkill(root, GROUP, mkArgs('Bad Slug'), dup);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/slug/);
    expect(dup).not.toHaveBeenCalled();
  });
});
