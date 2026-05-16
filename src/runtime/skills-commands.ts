import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  readSkill,
  acceptCandidate,
  rejectCandidate,
  disableSkill,
  enableSkill,
  pruneSkill,
} from './skill-store.js';
import { getSkillLoadStats, getSkillsLoadedSince } from '../db.js';

const reviewCursors = new Map<string, number>();

export function resetReviewCursors(): void {
  reviewCursors.clear();
}

const HELP = [
  'Skill commands:',
  '  /skills list',
  '  /skills show <name>',
  '  /skills review',
  '  /skills accept <candidate-id>',
  '  /skills reject <candidate-id>',
  '  /skills disable <name>',
  '  /skills enable <name>',
  '  /skills prune',
].join('\n');

export function handleSkillsCommand(
  groupsRoot: string,
  group: string,
  jid: string,
  message: string,
): string {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== '/skills') return HELP;
  const verb = parts[1];
  const arg = parts.slice(2).join(' ');
  const cursorKey = `${group}:${jid}`;
  switch (verb) {
    case undefined:
    case 'help':
      return HELP;
    case 'list': {
      const skills = listAcceptedSkills(groupsRoot, group);
      if (skills.length === 0) return 'No skills installed for this group.';
      const stats = new Map(getSkillLoadStats(group).map((s) => [s.skill_name, s]));
      return (
        'Installed skills:\n' +
        skills
          .map((s) => {
            const stat = stats.get(s.frontmatter.name);
            const count = stat?.load_count ?? 0;
            return `  ${s.frontmatter.name} — ${s.frontmatter.description} (loaded ${count}x)`;
          })
          .join('\n')
      );
    }
    case 'show': {
      if (!arg) return 'Usage: /skills show <name>';
      const skill = readSkill(groupsRoot, group, arg);
      if (!skill) return `Skill not found: ${arg}`;
      return `# ${skill.frontmatter.name}\n${skill.frontmatter.description}\n\n${skill.body}`;
    }
    case 'review': {
      const cands = listCandidates(groupsRoot, group);
      if (cands.length === 0) {
        reviewCursors.delete(cursorKey);
        return 'No candidates pending review.';
      }
      const cursor = reviewCursors.get(cursorKey) ?? 0;
      const next = cursor >= cands.length ? 0 : cursor;
      const c = cands[next];
      reviewCursors.set(cursorKey, next + 1);
      const targetNote = c.skill.frontmatter.target ? ` (proposed as edit of '${c.skill.frontmatter.target}')` : '';
      return (
        `Candidate ${next + 1} of ${cands.length}: ${c.id}${targetNote}\n` +
        `name: ${c.skill.frontmatter.name}\n` +
        `description: ${c.skill.frontmatter.description}\n\n` +
        c.skill.body +
        `\nReply: /skills accept ${c.id}  |  /skills reject ${c.id}  |  /skills review (skip)`
      );
    }
    case 'accept': {
      if (!arg) return 'Usage: /skills accept <candidate-id>';
      try {
        acceptCandidate(groupsRoot, group, arg);
        return `Accepted candidate ${arg}.`;
      } catch (err) {
        return `Could not accept: ${(err as Error).message}`;
      }
    }
    case 'reject': {
      if (!arg) return 'Usage: /skills reject <candidate-id>';
      try {
        rejectCandidate(groupsRoot, group, arg);
        return `Rejected candidate ${arg}.`;
      } catch (err) {
        return `Could not reject: ${(err as Error).message}`;
      }
    }
    case 'disable': {
      if (!arg) return 'Usage: /skills disable <name>';
      try {
        disableSkill(groupsRoot, group, arg);
        return `Disabled skill ${arg}.`;
      } catch (err) {
        return `Could not disable: ${(err as Error).message}`;
      }
    }
    case 'enable': {
      if (!arg) return 'Usage: /skills enable <name>';
      try {
        enableSkill(groupsRoot, group, arg);
        return `Enabled skill ${arg}.`;
      } catch (err) {
        return `Could not enable: ${(err as Error).message}`;
      }
    }
    case 'prune': {
      const skills = listAcceptedSkills(groupsRoot, group);
      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const recentlyLoaded = new Set(getSkillsLoadedSince(group, cutoff));
      const stale = skills
        .map((s) => s.frontmatter.name)
        .filter((n) => !recentlyLoaded.has(n));
      if (stale.length === 0) return 'No stale skills (all loaded in last 60 days).';
      return (
        'Stale skills (0 loads in 60 days). Confirm with /skills prune-confirm <name>:\n' +
        stale.map((n) => `  ${n}`).join('\n')
      );
    }
    case 'prune-confirm': {
      if (!arg) return 'Usage: /skills prune-confirm <name>';
      try {
        pruneSkill(groupsRoot, group, arg);
        return `Pruned ${arg}.`;
      } catch (err) {
        return `Could not prune: ${(err as Error).message}`;
      }
    }
    default:
      return `Unknown verb: ${verb}\n\n${HELP}`;
  }
}

export function isSkillsCommand(message: string): boolean {
  return /^\/skills(\s|$)/.test(message.trim());
}
