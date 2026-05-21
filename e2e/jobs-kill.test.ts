// e2e/jobs-kill.test.ts
/**
 * Jobs-kill E2E test (Story 66).
 *
 * Uses a real sql.js in-memory database to verify the full ownership + lookup
 * pipeline for /jobs <id> kill:
 *   storeToolJob() (active row) → handleJobsCommand() → killJob dep
 *
 * The killJob dep mirrors the orchestrator's extended job.cancel IPC handler:
 *   - getToolJobByIdForGroup() enforced BEFORE any K8s call.
 *   - Active row for requesting group → "Cancelled job `<id>`"
 *   - Already-resolved row → "Job `<id>` is not active (status: <s>)"
 *   - Cross-group or unknown id → "Job not found"
 *
 * No Kubernetes, Redis, or mock LLM server required.
 * Namespace: kubeclaw-e2e-jobs-kill   Port: 14149
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
  resolveToolJob,
} from '../src/db.js';
import {
  handleJobsCommand,
  JOBS_HELP,
  HELP_TEXT,
} from '../src/channel-runner.js';
import type { JobsCommandDeps } from '../src/channel-runner.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await _initTestDatabase();
});

// ── Fake killJob dep (mirrors orchestrator's extended job.cancel IPC handler) ─

/**
 * Build a JobsCommandDeps whose killJob performs the same ownership check as
 * the orchestrator's extended job.cancel IPC handler:
 *   getToolJobByIdForGroup(jobId, groupFolder) → not found  → "Job not found"
 *   row.status !== 'active'                                → not_active reply
 *   row.status === 'active'                               → "Cancelled job `<id>`"
 *
 * A stop action map tracks which job ids were "stopped" (K8s call stand-in).
 */
function makeKillDeps(
  stoppedJobs: Set<string>,
): JobsCommandDeps {
  return {
    getJobLogs: vi.fn().mockRejectedValue(new Error('not_found')),
    killJob: async (jobId: string, groupFolder: string): Promise<string> => {
      // Ownership check — mirrors orchestrator
      const row = getToolJobByIdForGroup(jobId, groupFolder);
      if (!row) return 'Job not found';
      if (row.status !== 'active')
        return `Job \`${jobId}\` is not active (status: ${row.status})`;
      // "Stop" the job (stand-in for K8s delete)
      stoppedJobs.add(jobId);
      return `Cancelled job \`${jobId}\``;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('jobs-kill e2e: AC1 — active job for this group', () => {
  it('returns confirmation and killJob is invoked', async () => {
    __resetDbForTest();
    storeToolJob('e2e-kill-1', 'grp-alpha');

    const stopped = new Set<string>();
    const deps = makeKillDeps(stopped);

    const reply = await handleJobsCommand(
      'grp-alpha',
      '/jobs e2e-kill-1 kill',
      deps,
    );

    expect(reply).toBe('Cancelled job `e2e-kill-1`');
    expect(stopped.has('e2e-kill-1')).toBe(true);
  });
});

describe('jobs-kill e2e: AC2 — already-resolved job', () => {
  it('returns not-active with current status', async () => {
    __resetDbForTest();
    storeToolJob('e2e-kill-2', 'grp-beta');
    // Resolve the job so its status changes to 'completed'
    resolveToolJob('e2e-kill-2', 'completed');

    const stopped = new Set<string>();
    const deps = makeKillDeps(stopped);

    const reply = await handleJobsCommand(
      'grp-beta',
      '/jobs e2e-kill-2 kill',
      deps,
    );

    expect(reply).toContain('not active');
    expect(reply).toContain('completed');
    expect(stopped.has('e2e-kill-2')).toBe(false);
  });
});

describe('jobs-kill e2e: AC3 — job belongs to another group', () => {
  it('returns "Job not found" for cross-group request', async () => {
    __resetDbForTest();
    storeToolJob('e2e-kill-3', 'grp-owner');

    const stopped = new Set<string>();
    const deps = makeKillDeps(stopped);

    const reply = await handleJobsCommand(
      'grp-attacker',    // not the owning group
      '/jobs e2e-kill-3 kill',
      deps,
    );

    expect(reply).toBe('Job not found');
    expect(stopped.has('e2e-kill-3')).toBe(false);
  });
});

describe('jobs-kill e2e: AC4 — unknown job id', () => {
  it('returns "Job not found" for unknown id', async () => {
    __resetDbForTest();

    const stopped = new Set<string>();
    const deps = makeKillDeps(stopped);

    const reply = await handleJobsCommand(
      'grp-alpha',
      '/jobs completely-unknown-id kill',
      deps,
    );

    expect(reply).toBe('Job not found');
    expect(stopped.size).toBe(0);
  });
});

describe('jobs-kill e2e: help text', () => {
  it('JOBS_HELP contains /jobs <id> kill', () => {
    expect(JOBS_HELP).toContain('/jobs <id> kill');
  });

  it('HELP_TEXT contains /jobs <id> kill', () => {
    expect(HELP_TEXT).toContain('/jobs <id> kill');
  });
});

describe('jobs-kill e2e: DB isolation — multiple groups', () => {
  it('each group can only cancel its own jobs', async () => {
    __resetDbForTest();
    storeToolJob('job-group-a', 'grp-a');
    storeToolJob('job-group-b', 'grp-b');

    const stoppedA = new Set<string>();
    const stoppedB = new Set<string>();
    const depsA = makeKillDeps(stoppedA);
    const depsB = makeKillDeps(stoppedB);

    // grp-a tries to kill grp-b's job — should fail
    const replyAtoB = await handleJobsCommand('grp-a', '/jobs job-group-b kill', depsA);
    expect(replyAtoB).toBe('Job not found');
    expect(stoppedA.size).toBe(0);

    // grp-a kills its own job — should succeed
    const replyAtoA = await handleJobsCommand('grp-a', '/jobs job-group-a kill', depsA);
    expect(replyAtoA).toBe('Cancelled job `job-group-a`');
    expect(stoppedA.has('job-group-a')).toBe(true);

    // grp-b kills its own job — should succeed
    const replyBtoB = await handleJobsCommand('grp-b', '/jobs job-group-b kill', depsB);
    expect(replyBtoB).toBe('Cancelled job `job-group-b`');
    expect(stoppedB.has('job-group-b')).toBe(true);
  });
});
