/**
 * Bootstrap Skills Reconciler — Story 179.
 *
 * Mirrors `src/channel-manifests/reconciler.ts` for the `kubeclaw-bootstrap-skills`
 * ConfigMap. Merges Helm baseline entries with SQLite admin overrides (admin
 * entry wins on name collision) and applies the result to the live ConfigMap.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { listBootstrapSkillOverrides } from '../skills/orchestrator/bootstrap-skill-registry.js';
import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BootstrapSkillEntry {
  name: string;
  channel_type: string;
  manifest_version: string;
  content_hash: string;
  source: 'helm-baseline' | 'admin-registered';
  registered_at: string;
  registered_by: string;
  /** Raw markdown content — present for baseline and admin entries. */
  markdown?: string;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge Helm baseline entries with admin override entries.
 * Admin entry wins on `name` key collision.
 * Output is sorted by `name`.
 */
export function mergeSkills(
  baseline: BootstrapSkillEntry[],
  overrides: BootstrapSkillEntry[],
): BootstrapSkillEntry[] {
  const byName = new Map<string, BootstrapSkillEntry>();
  for (const e of baseline) byName.set(e.name, e);
  for (const e of overrides) byName.set(e.name, e); // override wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Baseline loader ─────────────────────────────────────────────────────────

const BASELINE_DIR = '/etc/kubeclaw/bootstrap-skills-baseline';

/**
 * Lightly extract channel_type from a skill's markdown frontmatter.
 * Used by the baseline loader — full validation happens at register time.
 */
function extractChannelType(markdown: string): string {
  // Match "channelType: telegram" under a "bootstrap:" block
  const m = /channelType:\s*(\S+)/.exec(markdown);
  return m ? m[1] : '';
}

function extractManifestVersion(markdown: string): string {
  const m = /manifestVersion:\s*(\S+)/.exec(markdown);
  return m ? m[1] : '';
}

/**
 * Load Helm-supplied baseline skills from the mounted ConfigMap directory.
 * Each file is named `<skill_name>.md` and contains the raw markdown.
 * Returns an empty array if the directory does not exist or files cannot be parsed.
 */
export function loadBaselineFromDisk(
  dir = BASELINE_DIR,
): BootstrapSkillEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    logger.warn({ err, dir }, 'bootstrap-skills baseline dir read failed');
    return [];
  }
  const entries: BootstrapSkillEntry[] = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    try {
      const markdown = readFileSync(`${dir}/${file}`, 'utf-8');
      const content_hash = createHash('sha256')
        .update(markdown, 'utf8')
        .digest('hex');
      entries.push({
        name,
        channel_type: extractChannelType(markdown),
        manifest_version: extractManifestVersion(markdown),
        content_hash,
        source: 'helm-baseline',
        registered_at: new Date(0).toISOString(),
        registered_by: 'helm',
        markdown,
      });
    } catch (err) {
      logger.warn({ err, file }, 'bootstrap-skills baseline file parse failed');
    }
  }
  return entries;
}

// ─── Reconciler ───────────────────────────────────────────────────────────────

export interface ReconcilerDeps {
  /** Loads the Helm-supplied baseline skills. */
  baselineLoader: () => BootstrapSkillEntry[];
  /** Server-side apply the rendered JSON to the kubeclaw-bootstrap-skills ConfigMap. */
  configMapApply: (rendered: string) => Promise<void>;
}

export class BootstrapSkillReconciler {
  private generation = 0;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconcilerDeps) {}

  async apply(): Promise<void> {
    // Chain _applyOnce after the previous apply; swallow errors on the chain
    // so a failure does not permanently poison subsequent applies.
    const next = this.applyChain.then(() => this._applyOnce());
    this.applyChain = next.catch(() => {});
    return next;
  }

  private async _applyOnce(): Promise<void> {
    const baseline = this.deps.baselineLoader();
    const rawOverrides = listBootstrapSkillOverrides();

    // Convert SQLite rows to BootstrapSkillEntry shape.
    // Extract channel_type and manifest_version from frontmatter lightly.
    const overrides: BootstrapSkillEntry[] = rawOverrides.map((row) => ({
      name: row.name,
      channel_type: extractChannelType(row.markdown),
      manifest_version: extractManifestVersion(row.markdown),
      content_hash: row.content_hash,
      source: 'admin-registered' as const,
      registered_at: row.registered_at,
      registered_by: row.registered_by,
      markdown: row.markdown,
    }));

    const merged = mergeSkills(baseline, overrides);
    this.generation += 1;
    const rendered = JSON.stringify(
      { version: 1, generation: this.generation, skills: merged },
      null,
      2,
    );

    try {
      await this.deps.configMapApply(rendered);
      logger.info(
        { generation: this.generation, count: merged.length },
        'bootstrap-skills ConfigMap applied',
      );
    } catch (err) {
      logger.error({ err }, 'bootstrap-skills ConfigMap apply failed');
      this.generation -= 1; // do not bump on failure
      throw err;
    }
  }
}
