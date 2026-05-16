import { listAcceptedSkills, writeCandidate } from '../skill-store.js';
import { SkillFile, validateSlug } from '../skill-format.js';

export interface ProposeSkillArgs {
  proposed_name: string;
  description: string;
  body: string;
  rationale: string;
}

export interface DupCheckResult {
  duplicate: boolean;
  existing?: string;
  suggestion?: string;
}

export type DupCheckFn = (
  args: ProposeSkillArgs,
  existingSkills: SkillFile[],
) => Promise<DupCheckResult>;

export type ProposeSkillResult =
  | { kind: 'staged'; candidateId: string; preview: string }
  | { kind: 'duplicate'; existing: string; suggestion: string }
  | { kind: 'error'; message: string };

export async function proposeSkill(
  groupsRoot: string,
  group: string,
  args: ProposeSkillArgs,
  dupCheck: DupCheckFn,
): Promise<ProposeSkillResult> {
  if (!validateSlug(args.proposed_name)) {
    return {
      kind: 'error',
      message: `invalid slug (use kebab-case): ${args.proposed_name}`,
    };
  }
  const existing = listAcceptedSkills(groupsRoot, group);
  const dup = await dupCheck(args, existing);
  if (dup.duplicate) {
    return {
      kind: 'duplicate',
      existing: dup.existing ?? '(unknown)',
      suggestion: dup.suggestion ?? 'edit the existing skill rather than creating a new one',
    };
  }
  const skill: SkillFile = {
    frontmatter: {
      name: args.proposed_name,
      description: args.description,
      created: new Date().toISOString().slice(0, 10),
      source: `propose-skill-${Date.now()}`,
    },
    body: args.body.trim() + '\n',
  };
  const candidateId = writeCandidate(groupsRoot, group, skill);
  const preview = `Drafted candidate ${candidateId}: ${args.proposed_name}\n\n${args.body.trim()}`;
  return { kind: 'staged', candidateId, preview };
}
