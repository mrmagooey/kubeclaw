/**
 * Integration tests for the /jobs slash command.
 *
 * Uses a real in-memory SQLite database (via _initTestDatabase) and the actual
 * recordToolJob / resolveToolJob / handleJobsCommand code paths.  No stubs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'integration-test';
});

// channel-runner imports redis-client which tries to connect at import time.
// Mock the redis client to prevent connection errors in integration tests.
vi.mock('../k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
  }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));

vi.mock('../k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));

vi.mock('../runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn().mockReturnValue({
    setChannelMetrics: vi.fn(),
    registerLocalTool: vi.fn(),
  }),
  shutdownAllRunners: vi.fn(),
}));

import {
  _initTestDatabase,
  recordToolJob,
  resolveToolJob,
  getActiveToolJobs,
  getRecentToolJobsForGroup,
} from '../db.js';
import { handleJobsCommand } from '../channel-runner.js';

// Helper: record a tool job with a specialist name using the full signature.
// specialistName is passed as the 5th argument (optional in main's schema).
function insertJob(
  jobId: string,
  groupFolder: string,
  specialistName: string,
  chatJid = 'test@jid',
): void {
  recordToolJob(jobId, groupFolder, chatJid, null, specialistName);
}

beforeEach(async () => {
  await _initTestDatabase();
});

describe('/jobs integration — recordToolJob + resolveToolJob + handleJobsCommand', () => {
  const GROUP = 'int-test-group';
  const OTHER = 'other-group';

  it('returns "No active jobs." when table is empty', () => {
    const reply = handleJobsCommand(GROUP);
    expect(reply).toBe('No active jobs.');
  });

  it('shows a running job for the correct group', () => {
    insertJob('job-1', GROUP, 'CodeReview');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[running]');
    expect(reply).toContain('@CodeReview');
    expect(reply).toMatch(/started \d\d:\d\dZ/);
  });

  it('completed job shows correct status label', () => {
    insertJob('job-2', GROUP, 'DocWriter');
    resolveToolJob('job-2', 'completed');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[completed]');
    expect(reply).toContain('@DocWriter');
    expect(reply).toMatch(/\d\d:\d\dZ → \d\d:\d\dZ/);
  });

  it('timeout status renders correctly', () => {
    insertJob('job-3', GROUP, 'SlowSpec');
    resolveToolJob('job-3', 'timeout');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[timeout]');
    expect(reply).toContain('@SlowSpec');
  });

  it('oomkill status renders correctly', () => {
    insertJob('job-4', GROUP, 'HeavySpec');
    resolveToolJob('job-4', 'oomkill');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[oomkill]');
    expect(reply).toContain('@HeavySpec');
  });

  it('interrupted status renders correctly', () => {
    insertJob('job-5', GROUP, 'CancelledSpec');
    resolveToolJob('job-5', 'interrupted');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[interrupted]');
    expect(reply).toContain('@CancelledSpec');
  });

  it('jobs from other groups are never shown', () => {
    insertJob('job-mine', GROUP, 'MySpec');
    insertJob('job-other', OTHER, 'OtherSpec');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('@MySpec');
    expect(reply).not.toContain('@OtherSpec');
  });

  it('getRecentToolJobsForGroup returns at most limit rows ordered DESC', () => {
    // Insert 7 completed jobs for GROUP
    for (let i = 1; i <= 7; i++) {
      insertJob(`bulk-job-${i}`, GROUP, `Spec${i}`);
      resolveToolJob(`bulk-job-${i}`, 'completed');
    }

    const recent = getRecentToolJobsForGroup(GROUP, 5);
    expect(recent).toHaveLength(5);
    // Should be newest-first: bulk-job-7 first, bulk-job-3 last
    expect(recent[0].job_id).toBe('bulk-job-7');
    expect(recent[4].job_id).toBe('bulk-job-3');
  });

  it('running jobs do not appear in getRecentToolJobsForGroup', () => {
    insertJob('active-job', GROUP, 'ActiveSpec');
    // Do NOT resolve it

    const recent = getRecentToolJobsForGroup(GROUP, 5);
    expect(recent.find((j) => j.job_id === 'active-job')).toBeUndefined();
  });

  it('getActiveToolJobs returns all running jobs across groups', () => {
    insertJob('g1-job', GROUP, 'SpecA');
    insertJob('g2-job', OTHER, 'SpecB');
    resolveToolJob('g2-job', 'completed');

    const active = getActiveToolJobs();
    expect(active.some((j) => j.job_id === 'g1-job')).toBe(true);
    // g2-job is resolved — must not appear in active list
    expect(active.some((j) => j.job_id === 'g2-job')).toBe(false);
  });

  it('mixed active and completed: reply lists both sections', () => {
    insertJob('r-job', GROUP, 'RunningSpec');
    insertJob('c-job', GROUP, 'DoneSpec');
    resolveToolJob('c-job', 'completed');

    const reply = handleJobsCommand(GROUP);
    expect(reply).toContain('[running] @RunningSpec');
    expect(reply).toContain('[completed] @DoneSpec');
  });
});
