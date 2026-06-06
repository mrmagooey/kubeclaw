/**
 * Bootstrap Skill Registry — Story 179.
 *
 * Stores admin-registered bootstrap skills in the `bootstrap_skill_overrides`
 * SQLite table. Mirrors the structure of `channel-manifest-registry.ts` exactly.
 *
 * Hash algorithm:
 *   crypto.createHash('sha256').update(markdown, 'utf8').digest('hex')
 * over the raw markdown string (UTF-8 bytes).
 * Bootstrap pods reading the mounted ConfigMap can verify by hashing the
 * mounted file content with the same algorithm.
 *
 * TODO (follow-on): skill versioning — multiple immutable versions of a named
 * skill, selectable by `bootstrap_channel_from_skill`'s `skill_name@version` syntax.
 *
 * TODO (follow-on): signed skills — GPG or Sigstore signatures on skill markdown,
 * verified by the bootstrap pod before execution.
 */

import crypto from 'crypto';
import { db } from '../../db.js';
import { logger } from '../../logger.js';
import {
  parseBootstrapSkillFrontmatter,
  type KnownManifest,
} from '../../runtime/skill-format.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Result<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type ReconcileFn = () => Promise<void>;

export interface RegisterArgs {
  name: string;
  markdown: string;
}

export interface OverrideRow {
  name: string;
  markdown: string;
  content_hash: string;
  registered_at: string;
  registered_by: string;
}

/** Shape of a baseline entry for `removeBootstrapSkill` baseline check. */
export interface BaselineEntry {
  name: string;
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/** Compute sha256 of raw markdown bytes (UTF-8). */
export function computeSkillHash(markdown: string): string {
  return crypto.createHash('sha256').update(markdown, 'utf8').digest('hex');
}

// ─── Register ─────────────────────────────────────────────────────────────────

/**
 * Register (or upsert if different content) a bootstrap skill override.
 *
 * Validation order (AC3):
 *  a. Frontmatter must parse cleanly via parseBootstrapSkillFrontmatter
 *  b. name in frontmatter must match the `name` argument
 *  c. description must be non-empty (enforced by parseBootstrapSkillFrontmatter)
 *  d. bootstrap.channelType must be non-empty (enforced by parseBootstrapSkillFrontmatter)
 *  e. bootstrap.manifestVersion must exist in knownManifests for channelType (cross-validated)
 *  f. bootstrap.expectedQuestions must be a non-empty array (enforced by parseBootstrapSkillFrontmatter)
 *
 * On identical (name, content_hash) → short-circuit, no reconcile (AC4).
 * On new name or different hash → INSERT OR REPLACE, then reconcile.
 */
export function registerBootstrapSkill(
  args: RegisterArgs,
  knownManifests: KnownManifest[],
  reconcile?: ReconcileFn,
): Result<{ content_hash: string; source: 'admin-registered' }> {
  // Parse and validate frontmatter (throws on any validation failure)
  try {
    parseBootstrapSkillFrontmatter(args.markdown, knownManifests, args.name);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Compute content hash
  const content_hash = computeSkillHash(args.markdown);

  // Idempotency check — same name AND same hash → short-circuit (AC4)
  const existing = db.exec(
    `SELECT content_hash FROM bootstrap_skill_overrides WHERE name = ?`,
    [args.name],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    const storedHash = existing[0].values[0][0] as string;
    if (storedHash === content_hash) {
      // Identical content — no-op, no reconcile
      return { ok: true, content_hash, source: 'admin-registered' };
    }
  }

  // Upsert
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO bootstrap_skill_overrides
      (name, markdown, content_hash, registered_at, registered_by)
     VALUES (?, ?, ?, ?, ?)`,
    [args.name, args.markdown, content_hash, now, 'admin'],
  );

  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after bootstrap skill mutation failed');
  });

  return { ok: true, content_hash, source: 'admin-registered' };
}

// ─── Remove ───────────────────────────────────────────────────────────────────

export type RemoveResult =
  | { ok: true; status: 'removed' | 'already absent' }
  | {
      ok: false;
      code: 'PROTECTED_BASELINE';
      source: 'helm-baseline';
      name: string;
    };

/**
 * Remove an admin-registered bootstrap skill.
 *
 * - If the skill is Helm-baseline only (not in overrides table): returns
 *   PROTECTED_BASELINE without modifying any state (AC5).
 * - If the skill is in the overrides table: deletes and triggers reconcile (AC5).
 * - If the skill is absent from both: returns {status: "already absent"} (AC5).
 * - Idempotent: calling again on an already-removed skill returns "already absent".
 */
export function removeBootstrapSkill(
  name: string,
  baselineLoader: () => BaselineEntry[],
  reconcile?: ReconcileFn,
): RemoveResult {
  // Check if it's in the admin overrides table
  const inOverrides = db.exec(
    `SELECT name FROM bootstrap_skill_overrides WHERE name = ?`,
    [name],
  );
  const isAdminEntry =
    inOverrides.length > 0 && inOverrides[0].values.length > 0;

  if (!isAdminEntry) {
    // Not an admin entry — check if it's a Helm baseline
    const baseline = baselineLoader();
    const isBaseline = baseline.some((e) => e.name === name);
    if (isBaseline) {
      // PROTECTED_BASELINE — refuse, no state modification (AC5)
      return {
        ok: false,
        code: 'PROTECTED_BASELINE',
        source: 'helm-baseline',
        name,
      };
    }
    // Neither admin nor baseline — idempotent "already absent" (AC5)
    return { ok: true, status: 'already absent' };
  }

  // Delete from overrides table
  db.run(`DELETE FROM bootstrap_skill_overrides WHERE name = ?`, [name]);

  reconcile?.().catch((err) => {
    logger.warn(
      { err, name },
      'reconcile after bootstrap skill removal failed',
    );
  });

  return { ok: true, status: 'removed' };
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * Return all admin-registered bootstrap skill overrides, ordered by name.
 */
export function listBootstrapSkillOverrides(): OverrideRow[] {
  const rows = db.exec(
    `SELECT name, markdown, content_hash, registered_at, registered_by
     FROM bootstrap_skill_overrides
     ORDER BY name`,
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((row) => ({
    name: row[0] as string,
    markdown: row[1] as string,
    content_hash: row[2] as string,
    registered_at: row[3] as string,
    registered_by: row[4] as string,
  }));
}
