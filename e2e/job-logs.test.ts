// e2e/job-logs.test.ts
/**
 * Job-logs E2E test.
 *
 * Uses a real sql.js in-memory database to verify the full ownership + lookup
 * pipeline:
 *   storeToolJob() → getToolJobByIdForGroup() → handleJobsCommand()
 *
 * No Kubernetes, Redis, or mock LLM server required.
 * Namespace: kubeclaw-e2e-job-logs   Port: 14142
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// channel-runner.ts has a module-level guard that calls process.exit(1) when
// KUBECLAW_CHANNEL is not set. Hoist the env stub above the import.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import {
  _initTestDatabase,
  __resetDbForTest,
  storeToolJob,
  getToolJobByIdForGroup,
} from '../src/db.js';
import {
  handleJobsCommand,
  JOBS_HELP,
} from '../src/channel-runner.js';
import type { JobsCommandDeps } from '../src/channel-runner.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await _initTestDatabase();
});

function makeLogsDeps(
  logsMap: Record<string, string | Error>,
): JobsCommandDeps {
  return {
    getJobLogs: async (jobId: string, groupFolder: string) => {
      const row = getToolJobByIdForGroup(jobId, groupFolder);
      if (!row) throw new Error('not_found');
      const result = logsMap[jobId];
      if (result === undefined) throw new Error('not_found');
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('job-logs e2e: happy path (AC 1)', () => {
  it('returns log lines for a completed job', async () => {
    __resetDbForTest();
    storeToolJob('e2e-job-1', 'grp-alpha');

    const deps = makeLogsDeps({ 'e2e-job-1': 'INFO starting\nINFO done' });
    const reply = await handleJobsCommand('grp-alpha', '/jobs e2e-job-1 logs', deps);

    expect(reply).toContain('INFO starting');
    expect(reply).toContain('INFO done');
  });
});

describe('job-logs e2e: unknown ID returns not-found (AC 2)', () => {
  it('returns not-found for a job that was never stored', async () => {
    __resetDbForTest();

    const deps = makeLogsDeps({});
    const reply = await handleJobsCommand('grp-alpha', '/jobs no-such-job logs', deps);

    expect(reply).toMatch(/not found/i);
  });
});

describe('job-logs e2e: group ownership enforced (AC 3)', () => {
  it('does not reveal logs to a different group', async () => {
    __resetDbForTest();
    storeToolJob('shared-job', 'group-owner');

    // group-other has no row for shared-job
    const deps = makeLogsDeps({ 'shared-job': 'secret output' });
    const reply = await handleJobsCommand('group-other', '/jobs shared-job logs', deps);

    expect(reply).toMatch(/not found/i);
    expect(reply).not.toContain('secret output');
  });
});

describe("job-logs e2e: GC'd pod (AC 4)", () => {
  it('returns "logs no longer available" when K8s reports no pods', async () => {
    __resetDbForTest();
    storeToolJob('old-job', 'grp-gc');

    const deps = makeLogsDeps({ 'old-job': 'No pods found for job' });
    const reply = await handleJobsCommand('grp-gc', '/jobs old-job logs', deps);

    expect(reply).toMatch(/no longer available/i);
  });
});

describe('job-logs e2e: help subcommand', () => {
  it('/jobs help returns JOBS_HELP', async () => {
    const deps = makeLogsDeps({});
    const reply = await handleJobsCommand('grp', '/jobs help', deps);
    expect(reply).toBe(JOBS_HELP);
  });

  it('/jobs with no subcommand returns job listing (not JOBS_HELP)', async () => {
    __resetDbForTest();
    const deps = makeLogsDeps({});
    const reply = await handleJobsCommand('grp', '/jobs', deps);
    // The default (no-subcommand) path returns the active/recent listing
    expect(reply).toBe('No active jobs.');
  });
});

describe('job-logs e2e: storeToolJob + getToolJobByIdForGroup contract', () => {
  it('stored job is findable by correct group', () => {
    __resetDbForTest();
    storeToolJob('my-job', 'my-grp');
    const row = getToolJobByIdForGroup('my-job', 'my-grp');
    expect(row).not.toBeNull();
    expect(row?.job_id).toBe('my-job');
    expect(row?.group_folder).toBe('my-grp');
  });

  it('stored job is NOT findable by wrong group', () => {
    __resetDbForTest();
    storeToolJob('my-job', 'my-grp');
    const row = getToolJobByIdForGroup('my-job', 'other-grp');
    expect(row).toBeNull();
  });

  it('INSERT OR IGNORE: duplicate store does not throw', () => {
    __resetDbForTest();
    expect(() => {
      storeToolJob('dup-job', 'grp');
      storeToolJob('dup-job', 'grp');
    }).not.toThrow();
  });
});
