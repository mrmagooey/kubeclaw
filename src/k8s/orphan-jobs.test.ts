/**
 * Unit tests for reconcileOrphanedJobsOnStartup (Story 37).
 *
 * All external dependencies (K8s client, Redis publisher, DB queries) are
 * injected as fakes so these tests run without a live cluster or database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reconcileOrphanedJobsOnStartup,
  formatInterruptionNotice,
  type OrphanJobK8sClient,
  type OrphanJobPublisher,
} from './orphan-jobs.js';
import type { ToolJobRecord } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<ToolJobRecord> = {}): ToolJobRecord {
  return {
    job_id: 'nc-group1-abc123',
    group_folder: 'group1',
    chat_jid: 'http:alice',
    status: 'active',
    created_at: new Date().toISOString(),
    resolved_at: null,
    ...overrides,
  };
}

function makeK8sFake(): OrphanJobK8sClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deleteJob: vi.fn(async (jobName: string) => {
      calls.push(jobName);
    }),
  };
}

function makePublisherFake(): OrphanJobPublisher & {
  calls: Array<{ groupFolder: string; chatJid: string; text: string }>;
} {
  const calls: Array<{ groupFolder: string; chatJid: string; text: string }> =
    [];
  return {
    calls,
    publish: vi.fn(
      async (groupFolder: string, chatJid: string, text: string) => {
        calls.push({ groupFolder, chatJid, text });
      },
    ),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('formatInterruptionNotice', () => {
  it('contains "tool job interrupted" (case-insensitive)', () => {
    const notice = formatInterruptionNotice('nc-mygroup-abc123');
    expect(notice.toLowerCase()).toContain('tool job interrupted');
  });

  it('references the job ID', () => {
    const jobId = 'nc-mygroup-abc123';
    const notice = formatInterruptionNotice(jobId);
    expect(notice).toContain(jobId);
  });
});

describe('reconcileOrphanedJobsOnStartup', () => {
  let k8s: ReturnType<typeof makeK8sFake>;
  let publisher: ReturnType<typeof makePublisherFake>;
  let markedInterrupted: string[];

  beforeEach(() => {
    k8s = makeK8sFake();
    publisher = makePublisherFake();
    markedInterrupted = [];
  });

  it('no-ops when there are no active tool jobs', async () => {
    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => [],
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(publisher.calls).toHaveLength(0);
    expect(k8s.calls).toHaveLength(0);
    expect(markedInterrupted).toHaveLength(0);
  });

  it('publishes an interruption notice for each orphaned job', async () => {
    const orphans = [makeRecord(), makeRecord({ job_id: 'nc-group2-xyz999', group_folder: 'group2', chat_jid: 'http:bob' })];

    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[0].groupFolder).toBe('group1');
    expect(publisher.calls[0].chatJid).toBe('http:alice');
    expect(publisher.calls[0].text.toLowerCase()).toContain('tool job interrupted');
    expect(publisher.calls[1].groupFolder).toBe('group2');
    expect(publisher.calls[1].chatJid).toBe('http:bob');
  });

  it('calls deleteJob for each orphaned job', async () => {
    const orphans = [makeRecord({ job_id: 'nc-group1-aaa' }), makeRecord({ job_id: 'nc-group1-bbb' })];

    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(k8s.calls).toContain('nc-group1-aaa');
    expect(k8s.calls).toContain('nc-group1-bbb');
  });

  it('marks each orphaned job as interrupted in DB', async () => {
    const orphans = [makeRecord({ job_id: 'job-a' }), makeRecord({ job_id: 'job-b' })];

    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(markedInterrupted).toContain('job-a');
    expect(markedInterrupted).toContain('job-b');
  });

  it('marks DB row interrupted BEFORE publishing notice (idempotency)', async () => {
    const order: string[] = [];
    const jobId = 'nc-g1-abc';

    await reconcileOrphanedJobsOnStartup({
      k8s: {
        deleteJob: async () => {},
      },
      publisher: {
        publish: async () => {
          order.push('publish');
        },
      },
      getActiveJobs: () => [makeRecord({ job_id: jobId })],
      markInterrupted: (_id) => {
        order.push('markInterrupted');
      },
    });

    expect(order.indexOf('markInterrupted')).toBeLessThan(
      order.indexOf('publish'),
    );
  });

  it('continues reconciling remaining jobs when K8s delete fails', async () => {
    const failingK8s: OrphanJobK8sClient = {
      deleteJob: vi.fn().mockRejectedValue(new Error('K8s API error')),
    };
    const orphans = [makeRecord({ job_id: 'job-a' }), makeRecord({ job_id: 'job-b' })];

    await reconcileOrphanedJobsOnStartup({
      k8s: failingK8s,
      publisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    // Both jobs should still be marked and notices published despite K8s failure
    expect(markedInterrupted).toContain('job-a');
    expect(markedInterrupted).toContain('job-b');
    expect(publisher.calls).toHaveLength(2);
  });

  it('continues reconciling remaining jobs when publish fails', async () => {
    const failingPublisher: OrphanJobPublisher = {
      publish: vi.fn().mockRejectedValue(new Error('Redis error')),
    };
    const orphans = [makeRecord({ job_id: 'job-a' }), makeRecord({ job_id: 'job-b' })];

    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher: failingPublisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    // Both jobs should still be marked and K8s jobs deleted despite publish failure
    expect(markedInterrupted).toContain('job-a');
    expect(markedInterrupted).toContain('job-b');
    expect(k8s.calls).toContain('job-a');
    expect(k8s.calls).toContain('job-b');
  });

  it('skips all work when getActiveJobs throws', async () => {
    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => {
        throw new Error('DB error');
      },
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(publisher.calls).toHaveLength(0);
    expect(k8s.calls).toHaveLength(0);
  });

  it('skips individual job when markInterrupted throws', async () => {
    const orphans = [makeRecord({ job_id: 'job-bad' }), makeRecord({ job_id: 'job-good' })];
    let callCount = 0;

    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => orphans,
      markInterrupted: (id) => {
        callCount++;
        if (id === 'job-bad') throw new Error('DB write error');
        markedInterrupted.push(id);
      },
    });

    // job-bad should be skipped; job-good should proceed normally
    expect(markedInterrupted).not.toContain('job-bad');
    expect(markedInterrupted).toContain('job-good');
    // publish should be called for job-good but NOT job-bad
    const publishedGroups = publisher.calls.map((c) => c.chatJid);
    // job-bad used default chat_jid 'http:alice', job-good also uses 'http:alice'
    // We verify callCount is 2 (both attempted) and one succeeded
    expect(callCount).toBe(2);
    expect(publisher.calls).toHaveLength(1);
  });

  it('publishes notice text containing the job ID', async () => {
    const jobId = 'nc-special-job-999';
    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => [makeRecord({ job_id: jobId })],
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(publisher.calls[0].text).toContain(jobId);
  });

  it('is idempotent — second call with empty active list is a no-op', async () => {
    // First call processes one orphan
    await reconcileOrphanedJobsOnStartup({
      k8s,
      publisher,
      getActiveJobs: () => [makeRecord()],
      markInterrupted: (id) => markedInterrupted.push(id),
    });
    expect(publisher.calls).toHaveLength(1);

    // Reset fakes
    const k8s2 = makeK8sFake();
    const publisher2 = makePublisherFake();

    // Second call sees no active jobs (already marked interrupted)
    await reconcileOrphanedJobsOnStartup({
      k8s: k8s2,
      publisher: publisher2,
      getActiveJobs: () => [], // already resolved
      markInterrupted: (id) => markedInterrupted.push(id),
    });

    expect(publisher2.calls).toHaveLength(0);
    expect(k8s2.calls).toHaveLength(0);
  });
});
