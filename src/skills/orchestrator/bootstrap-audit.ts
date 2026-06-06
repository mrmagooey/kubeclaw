/**
 * bootstrap-audit.ts — Story 184
 *
 * Immutable append-only audit trail for every bootstrap_channel_from_skill call.
 * Two-table design:
 *   bootstrap_history (Story 180) — operational, 24 h retention, mutable
 *   bootstrap_audit   (Story 184) — compliance, 90 d retention, append-only
 *
 * Exports:
 *   insertBootstrapAuditRow   — never throws; wraps insert in try/catch
 *   queryBootstrapAudit       — filtered query returning rows ordered by recorded_at DESC
 *   pruneBootstrapAudit       — delete rows older than N days, returns count deleted
 *   startBootstrapAuditGcInterval — background GC loop (mirrors startToolJobPruneInterval)
 *
 * TODO: export_bootstrap_audit(format, since, until) — CSV/NDJSON export for SIEM ingestion (follow-on)
 * TODO: Webhook push to external SIEM on terminal-row insert (follow-on)
 */

import { db, saveDatabase } from '../../db.js';
import { logger } from '../../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BootstrapAuditOutcome =
  | 'in-progress'
  | 'succeeded'
  | 'timed-out'
  | 'manifest-divergence'
  | 'rejected'
  | 'error';

/**
 * Exhaustiveness helper — TypeScript will error at compile time if a new value
 * is added to BootstrapAuditOutcome but not handled in a switch.
 */
export function assertNeverOutcome(x: never): never {
  throw new Error(`Unhandled BootstrapAuditOutcome: ${String(x)}`);
}

export interface BootstrapAuditRow {
  audit_id: number;
  bootstrap_job_id: string;
  recorded_at: string;
  admin_identity: string;
  admin_session_id: string | null;
  channel_type: string;
  instance_name: string;
  skill_name: string;
  skill_content_hash: string;
  manifest_hash_requested: string;
  manifest_hash_observed: string | null;
  outcome: BootstrapAuditOutcome;
  error_code: string | null;
  error_message: string | null;
  duration_seconds: number | null;
}

export interface InsertBootstrapAuditRowArgs {
  bootstrapJobId: string;
  recordedAt: string;
  adminIdentity: string;
  adminSessionId: string | null;
  channelType: string;
  instanceName: string;
  skillName: string;
  skillContentHash: string;
  manifestHashRequested: string;
  manifestHashObserved?: string | null;
  outcome: BootstrapAuditOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationSeconds?: number | null;
}

// ─── Insert ───────────────────────────────────────────────────────────────────

/**
 * Insert a single row into bootstrap_audit.
 *
 * NEVER throws — any SQLite error is caught, logged at warn, and swallowed.
 * This ensures a DB write error cannot abort a bootstrap lifecycle transition.
 *
 * Two rows are written per bootstrap: a start row (outcome='in-progress') and
 * a terminal row (outcome = final state). No UPDATE is ever issued.
 */
