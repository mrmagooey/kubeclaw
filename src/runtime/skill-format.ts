export interface SkillFrontmatter {
  name: string;
  description: string;
  created: string; // ISO date YYYY-MM-DD
  source: string; // "manual" | "propose-skill-<id>" | "harvest-curator-<date>"
  target?: string; // for curator-staged edits: the existing skill this proposes to replace
}

export interface SkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseSkill(raw: string): SkillFile {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error('skill file missing YAML frontmatter');
  const fmBlock = m[1];
  let body = m[2] ?? '';
  // Strip leading newline if present (from blank line after ---)
  if (body.startsWith('\n')) {
    body = body.slice(1);
  }
  const fm: Partial<SkillFrontmatter> = {};
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (
      key === 'name' ||
      key === 'description' ||
      key === 'created' ||
      key === 'source' ||
      key === 'target'
    ) {
      fm[key] = value;
    }
  }
  for (const required of [
    'name',
    'description',
    'created',
    'source',
  ] as const) {
    if (!fm[required])
      throw new Error(`skill frontmatter missing required field: ${required}`);
  }
  return { frontmatter: fm as SkillFrontmatter, body };
}

export function serializeSkill(skill: SkillFile): string {
  const fm = skill.frontmatter;
  const targetLine = fm.target !== undefined ? `target: ${fm.target}\n` : '';
  return `---\nname: ${fm.name}\ndescription: ${fm.description}\ncreated: ${fm.created}\nsource: ${fm.source}\n${targetLine}---\n\n${skill.body}`;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSlug(slug: string): boolean {
  if (!slug) return false;
  return SLUG_RE.test(slug);
}
