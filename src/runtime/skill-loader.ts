import { listAcceptedSkills } from './skill-store.js';
import { SkillFile } from './skill-format.js';
import {
  recordSkillLoad,
  getSkillLoadStats,
  SkillLoadStat,
} from '../db.js';

export const SKILL_CAP = 20;

export interface LoadResult {
  promptSuffix: string;
  loadedSkills: string[];
}

export function loadSkills(groupsRoot: string, group: string): LoadResult {
  const skills = listAcceptedSkills(groupsRoot, group);
  if (skills.length === 0) {
    return { promptSuffix: '', loadedSkills: [] };
  }

  let selected: SkillFile[];
  if (skills.length <= SKILL_CAP) {
    selected = skills;
  } else {
    const stats = new Map<string, number>(
      getSkillLoadStats(group).map((s: SkillLoadStat) => [s.skill_name, s.last_loaded]),
    );
    selected = [...skills]
      .sort(
        (a, b) =>
          (stats.get(b.frontmatter.name) ?? 0) -
          (stats.get(a.frontmatter.name) ?? 0),
      )
      .slice(0, SKILL_CAP);
  }

  const now = Date.now();
  const loadedSkills: string[] = [];
  const bodies: string[] = [];
  for (const skill of selected) {
    recordSkillLoad(group, skill.frontmatter.name, now);
    loadedSkills.push(skill.frontmatter.name);
    bodies.push(skill.body.trim());
  }

  const promptSuffix =
    '\n\n## Learned skills\n\n' + bodies.join('\n\n---\n\n');
  return { promptSuffix, loadedSkills };
}
