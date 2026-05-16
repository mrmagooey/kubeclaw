import { logger } from '../logger.js';
import { listAcceptedSkills, writeCandidate } from './skill-store.js';
import { SkillFile, validateSlug } from './skill-format.js';

export interface TranscriptTurn {
  role: string;
  content: string;
}

export interface CuratorProposal {
  action: 'new' | 'edit' | 'tune-description';
  target: string | null;
  name: string;
  description: string;
  body: string;
}

export type CuratorLLMFn = (
  transcript: TranscriptTurn[],
  existingSkills: SkillFile[],
) => Promise<CuratorProposal[]>;

export interface CuratorDeps {
  groupsRoot: string;
  getTranscript: () => TranscriptTurn[];
  llm: CuratorLLMFn;
}

const MIN_USER_TURNS = 3;

export interface CuratorResult {
  candidatesWritten: number;
}

export async function runCurator(group: string, deps: CuratorDeps): Promise<CuratorResult> {
  const transcript = deps.getTranscript();
  const userTurns = transcript.filter((t) => t.role === 'user').length;
  if (userTurns < MIN_USER_TURNS) {
    return { candidatesWritten: 0 };
  }
  const existing = listAcceptedSkills(deps.groupsRoot, group);
  let proposals: CuratorProposal[];
  try {
    proposals = await deps.llm(transcript, existing);
  } catch (err) {
    logger.warn({ err, group }, 'curator LLM failed');
    return { candidatesWritten: 0 };
  }

  let written = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const p of proposals) {
    if (!p || !p.name || !p.description || !p.body) continue;
    if (!validateSlug(p.name)) continue;
    const frontmatter: SkillFile['frontmatter'] = {
      name: p.name,
      description: p.description,
      created: today,
      source: `harvest-curator-${today}`,
    };
    if ((p.action === 'edit' || p.action === 'tune-description') && p.target) {
      frontmatter.target = p.target;
    }
    const skill: SkillFile = { frontmatter, body: p.body.trim() + '\n' };
    try {
      writeCandidate(deps.groupsRoot, group, skill);
      written++;
    } catch (err) {
      logger.warn({ err, name: p.name }, 'failed to stage curator candidate');
    }
  }
  return { candidatesWritten: written };
}
