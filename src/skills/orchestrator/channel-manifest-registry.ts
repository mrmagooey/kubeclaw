/**
 * Channel Manifest Registry — Story 178.
 *
 * Stores admin-registered channel manifests in the `channel_manifest_overrides`
 * SQLite table. Mirrors the structure of `specialist-registry.ts` exactly.
 *
 * Hash algorithm:
 *   sha256(canonicalJson(packageJson) + '\n' + canonicalJson(packageLockJson))
 * where canonicalJson sorts all object keys recursively (no third-party lib).
 * This matches `computeManifestHash` in `src/k8s/bootstrap-runner.ts` and the
 * algorithm the bootstrap pod uses for post-install hash verification.
 *
 * TODO (Story 184): unregister_channel_manifest — remove the admin override
 * from SQLite and trigger reconcile, reverting list_channel_manifests to the
 * Helm baseline entry (or nothing if purely admin-registered). Out of scope
 * for Story 178.
 */

import { db } from '../../db.js';
import { logger } from '../../logger.js';
import {
  computeManifestHash,
  validateChannelManifest,
} from '../../k8s/bootstrap-runner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Result<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type ReconcileFn = () => Promise<void>;

export interface RegisterArgs {
  channel_type: string;
  package_json: string;
  package_lock_json: string;
  host_mode?: 'standalone' | 'channel-runner';
}

export interface OverrideRow {
  channel_type: string;
  package_json: string;
  package_lock_json: string;
  manifest_hash: string;
  registered_at: string;
  registered_by: string;
  host_mode: 'standalone' | 'channel-runner';
}

// ─── Register ─────────────────────────────────────────────────────────────────

/**
 * Register (or upsert if different content) a channel manifest override.
 *
 * Validation order:
 *  1. JSON parsability of both strings
 *  2. lockfileVersion === 3 (we only support npm lockfile v3)
 *  3. top-level `dependencies` key present in package.json
 *  4. no `devDependencies` in package.json
 *  5. lifecycle-script allowlist (package.json scripts + lockfile per-package scripts)
 *
 * On identical (channel_type, manifest_hash) → short-circuit, no reconcile.
 * On new channel_type or different hash → INSERT OR REPLACE, then reconcile.
 */
export function registerChannelManifest(
  args: RegisterArgs,
  allowedLifecycleScripts: string[] = [],
  reconcile?: ReconcileFn,
): Result<{ manifest_hash: string; source: 'admin-registered' }> {
  // 1. JSON parsability
  let pkg: Record<string, unknown>;
  let lock: Record<string, unknown>;
  try {
    pkg = JSON.parse(args.package_json) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid JSON in package_json' };
  }
  try {
    lock = JSON.parse(args.package_lock_json) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid JSON in package_lock_json' };
  }

  // 2. lockfileVersion must be 3
  if (lock.lockfileVersion !== 3) {
    return {
      ok: false,
      error: `package_lock_json must have lockfileVersion: 3 (got ${String(lock.lockfileVersion)})`,
    };
  }

  // 3. top-level dependencies required
  if (!pkg.dependencies) {
    return {
      ok: false,
      error: 'package_json must contain a top-level "dependencies" key',
    };
  }

  // 4–5. Delegate to the shared validateChannelManifest (devDependencies + lifecycle scripts)
  try {
    validateChannelManifest(
      {
        packageJson: args.package_json,
        packageLockJson: args.package_lock_json,
      },
      allowedLifecycleScripts,
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // 6. Validate host_mode (if provided)
  const validHostModes = ['standalone', 'channel-runner'];
  if (args.host_mode !== undefined && !validHostModes.includes(args.host_mode)) {
    return {
      ok: false,
      error: `host_mode must be one of ${validHostModes.map((m) => `'${m}'`).join(', ')} (got '${args.host_mode}')`,
    };
  }
  const host_mode = args.host_mode ?? 'standalone';

  // Compute hash
  const manifest_hash = computeManifestHash(
    args.package_json,
    args.package_lock_json,
  );

  // Idempotency check — same channel_type AND same hash AND same host_mode → short-circuit
  const existing = db.exec(
    `SELECT manifest_hash, host_mode FROM channel_manifest_overrides WHERE channel_type = ?`,
    [args.channel_type],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    const storedHash = existing[0].values[0][0] as string;
    const storedHostMode = ((existing[0].values[0][1] as string | null) ?? 'standalone') as 'standalone' | 'channel-runner';
    if (storedHash === manifest_hash && storedHostMode === host_mode) {
      // Identical content and host_mode — no-op, no reconcile
      return { ok: true, manifest_hash, source: 'admin-registered' };
    }
  }

  // Upsert
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO channel_manifest_overrides
      (channel_type, package_json, package_lock_json, manifest_hash, registered_at, registered_by, host_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      args.channel_type,
      args.package_json,
      args.package_lock_json,
      manifest_hash,
      now,
      'admin',
      host_mode,
    ],
  );

  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after channel manifest mutation failed');
  });

  return { ok: true, manifest_hash, source: 'admin-registered' };
}

// ─── List ─────────────────────────────────────────────────────────────────────

/**
 * Return all admin-registered channel manifest overrides, ordered by channel_type.
 */
export function listChannelManifestOverrides(): OverrideRow[] {
  const rows = db.exec(
    `SELECT channel_type, package_json, package_lock_json, manifest_hash, registered_at, registered_by, host_mode
     FROM channel_manifest_overrides
     ORDER BY channel_type`,
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((row) => ({
    channel_type: row[0] as string,
    package_json: row[1] as string,
    package_lock_json: row[2] as string,
    manifest_hash: row[3] as string,
    registered_at: row[4] as string,
    registered_by: row[5] as string,
    host_mode: ((row[6] as string | null) ?? 'standalone') as 'standalone' | 'channel-runner',
  }));
}
