/**
 * bootstrap-audit.test.ts — Story 184 unit/integration tests
 *
 * Covers:
 *   AC1 — bootstrap_audit table and indexes exist after schema init
 *   AC2 — start + terminal rows inserted, no UPDATE ever issued
 *   AC3 — queryBootstrapAudit filter/limit composition and cap
 *   AC5 — pruneBootstrapAudit retention boundary and disabled-GC no-op
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, __resetDbForTest, db } from '../../db.js';
import {
  insertBootstrapAuditRow,
  queryBootstrapAudit,
  pruneBootstrapAudit,
  type BootstrapAuditOutcome,
} from './bootstrap-audit.js';

beforeEach(async () => {
  await _initTestDatabase();
  __resetDbForTest();
});

// ─── AC1: schema ─────────────────────────────────────────────────────────────

describe('AC1: bootstrap_audit schema', () => {
  it('creates the bootstrap_audit table', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='bootstrap_audit'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].values[0][0]).toBe('bootstrap_audit');
  });

  it('creates bootstrap_audit_by_type index', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='bootstrap_audit_by_type'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].values[0][0]).toBe('bootstrap_audit_by_type');
  });

  it('creates bootstrap_audit_by_outcome index', () => {
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='bootstrap_audit_by_outcome'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].values[0][0]).toBe('bootstrap_audit_by_outcome');
  });

  it('getDiagSnapshot still returns exactly 7 keys (bootstrap_audit_rows must NOT be added)', async () => {
    const { getDiagSnapshot } = await import('../../db.js');
    const snap = getDiagSnapshot('test-group', '/tmp/nonexistent');
    expect(Object.keys(snap)).toHaveLength(7);
  });
});

// ─── AC2: insert pattern ──────────────────────────────────────────────────────

const BASE_ARGS = {
  bootstrapJobId: 'job-abc-123',
  adminIdentity: 'alice',
  adminSessionId: 'sess-uuid-1',
  channelType: 'telegram',
  instanceName: 'my-telegram',
  skillName: 'telegram-standard',
  skillContentHash: 'a'.repeat(64),
  manifestHashRequested: 'b'.repeat(64),
  manifestHashObserved: null as string | null,
};

describe('AC2: two-row append-only pattern', () => {
  it('inserts a start row with outcome in-progress and all fields present', () => {
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: new Date().toISOString(),
      outcome: 'in-progress',
    });
    const rows = queryBootstrapAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('in-progress');
    expect(rows[0].bootstrap_job_id).toBe('job-abc-123');
    expect(rows[0].admin_identity).toBe('alice');
    expect(rows[0].admin_session_id).toBe('sess-uuid-1');
    expect(rows[0].skill_content_hash).toBe('a'.repeat(64));
    expect(rows[0].manifest_hash_requested).toBe('b'.repeat(64));
    expect(rows[0].manifest_hash_observed).toBeNull();
    expect(rows[0].duration_seconds).toBeNull();
  });

  it('inserts start then terminal row — exactly 2 rows for same job, no UPDATE', () => {
    const startedAt = new Date().toISOString();
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: startedAt,
      outcome: 'in-progress',
    });

    const terminalAt = new Date(Date.now() + 42_000).toISOString();
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: terminalAt,
      outcome: 'succeeded',
      manifestHashObserved: 'c'.repeat(64),
      durationSeconds: 42,
    });

    const all = queryBootstrapAudit({ limit: 500 });
    const forJob = all.filter((r) => r.bootstrap_job_id === 'job-abc-123');
    expect(forJob).toHaveLength(2);

    const terminal = forJob.find((r) => r.outcome === 'succeeded')!;
    expect(terminal).toBeDefined();
    expect(terminal.manifest_hash_observed).toBe('c'.repeat(64));
    expect(terminal.duration_seconds).toBe(42);

    // Both rows must be present as separate inserts (prove no UPDATE was used)
    const start = forJob.find((r) => r.outcome === 'in-progress')!;
    expect(start).toBeDefined();
    expect(start.audit_id).not.toBe(terminal.audit_id);
  });

  it('never overwrites rows — two inserts yield two distinct rows', () => {
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: new Date().toISOString(),
      outcome: 'in-progress',
    });
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: new Date().toISOString(),
      outcome: 'timed-out',
    });

    const rows = queryBootstrapAudit({ limit: 500 });
    expect(rows).toHaveLength(2);
    const outcomes = rows.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['in-progress', 'timed-out']);
  });

  it('insertBootstrapAuditRow does not throw when db write fails', () => {
    const originalRun = (db as unknown as { run: (...args: unknown[]) => unknown }).run.bind(db);
    (db as unknown as { run: (...args: unknown[]) => unknown }).run = () => {
      throw new Error('simulated DB failure');
    };
    try {
      expect(() =>
        insertBootstrapAuditRow({
          ...BASE_ARGS,
          recordedAt: new Date().toISOString(),
          outcome: 'in-progress',
        }),
      ).not.toThrow();
    } finally {
      (db as unknown as { run: (...args: unknown[]) => unknown }).run = originalRun;
    }
  });

  it('admin_session_id can be null (direct POST /tool without SSE)', () => {
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      adminSessionId: null,
      recordedAt: new Date().toISOString(),
      outcome: 'in-progress',
    });
    const rows = queryBootstrapAudit();
    expect(rows[0].admin_session_id).toBeNull();
  });

  it('all outcome values are accepted by insertBootstrapAuditRow', () => {
    const outcomes: BootstrapAuditOutcome[] = [
      'in-progress',
      'succeeded',
      'timed-out',
      'manifest-divergence',
      'rejected',
      'error',
    ];
    for (const outcome of outcomes) {
      insertBootstrapAuditRow({
        bootstrapJobId: `job-${outcome}`,
        adminIdentity: 'op',
        adminSessionId: null,
        channelType: 'telegram',
        instanceName: 'inst',
        skillName: 'skill',
        skillContentHash: 'x'.repeat(64),
        manifestHashRequested: 'y'.repeat(64),
        manifestHashObserved: null,
        recordedAt: new Date().toISOString(),
        outcome,
      });
    }
    const rows = queryBootstrapAudit({ limit: 500 });
    expect(rows).toHaveLength(6);
  });
});

// ─── AC3: query filter/limit ──────────────────────────────────────────────────

describe('AC3: queryBootstrapAudit filter composition', () => {
  function seedRow(
    jobId: string,
    channelType: string,
    outcome: BootstrapAuditOutcome,
    recordedAt: string,
  ): void {
    insertBootstrapAuditRow({
      bootstrapJobId: jobId,
      recordedAt,
      adminIdentity: 'operator',
      adminSessionId: null,
      channelType,
      instanceName: jobId,
      skillName: 'base-skill',
      skillContentHash: 'f'.repeat(64),
      manifestHashRequested: 'e'.repeat(64),
      manifestHashObserved: null,
      outcome,
    });
  }

  it('returns all rows when no filters, ordered recorded_at DESC', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    seedRow('j1', 'telegram', 'succeeded', t1);
    seedRow('j2', 'discord', 'error', t2);

    const rows = queryBootstrapAudit();
    expect(rows).toHaveLength(2);
    expect(rows[0].bootstrap_job_id).toBe('j2'); // newer first
    expect(rows[1].bootstrap_job_id).toBe('j1');
  });

  it('filters by channelType', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    seedRow('j2', 'discord', 'succeeded', '2026-01-02T00:00:00.000Z');

    const rows = queryBootstrapAudit({ channelType: 'telegram' });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('telegram');
  });

  it('filters by outcome', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    seedRow('j2', 'telegram', 'timed-out', '2026-01-02T00:00:00.000Z');

    const rows = queryBootstrapAudit({ outcome: 'timed-out' });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('timed-out');
  });

  it('filters by since (only rows at or after the boundary are returned)', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T12:00:00.000Z');
    seedRow('j2', 'telegram', 'succeeded', '2026-01-03T12:00:00.000Z');

    const rows = queryBootstrapAudit({ since: '2026-01-02T00:00:00.000Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].bootstrap_job_id).toBe('j2');
  });

  it('composes channelType + outcome filters with AND', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    seedRow('j2', 'telegram', 'error', '2026-01-02T00:00:00.000Z');
    seedRow('j3', 'discord', 'succeeded', '2026-01-03T00:00:00.000Z');

    const rows = queryBootstrapAudit({
      channelType: 'telegram',
      outcome: 'succeeded',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].bootstrap_job_id).toBe('j1');
  });

  it('enforces default limit of 50 when no limit provided', () => {
    for (let i = 0; i < 60; i++) {
      seedRow(
        `j${i}`,
        'telegram',
        'succeeded',
        `2026-01-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      );
    }
    const rows = queryBootstrapAudit();
    expect(rows).toHaveLength(50);
  });

  it('caps limit at 500 even when caller passes limit: 1000', () => {
    for (let i = 0; i < 510; i++) {
      seedRow(`job-${i}`, 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    }
    const rows = queryBootstrapAudit({ limit: 1000 });
    expect(rows.length).toBeLessThanOrEqual(500);
  });

  it('returns all columns including audit_id as a number', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    const rows = queryBootstrapAudit();
    const row = rows[0];
    expect(row).toHaveProperty('audit_id');
    expect(typeof row.audit_id).toBe('number');
    expect(row).toHaveProperty('bootstrap_job_id');
    expect(row).toHaveProperty('recorded_at');
    expect(row).toHaveProperty('admin_identity');
    expect(row).toHaveProperty('admin_session_id');
    expect(row).toHaveProperty('channel_type');
    expect(row).toHaveProperty('instance_name');
    expect(row).toHaveProperty('skill_name');
    expect(row).toHaveProperty('skill_content_hash');
    expect(row).toHaveProperty('manifest_hash_requested');
    expect(row).toHaveProperty('manifest_hash_observed');
    expect(row).toHaveProperty('outcome');
    expect(row).toHaveProperty('error_code');
    expect(row).toHaveProperty('error_message');
    expect(row).toHaveProperty('duration_seconds');
  });

  it('returns empty array when no rows match filters', () => {
    seedRow('j1', 'telegram', 'succeeded', '2026-01-01T00:00:00.000Z');
    const rows = queryBootstrapAudit({ channelType: 'discord' });
    expect(rows).toHaveLength(0);
  });
});

// ─── AC5: GC ──────────────────────────────────────────────────────────────────

describe('AC5: pruneBootstrapAudit GC', () => {
  it('deletes rows older than retention window and returns count', () => {
    // Insert a row 25 hours in the past (exceeds 1-day retention)
    const oldAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: oldAt,
      outcome: 'succeeded',
    });

    const deleted = pruneBootstrapAudit(1);
    expect(deleted).toBe(1);
    expect(queryBootstrapAudit({ limit: 500 })).toHaveLength(0);
  });

  it('does not delete rows within the retention window', () => {
    const recentAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: recentAt,
      outcome: 'succeeded',
    });

    const deleted = pruneBootstrapAudit(1);
    expect(deleted).toBe(0);
    expect(queryBootstrapAudit({ limit: 500 })).toHaveLength(1);
  });

  it('returns 0 and deletes nothing when retentionDays=0 (infinite retention)', () => {
    const oldAt = new Date(
      Date.now() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString();
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: oldAt,
      outcome: 'succeeded',
    });

    const deleted = pruneBootstrapAudit(0);
    expect(deleted).toBe(0);
    expect(queryBootstrapAudit({ limit: 500 })).toHaveLength(1);
  });

  it('returns 0 for negative retentionDays', () => {
    const oldAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      recordedAt: oldAt,
      outcome: 'succeeded',
    });
    const deleted = pruneBootstrapAudit(-5);
    expect(deleted).toBe(0);
  });

  it('deletes only rows exceeding retention, leaves newer rows intact', () => {
    const oldAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 2 days old
    const recentAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min old

    insertBootstrapAuditRow({
      ...BASE_ARGS,
      bootstrapJobId: 'old-job',
      recordedAt: oldAt,
      outcome: 'succeeded',
    });
    insertBootstrapAuditRow({
      ...BASE_ARGS,
      bootstrapJobId: 'new-job',
      recordedAt: recentAt,
      outcome: 'succeeded',
    });

    const deleted = pruneBootstrapAudit(1); // 1 day retention
    expect(deleted).toBe(1);
    const remaining = queryBootstrapAudit({ limit: 500 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].bootstrap_job_id).toBe('new-job');
  });
});
