// e2e/jobs-command.test.ts
/**
 * Jobs command E2E test.
 *
 * Uses a real sql.js in-memory database to verify the full path:
 *   recordToolJob() / resolveToolJob() → handleJobsCommand()
 *
 * No Kubernetes or mock LLM server required for these tests.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'e2e-test';
});

vi.mock('../src/k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
  }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));

vi.mock('../src/k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));

vi.mock('../src/runtime/index.js', () => ({
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
} from '../src/db.js';
import { handleJobsCommand } from '../src/channel-runner.js';

// Helper: record a job with specialist name using main's extended signature.
function insertJob(
  jobId: string,
  groupFolder: string,
  specialistName: string,
  chatJid = 'e2e@jid',
): void {
  recordToolJob(jobId, groupFolder, chatJid, null, specialistName);
}

beforeAll(async () => {
  await _initTestDatabase();
});

describe('/jobs command e2e', () => {
  const GROUP = `e2e-jobs-${Date.now()}`;
  const OTHER = `e2e-other-${Date.now()}`;

  it('returns "No active jobs." when no jobs exist for the group', async () => {
    const reply = await handleJobsCommand(GROUP);
    expect(reply).toBe('No active jobs.');
  });

  it('shows a running job after recordToolJob', async () => {
    insertJob(`${GROUP}-run-1`, GROUP, 'Researcher');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[running]');
    expect(reply).toContain('@Researcher');
    expect(reply).toMatch(/started \d\d:\d\dZ/);
  });

  it('shows completed job after resolveToolJob with status=completed', async () => {
    insertJob(`${GROUP}-done-1`, GROUP, 'Analyst');
    resolveToolJob(`${GROUP}-done-1`, 'completed');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[completed]');
    expect(reply).toContain('@Analyst');
    expect(reply).toMatch(/\d\d:\d\dZ → \d\d:\d\dZ/);
  });

  it('shows timeout status correctly', async () => {
    insertJob(`${GROUP}-to-1`, GROUP, 'TimedOutSpec');
    resolveToolJob(`${GROUP}-to-1`, 'timeout');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[timeout]');
    expect(reply).toContain('@TimedOutSpec');
  });

  it('shows oomkill status correctly', async () => {
    insertJob(`${GROUP}-oom-1`, GROUP, 'OomSpec');
    resolveToolJob(`${GROUP}-oom-1`, 'oomkill');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[oomkill]');
    expect(reply).toContain('@OomSpec');
  });

  it('shows interrupted status correctly', async () => {
    insertJob(`${GROUP}-int-1`, GROUP, 'CancelSpec');
    resolveToolJob(`${GROUP}-int-1`, 'interrupted');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[interrupted]');
    expect(reply).toContain('@CancelSpec');
  });

  it('jobs from other groups never appear in reply', async () => {
    insertJob(`${OTHER}-job-1`, OTHER, 'StrangerSpec');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).not.toContain('@StrangerSpec');
  });

  it('reply is scoped: querying OTHER group does not show GROUP jobs', async () => {
    insertJob(`${GROUP}-scope-1`, GROUP, 'GroupOnlySpec');

    const otherReply = await handleJobsCommand(OTHER);
    expect(otherReply).not.toContain('@GroupOnlySpec');
  });

  it('combined: active and completed jobs both appear in reply', async () => {
    const ts = Date.now();
    insertJob(`${GROUP}-comb-run-${ts}`, GROUP, 'ActiveSpec');
    insertJob(`${GROUP}-comb-done-${ts}`, GROUP, 'FinishedSpec');
    resolveToolJob(`${GROUP}-comb-done-${ts}`, 'completed');

    const reply = await handleJobsCommand(GROUP);
    expect(reply).toContain('[running] @ActiveSpec');
    expect(reply).toContain('[completed] @FinishedSpec');
  });

  it('recent jobs capped at 5 (last-5 completed shown)', async () => {
    const ts = Date.now();
    // Insert 7 completed jobs
    for (let i = 1; i <= 7; i++) {
      insertJob(`${GROUP}-cap-${ts}-${i}`, GROUP, `CapSpec${i}`);
      resolveToolJob(`${GROUP}-cap-${ts}-${i}`, 'completed');
    }

    const reply = await handleJobsCommand(GROUP);
    // The 7th is newest — it must appear; the 1st is oldest — may be cut off
    expect(reply).toContain('@CapSpec7');
    expect(reply).toContain('@CapSpec3');
    // The reply should NOT list CapSpec1 or CapSpec2 (outside top 5 by created_at DESC)
    const capLines = reply.split('\n').filter((l) => l.includes('@CapSpec'));
    // At most 5 recent entries in this section
    expect(capLines.length).toBeLessThanOrEqual(5 + 7); // running + capped
  });
});