export function insertBootstrapAuditRow(
  args: InsertBootstrapAuditRowArgs,
): void {
  try {
    db.run(
      `INSERT INTO bootstrap_audit
         (bootstrap_job_id, recorded_at, admin_identity, admin_session_id,
          channel_type, instance_name, skill_name, skill_content_hash,
          manifest_hash_requested, manifest_hash_observed,
          outcome, error_code, error_message, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        args.bootstrapJobId,
        args.recordedAt,
        args.adminIdentity,
        args.adminSessionId ?? null,
        args.channelType,
        args.instanceName,
        args.skillName,
        args.skillContentHash,
        args.manifestHashRequested,
        args.manifestHashObserved ?? null,
        args.outcome,
        args.errorCode ?? null,
        args.errorMessage ?? null,
        args.durationSeconds ?? null,
      ],
    );
    saveDatabase();
  } catch (err) {
    logger.warn(
      { err, bootstrapJobId: args.bootstrapJobId, outcome: args.outcome },
      'bootstrap-audit: failed to insert audit row (non-fatal)',
    );
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

export interface QueryBootstrapAuditOpts {
  /** Maximum rows to return. Default 50, capped at 500. */
  limit?: number;
  /** Exact match on channel_type. */
  channelType?: string;
  /** Exact match on outcome. */
  outcome?: BootstrapAuditOutcome;
  /** ISO-8601 datetime — only rows with recorded_at >= since are returned. */
  since?: string;
}

/**
 * Return bootstrap_audit rows ordered by recorded_at DESC.
 * All filters compose with AND. Server-side LIMIT is enforced (max 500).
 */
export function queryBootstrapAudit(
  opts?: QueryBootstrapAuditOpts,
): BootstrapAuditRow[] {
  const { channelType, outcome, since } = opts ?? {};
  const limit = Math.min(opts?.limit ?? 50, 500);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (channelType) {
    conditions.push('channel_type = ?');
    params.push(channelType);
  }
  if (outcome) {
    conditions.push('outcome = ?');
    params.push(outcome);
  }
  if (since) {
    conditions.push('datetime(recorded_at) >= datetime(?)');
    params.push(since);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT audit_id, bootstrap_job_id, recorded_at, admin_identity, admin_session_id,
           channel_type, instance_name, skill_name, skill_content_hash,
           manifest_hash_requested, manifest_hash_observed,
           outcome, error_code, error_message, duration_seconds
    FROM bootstrap_audit
    ${where}
    ORDER BY recorded_at DESC
    LIMIT ?
  `;

  params.push(limit);
  const result = db.exec(sql, params.length > 0 ? params : undefined);
  if (result.length === 0) return [];

  return result[0].values.map((row: unknown[]) => ({
    audit_id: row[0] as number,
    bootstrap_job_id: row[1] as string,
    recorded_at: row[2] as string,
    admin_identity: row[3] as string,
    admin_session_id: row[4] as string | null,
    channel_type: row[5] as string,
    instance_name: row[6] as string,
    skill_name: row[7] as string,
    skill_content_hash: row[8] as string,
    manifest_hash_requested: row[9] as string,
    manifest_hash_observed: row[10] as string | null,
    outcome: row[11] as BootstrapAuditOutcome,
    error_code: row[12] as string | null,
    error_message: row[13] as string | null,
    duration_seconds: row[14] as number | null,
  }));
}

// ─── GC ───────────────────────────────────────────────────────────────────────

/**
 * Delete bootstrap_audit rows whose recorded_at is older than retentionDays.
 * Returns the number of rows deleted.
 * When retentionDays <= 0, returns 0 without deleting anything (infinite retention).
 * Each call emits a structured log line { event: 'bootstrap_audit_gc', deleted_rows: N }.
 */
export function pruneBootstrapAudit(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const countResult = db.exec(
    `SELECT COUNT(*) FROM bootstrap_audit
     WHERE datetime(recorded_at) < datetime('now', '-' || ? || ' days')`,
    [retentionDays],
  );
  const deleted =
    countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;

  if (deleted > 0) {
    db.run(
      `DELETE FROM bootstrap_audit
       WHERE datetime(recorded_at) < datetime('now', '-' || ? || ' days')`,
      [retentionDays],
    );
    saveDatabase();
  }

  logger.info({ event: 'bootstrap_audit_gc', deleted_rows: deleted });
  return deleted;
}

export const BOOTSTRAP_AUDIT_RETENTION_DAYS = parseInt(
  process.env.BOOTSTRAP_AUDIT_RETENTION_DAYS ?? '90',
  10,
);
// 1 hour between GC sweeps — matches bootstrap_history GC pattern
const BOOTSTRAP_AUDIT_GC_INTERVAL_MS = 3_600_000;

/**
 * Start a background interval that deletes bootstrap_audit rows older than
 * BOOTSTRAP_AUDIT_RETENTION_DAYS.
 *
 * When BOOTSTRAP_AUDIT_RETENTION_DAYS=0, GC is disabled (infinite retention).
 * Mirrors startToolJobPruneInterval from channel-runner.ts exactly.
 */
export function startBootstrapAuditGcInterval(): void {
  if (
    !Number.isFinite(BOOTSTRAP_AUDIT_RETENTION_DAYS) ||
    BOOTSTRAP_AUDIT_RETENTION_DAYS <= 0
  ) {
    logger.info(
      'bootstrap-audit GC disabled (BOOTSTRAP_AUDIT_RETENTION_DAYS=0)',
    );
    return;
  }
  setInterval(() => {
    try {
      pruneBootstrapAudit(BOOTSTRAP_AUDIT_RETENTION_DAYS);
    } catch (err) {
      logger.warn({ err }, 'bootstrap-audit GC interval iteration failed');
    }
  }, BOOTSTRAP_AUDIT_GC_INTERVAL_MS).unref();
}
