import * as fs from 'fs';
import * as path from 'path';
import {
  parseSkill,
  serializeSkill,
  validateSlug,
  SkillFile,
} from './skill-format.js';

export interface Candidate {
  id: string; // timestamp + slug, used as filename stem
  skill: SkillFile;
}

function skillsDir(root: string, group: string): string {
  return path.join(root, group, 'skills');
}

function candidatesDir(root: string, group: string): string {
  return path.join(skillsDir(root, group), '_candidates');
}

function archiveDir(root: string, group: string): string {
  return path.join(skillsDir(root, group), '_archive');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function listMd(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'),
    )
    .map((f) => path.join(dir, f));
}

function readSkillFile(file: string): SkillFile {
  return parseSkill(fs.readFileSync(file, 'utf-8'));
}

function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function listAcceptedSkills(root: string, group: string): SkillFile[] {
  return listMd(skillsDir(root, group)).map(readSkillFile);
}

export function listCandidates(root: string, group: string): Candidate[] {
  const dir = candidatesDir(root, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'),
    )
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const skill = readSkillFile(path.join(dir, f));
      return { id, skill };
    });
}

export function listArchived(root: string, group: string): SkillFile[] {
  const dir = archiveDir(root, group);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readSkillFile(path.join(dir, f)));
}

export function readSkill(
  root: string,
  group: string,
  name: string,
): SkillFile | null {
  if (!validateSlug(name)) return null;
  const file = path.join(skillsDir(root, group), `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return readSkillFile(file);
}

export function writeCandidate(
  root: string,
  group: string,
  skill: SkillFile,
): string {
  if (!validateSlug(skill.frontmatter.name)) {
    throw new Error(`invalid skill slug: ${skill.frontmatter.name}`);
  }
  const dir = candidatesDir(root, group);
  ensureDir(dir);
  // Use hrtime for sub-millisecond uniqueness to avoid collisions on same-ms writes
  const [sec, nano] = process.hrtime();
  const unique = (BigInt(sec) * 1_000_000_000n + BigInt(nano)).toString(36);
  const id = `${Date.now()}-${unique}-${skill.frontmatter.name}`;
  writeAtomic(path.join(dir, `${id}.md`), serializeSkill(skill));
  return id;
}

export function acceptCandidate(root: string, group: string, id: string): void {
  const src = path.join(candidatesDir(root, group), `${id}.md`);
  if (!fs.existsSync(src)) throw new Error(`candidate not found: ${id}`);
  const skill = readSkillFile(src);
  // When the candidate has `target`, it is an edit/tune-description of an
  // existing accepted skill. Use the target slug as the accepted filename so
  // the new version replaces the old one.
  const targetName = skill.frontmatter.target || skill.frontmatter.name;
  if (!validateSlug(targetName)) {
    throw new Error(`invalid target slug: ${targetName}`);
  }
  const dest = path.join(skillsDir(root, group), `${targetName}.md`);
  if (fs.existsSync(dest)) {
    if (!skill.frontmatter.target) {
      throw new Error(`skill already exists: ${targetName}`);
    }
    // Edit candidate: archive the existing accepted skill before replacing it.
    ensureDir(archiveDir(root, group));
    const archivePath = path.join(
      archiveDir(root, group),
      `${targetName}.${Date.now()}.md`,
    );
    fs.renameSync(dest, archivePath);
  }
  ensureDir(skillsDir(root, group));
  if (skill.frontmatter.target) {
    // Rewrite the file so the accepted version carries `name: <target>` and
    // has no `target` field (target only makes sense while a candidate).
    const cleaned: SkillFile = {
      frontmatter: {
        ...skill.frontmatter,
        name: targetName,
        target: undefined,
      },
      body: skill.body,
    };
    fs.writeFileSync(dest, serializeSkill(cleaned));
    fs.unlinkSync(src);
  } else {
    fs.renameSync(src, dest);
  }
}

export function rejectCandidate(root: string, group: string, id: string): void {
  const src = path.join(candidatesDir(root, group), `${id}.md`);
  if (!fs.existsSync(src)) throw new Error(`candidate not found: ${id}`);
  fs.unlinkSync(src);
}

export function disableSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  const src = path.join(skillsDir(root, group), `${name}.md`);
  if (!fs.existsSync(src)) throw new Error(`skill not found: ${name}`);
  ensureDir(archiveDir(root, group));
  fs.renameSync(src, path.join(archiveDir(root, group), `${name}.md`));
}

export function enableSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  const src = path.join(archiveDir(root, group), `${name}.md`);
  if (!fs.existsSync(src)) throw new Error(`archived skill not found: ${name}`);
  ensureDir(skillsDir(root, group));
  fs.renameSync(src, path.join(skillsDir(root, group), `${name}.md`));
}

export function pruneSkill(root: string, group: string, name: string): void {
  if (!validateSlug(name)) throw new Error(`invalid slug: ${name}`);
  for (const dir of [skillsDir(root, group), archiveDir(root, group)]) {
    const f = path.join(dir, `${name}.md`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
