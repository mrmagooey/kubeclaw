// src/k8s/job-logs.integration.test.ts
//
// Integration tests for the /jobs <id> logs pipeline.
//
// These tests exercise multiple components together — the handleJobsCommand handler
// wired to a fake getJobLogs dep that enforces ownership via a fake DB lookup —
// without touching real K8s or Redis.
// They verify:
//  - ownership enforcement (wrong group → not found)
//  - GC'd pod detection (K8s returns "No pods found for job")
//  - truncation end-to-end through handleJobsCommand
//  - normal success path with real log lines

import { describe, it, expect, vi } from 'vitest';

// channel-runner.ts has a module-level guard that calls process.exit(1) when
// KUBECLAW_CHANNEL is not set. Hoist the env stub above the import.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import {
  handleJobsCommand,
  truncateLogs,
  MAX_LOG_LINES,
} from '../channel-runner.js';
import type { JobsCommandDeps } from '../channel-runner.js';

// ---------------------------------------------------------------------------
// Fake in-memory "DB" — mirrors the interface of getToolJobByIdForGroup.
// ---------------------------------------------------------------------------
interface FakeJobRow {
  jobId: string;
  groupFolder: string;
}

function fakeDb(
  rows: FakeJobRow[],
): (jobId: string, groupFolder: string) => FakeJobRow | undefined {
  return (jobId, groupFolder) =>
    rows.find((r) => r.jobId === jobId && r.groupFolder === groupFolder);
}

// ---------------------------------------------------------------------------
// Helper: build a JobsCommandDeps backed by the fake DB.
// ---------------------------------------------------------------------------
function buildDeps(
  rows: FakeJobRow[],
  logsResult: string | Error,
): JobsCommandDeps {
  const dbLookup = fakeDb(rows);
  return {
    getJobLogs: async (jobId: string, groupFolder: string) => {
      // Ownership check (mirrors what the orchestrator does via IPC)
      const row = dbLookup(jobId, groupFolder);
      if (!row) throw new Error('not_found');
      if (logsResult instanceof Error) throw logsResult;
      return logsResult;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('job-logs integration: ownership', () => {
  const rows: FakeJobRow[] = [{ jobId: 'job-abc', groupFolder: 'group-a' }];

  it('returns logs when group matches', async () => {
    const deps = buildDeps(rows, 'hello world');
    const reply = await handleJobsCommand(
      'group-a',
      '/jobs job-abc logs',
      deps,
    );
    expect(reply).toContain('hello world');
  });

  it('returns not-found for wrong group (AC 3)', async () => {
    const deps = buildDeps(rows, 'hello world');
    const reply = await handleJobsCommand(
      'group-b',
      '/jobs job-abc logs',
      deps,
    );
    expect(reply).toMatch(/not found/i);
    expect(reply).toContain('job-abc');
  });

  it('returns not-found for unknown job ID (AC 2)', async () => {
    const deps = buildDeps(rows, 'hello world');
    const reply = await handleJobsCommand(
      'group-a',
      '/jobs unknown-id logs',
      deps,
    );
    expect(reply).toMatch(/not found/i);
  });
});

describe("job-logs integration: GC'd pod (AC 4)", () => {
  const rows: FakeJobRow[] = [{ jobId: 'old-job', groupFolder: 'grp' }];

  it('"No pods found for job" → logs no longer available', async () => {
    const deps = buildDeps(rows, 'No pods found for job');
    const reply = await handleJobsCommand('grp', '/jobs old-job logs', deps);
    expect(reply).toMatch(/no longer available/i);
  });

  it('"Pod name not found" → logs no longer available', async () => {
    const deps = buildDeps(rows, 'Pod name not found');
    const reply = await handleJobsCommand('grp', '/jobs old-job logs', deps);
    expect(reply).toMatch(/no longer available/i);
  });
});

describe('job-logs integration: AC 5 — stdout+stderr lines visible in reply', () => {
  const rows: FakeJobRow[] = [{ jobId: 'job-abc', groupFolder: 'grp' }];

  it('reply contains both log lines', async () => {
    const deps = buildDeps(rows, 'stderr line\nstdout line');
    const reply = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(reply).toContain('stderr line');
    expect(reply).toContain('stdout line');
  });
});

describe('job-logs integration: truncation', () => {
  const rows: FakeJobRow[] = [{ jobId: 'big-job', groupFolder: 'grp' }];

  it('truncates long logs at MAX_LOG_LINES', async () => {
    const longLog = Array.from(
      { length: MAX_LOG_LINES + 15 },
      (_, i) => `line-${i}`,
    ).join('\n');
    const deps = buildDeps(rows, longLog);
    const reply = await handleJobsCommand('grp', '/jobs big-job logs', deps);
    expect(reply).toContain('earlier lines omitted');
    // The very last line should still be present
    expect(reply).toContain(`line-${MAX_LOG_LINES + 14}`);
    // The first line should NOT be present (was truncated)
    expect(reply).not.toContain('line-0\n');
  });

  it('truncateLogs alone: preserves content under the limit', () => {
    const short = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n');
    expect(truncateLogs(short)).toBe(short);
  });
});
