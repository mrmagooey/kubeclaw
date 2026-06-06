export interface SkillFrontmatter {
  name: string;
  description: string;
  created: string; // ISO date YYYY-MM-DD
  source: string; // "manual" | "propose-skill-<id>" | "harvest-curator-<date>"
  target?: string; // for curator-staged edits: the existing skill this proposes to replace
}

// ─── Bootstrap Skill Frontmatter (Story 179) ──────────────────────────────────

/**
 * Structured bootstrap-specific fields extracted from a skill's YAML frontmatter.
 * Present in skills used by `bootstrap_channel_from_skill`.
 */
export interface BootstrapSkillFrontmatter {
  name: string;
  description: string;
  bootstrap: {
    channelType: string;
    manifestVersion: string;
    expectedQuestions: string[];
  };
}

/**
 * Known {channelType, manifestVersion} pair used for cross-validation.
 * Loaded by the caller from the Story 178 channel-manifest registry
 * before invoking `parseBootstrapSkillFrontmatter`. Keeps the parser K8s-free.
 */
export interface KnownManifest {
  channelType: string;
  manifestVersion: string;
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

/**
 * Parse a bootstrap skill's YAML frontmatter from raw markdown.
 *
 * Reuses the existing `parseSkill` for the base fields (`name`, `description`),
 * then extracts and validates bootstrap-specific fields from the same frontmatter
 * block. Cross-validates `bootstrap.channelType` + `bootstrap.manifestVersion`
 * against the `knownManifests` set provided by the caller (loaded from the
 * Story 178 registry) — keeps this function K8s-free and unit-testable.
 *
 * Rejection conditions (AC3):
 *  a. `name` in frontmatter does not match `expectedName` arg
 *  b. `description` absent or blank (caught by parseSkill)
 *  c. `bootstrap.channelType` absent or blank
 *  d. `bootstrap.manifestVersion` not found in `knownManifests` for `channelType`
 *  e. `bootstrap.expectedQuestions` absent, not an array, or empty
 */
export function parseBootstrapSkillFrontmatter(
  raw: string,
  knownManifests: KnownManifest[],
  expectedName?: string,
): BootstrapSkillFrontmatter {
  // Use the existing parser for base fields (handles FRONTMATTER_RE + required checks)
  const base = parseSkill(raw);
  const fm = base.frontmatter;

  // (a) name mismatch
  if (expectedName !== undefined && fm.name !== expectedName) {
    throw new Error(
      `frontmatter name mismatch: expected ${expectedName}, got ${fm.name}`,
    );
  }

  // Extract the raw frontmatter block to parse nested bootstrap.* fields
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error('skill file missing YAML frontmatter');
  const fmBlock = m[1];

  // Parse bootstrap sub-fields with a simple line-scanner (same pattern as parseSkill)
  // Supports:
  //   bootstrap:
  //     channelType: telegram
  //     manifestVersion: 1.0.0
  //     expectedQuestions:
  //       - "What is your bot token?"
  let channelType: string | undefined;
  let manifestVersion: string | undefined;
  const expectedQuestions: string[] = [];
  let inBootstrap = false;
  let inExpectedQuestions = false;

  for (const line of fmBlock.split('\n')) {
    // Detect `bootstrap:` section
    if (/^bootstrap\s*:/.test(line)) {
      inBootstrap = true;
      inExpectedQuestions = false;
      continue;
    }
    if (inBootstrap) {
      // Sub-key of bootstrap (indented line)
      const subMatch = /^  (\w+)\s*:\s*(.*)$/.exec(line);
      if (subMatch) {
        const subKey = subMatch[1];
        const subVal = subMatch[2].trim();
        if (subKey === 'channelType') {
          channelType = subVal || undefined;
          inExpectedQuestions = false;
        } else if (subKey === 'manifestVersion') {
          manifestVersion = subVal || undefined;
          inExpectedQuestions = false;
        } else if (subKey === 'expectedQuestions') {
          inExpectedQuestions = true;
          // value may be empty (array follows on next lines) or inline (rare)
          if (subVal) {
            // Inline value (not typical YAML array) — treat as single item
            expectedQuestions.push(subVal.replace(/^["']|["']$/g, ''));
            inExpectedQuestions = false;
          }
        } else {
          inExpectedQuestions = false;
        }
        continue;
      }
      // Array item under expectedQuestions — accept any indented `- value` line
      const itemMatch = /^\s+-\s+(.+)$/.exec(line);
      if (inExpectedQuestions && itemMatch) {
        expectedQuestions.push(itemMatch[1].replace(/^["']|["']$/g, ''));
        continue;
      }
      // Unindented line signals end of bootstrap block
      if (!/^\s/.test(line) && line.trim() !== '') {
        inBootstrap = false;
        inExpectedQuestions = false;
      }
    }
  }

  // (c) channelType required
  if (!channelType) {
    throw new Error(
      'frontmatter missing required field: bootstrap.channelType',
    );
  }

  // (d) manifestVersion cross-validation against known manifests
  if (!manifestVersion) {
    throw new Error(
      `bootstrap.manifestVersion does not match any registered manifest for channelType=${channelType}`,
    );
  }
  const found = knownManifests.some(
    (km) =>
      km.channelType === channelType && km.manifestVersion === manifestVersion,
  );
  if (!found) {
    throw new Error(
      `bootstrap.manifestVersion does not match any registered manifest for channelType=${channelType}`,
    );
  }

  // (e) expectedQuestions required non-empty array
  if (expectedQuestions.length === 0) {
    throw new Error(
      'frontmatter missing required field: bootstrap.expectedQuestions (must be a non-empty array)',
    );
  }

  return {
    name: fm.name,
    description: fm.description,
    bootstrap: {
      channelType,
      manifestVersion,
      expectedQuestions,
    },
  };
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSlug(slug: string): boolean {
  if (!slug) return false;
  return SLUG_RE.test(slug);
}
