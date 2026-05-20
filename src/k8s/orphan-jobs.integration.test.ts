/**
 * Integration tests for orphaned tool-job reconciliation (Story 37).
 *
 * These tests use a real in-process SQLite database (via _initTestDatabase)
 * and a fake K8s client + Redis publisher so they run without a live cluster.
 * They verify that the DB read/write paths and the reconciliation logic work
 * end-to-end when wired together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  recordToolJob,
  resolveToolJob,
  getActiveToolJobs,
  __resetDbForTest,
} from '../db.js';
import {
  reconcileOrphanedJobsOnStartup,
  type OrphanJobK8sClient,
  type OrphanJobPublisher,
} from './orphan-jobs.js';

// ── Setup ──────────────────────────────────────────────────────────────────

// Initialise DB once for the entire suite
await _initTestDatabase();

// ── Helpers ────────────────────────────────────────────────────────────────

function makeK8sFake(): OrphanJobK8sClient & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    deleteJob: vi.fn(async (jobName: string) => {
      deleted.push(jobName);
    }),
  };
}

function makePublisherFake(): OrphanJobPublisher & {
  published: Array<{ groupFolder: string; chatJid: string; text: string; noticeId: string }>;
} {
  const published: Array<{
    groupFolder: string;
    chatJid: string;
    text: string;
    noticeId: string;
  }> = [];
  return {
    published,
    publish: vi.fn(
      async (groupFolder: string, chatJid: string, text: string, noticeId: string) => {
        published.push({ groupFolder, chatJid, text, noticeId });
      },
    ),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('orphan-jobs integration', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('detects a seeded active job and emits an interruption notice', async () => {
    const jobId = 'nc-testgroup-int001';
    const groupFolder = 'testgroup';
    const chatJid = 'http:integrationuser';

    // Seed: simulate an active tool job as if the previous orchestrator wrote it
    recordToolJob(jobId, groupFolder, chatJid);

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    // Publisher must have been called with the correct routing info
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].groupFolder).toBe(groupFolder);
    expect(publisher.published[0].chatJid).toBe(chatJid);
    expect(publisher.published[0].text.toLowerCase()).toContain(
      'tool job interrupted',
    );
    // No messageId set — falls back to job ID
    expect(publisher.published[0].text).toContain(jobId);
    // noticeId is provided for channel-side persistence (AC4)
    expect(publisher.published[0].noticeId).toBeTruthy();
  });

  it('AC2: notice references user-facing messageId when recordToolJob includes it', async () => {
    const jobId = 'nc-testgroup-int-ac2';
    const groupFolder = 'testgroup';
    const chatJid = 'http:ac2user';
    const messageId = 'msg-ac2-12345';

    // Seed with a messageId (as the channel sends when spawning the job)
    recordToolJob(jobId, groupFolder, chatJid, messageId);

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    expect(publisher.published).toHaveLength(1);
    // AC2: notice must reference the user-facing messageId
    expect(publisher.published[0].text).toContain(messageId);
    // K8s job ID should not be in the notice
    expect(publisher.published[0].text).not.toContain(jobId);
  });

  it('marks the DB row as interrupted after reconciliation', async () => {
    const jobId = 'nc-testgroup-int002';
    recordToolJob(jobId, 'testgroup', 'http:user2');

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    // Before reconciliation: job is active
    const before = getActiveToolJobs();
    expect(before.map((j) => j.job_id)).toContain(jobId);

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    // After reconciliation: no active jobs remain
    const after = getActiveToolJobs();
    expect(after.map((j) => j.job_id)).not.toContain(jobId);
  });

  it('deletes the K8s job for each orphaned record', async () => {
    const jobId1 = 'nc-g-int003';
    const jobId2 = 'nc-g-int004';
    recordToolJob(jobId1, 'groupA', 'http:a');
    recordToolJob(jobId2, 'groupB', 'http:b');

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    expect(k8s.deleted).toContain(jobId1);
    expect(k8s.deleted).toContain(jobId2);
  });

  it('does not include already-resolved jobs in the reconciliation pass', async () => {
    const activeId = 'nc-g-active';
    const completedId = 'nc-g-completed';

    recordToolJob(activeId, 'groupA', 'http:a');
    recordToolJob(completedId, 'groupA', 'http:a');
    // Mark one as already completed
    resolveToolJob(completedId, 'completed');

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    // Only the active job should be reconciled
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].text).toContain(activeId);
    expect(k8s.deleted).toContain(activeId);
    expect(k8s.deleted).not.toContain(completedId);
  });

  it('second reconciliation pass after jobs are already interrupted is a no-op', async () => {
    const jobId = 'nc-g-already-interrupted';
    recordToolJob(jobId, 'groupA', 'http:a');

    // First pass
    const k8s1 = makeK8sFake();
    const publisher1 = makePublisherFake();
    await reconcileOrphanedJobsOnStartup({ k8s: k8s1, publisher: publisher1 });
    expect(publisher1.published).toHaveLength(1);

    // Second pass (simulates a second restart)
    const k8s2 = makeK8sFake();
    const publisher2 = makePublisherFake();
    await reconcileOrphanedJobsOnStartup({ k8s: k8s2, publisher: publisher2 });

    // Second pass should be a no-op — the row is already 'interrupted'
    expect(publisher2.published).toHaveLength(0);
    expect(k8s2.deleted).toHaveLength(0);
  });

  it('resolveToolJob(completed) prevents an active job from appearing as orphan', async () => {
    const jobId = 'nc-g-normal-completion';
    recordToolJob(jobId, 'groupA', 'http:a');
    resolveToolJob(jobId, 'completed');

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    expect(publisher.published).toHaveLength(0);
    expect(k8s.deleted).toHaveLength(0);
  });

  it('handles multiple groups correctly — routes each notice to the right group', async () => {
    const jobs = [
      { id: 'nc-g1-x', folder: 'group1', jid: 'http:alice' },
      { id: 'nc-g2-y', folder: 'group2', jid: 'http:bob' },
      { id: 'nc-g3-z', folder: 'group3', jid: 'http:carol' },
    ];
    for (const j of jobs) recordToolJob(j.id, j.folder, j.jid);

    const k8s = makeK8sFake();
    const publisher = makePublisherFake();

    await reconcileOrphanedJobsOnStartup({ k8s, publisher });

    expect(publisher.published).toHaveLength(3);

    for (const j of jobs) {
      const notice = publisher.published.find((p) => p.groupFolder === j.folder);
      expect(notice, `notice missing for ${j.folder}`).toBeDefined();
      expect(notice!.chatJid).toBe(j.jid);
      expect(notice!.text).toContain(j.id);
    }
  });
});
