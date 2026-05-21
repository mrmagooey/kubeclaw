/**
 * Integration tests for pruneOldToolJobs (Story 55).
 *
 * Uses a real in-memory SQLite database via _initTestDatabase and the actual
 * recordToolJob / resolveToolJob / pruneOldToolJobs code paths. No stubs.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  db,
  recordToolJob,
  resolveToolJob,
  getActiveToolJobs,
  pruneOldToolJobs,
} from '../db.js';

beforeEach(async () => {
  await _initTestDatabase();
});

// Helper: back-date a resolved_at timestamp by the given number of days.
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

// Helper: directly set the resolved_at of a job to a past date so we can
// exercise the prune window without having to wait real time.
function backDateResolvedAt(jobId: string, resolvedAt: string): void {
  db.run(`UPDATE tool_jobs SET resolved_at = ? WHERE job_id = ?`, [
    resolvedAt,
    jobId,
  ]);
}

describe('pruneOldToolJobs — integration', () => {
  it('prunes all resolved rows when retentionDays=0 is disabled (no-op)', async () => {
    recordToolJob('j1', 'grp1', 'jid@test');
    resolveToolJob('j1', 'completed');
    backDateResolvedAt('j1', daysAgo(5));

    const deleted = pruneOldToolJobs(0);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(1);
  });

  it('after pruneOldToolJobs(0), only active rows remain when called with >0', async () => {
    // Seed: 2 resolved (via real flow), 1 active
    recordToolJob('resolved-1', 'grp1', 'jid@test');
    resolveToolJob('resolved-1', 'completed');
    backDateResolvedAt('resolved-1', daysAgo(10));

    recordToolJob('resolved-2', 'grp1', 'jid@test');
    resolveToolJob('resolved-2', 'timeout');
    backDateResolvedAt('resolved-2', daysAgo(5));

    recordToolJob('active-job', 'grp1', 'jid@test');
    // active-job is intentionally NOT resolved — stays active

    // prune with 1 day retention — both resolved rows are older than 1 day
    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(2);

    const remaining = getActiveToolJobs();
    expect(remaining.length).toBe(1);
    expect(remaining[0].job_id).toBe('active-job');
    expect(remaining[0].status).toBe('active');
  });

  it('active rows are never pruned regardless of how old they are', async () => {
    recordToolJob('active-ancient', 'grp1', 'jid@test');
    // Force a very old created_at but leave status = active
    db.run(
      `UPDATE tool_jobs SET created_at = datetime('now', '-365 days') WHERE job_id = 'active-ancient'`,
    );

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(0);
    const active = getActiveToolJobs();
    expect(active.length).toBe(1);
    expect(active[0].job_id).toBe('active-ancient');
  });

  it('rows resolved within the retention window are left untouched', async () => {
    recordToolJob('recent-job', 'grp2', 'jid@test');
    resolveToolJob('recent-job', 'completed');
    // resolved_at = 2 hours ago — within 1 day retention
    backDateResolvedAt('recent-job', new Date(Date.now() - 2 * 3600_000).toISOString());

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(1);
  });

  it('cross-group: only prunes rows older than window across all groups', async () => {
    // group A: old resolved
    recordToolJob('ga-old', 'group-a', 'jid@a');
    resolveToolJob('ga-old', 'completed');
    backDateResolvedAt('ga-old', daysAgo(7));

    // group B: recent resolved (protected)
    recordToolJob('gb-new', 'group-b', 'jid@b');
    resolveToolJob('gb-new', 'interrupted');
    backDateResolvedAt('gb-new', daysAgo(0)); // today

    // group C: active (never pruned)
    recordToolJob('gc-active', 'group-c', 'jid@c');

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(1); // only ga-old

    const remaining = db.exec(
      `SELECT job_id FROM tool_jobs ORDER BY job_id`,
    );
    const ids = remaining[0].values.map((r) => r[0] as string);
    expect(ids).toContain('gb-new');
    expect(ids).toContain('gc-active');
    expect(ids).not.toContain('ga-old');
  });
});
