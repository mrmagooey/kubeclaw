/**
 * Orphan tool-job reconciliation — Story 37.
 *
 * On orchestrator startup, queries for tool jobs that were still `active` in
 * the DB (meaning the orchestrator restarted while they were running). For
 * each orphan:
 *   1. Publishes an "interrupted" notice to the group's Redis pub/sub output
 *      channel so the channel pod delivers it over the user's open SSE stream.
 *   2. Deletes the K8s Job (and its pods) so cluster resources are freed.
 *   3. Marks the DB row as `interrupted` (idempotency — a second restart will
 *      not re-emit the notice).
 *
 * The entire operation is bounded by `timeoutMs` (default 30 s). If it cannot
 * complete within that window, it logs a warning and returns so the
 * orchestrator can finish booting normally.
 */

import { logger } from '../logger.js';
import { getActiveToolJobs, resolveToolJob, ToolJobRecord } from '../db.js';

/**
 * Minimal interface for K8s job deletion.  The real implementation delegates
 * to `JobRunner.stopJob`, but injecting an interface keeps this module
 * independently testable with a fake.
 */
export interface OrphanJobK8sClient {
  /**
   * Delete the K8s Job by name, swallowing NotFound errors.
   * Implementations should propagate other errors so the caller can log them.
   */
  deleteJob(jobName: string): Promise<void>;
}

/**
 * Minimal interface for publishing the interruption notice to the channel's
 * Redis output pub/sub channel (`kubeclaw:messages:<groupFolder>`).
 */
export interface OrphanJobPublisher {
  /**
   * Publish a JSON-encoded `{ type: 'message', chatJid, text }` payload to
   * the channel named `kubeclaw:messages:<groupFolder>`.
   */
  publish(groupFolder: string, chatJid: string, text: string): Promise<void>;
}

export interface ReconcileOrphanedJobsDeps {
  k8s: OrphanJobK8sClient;
  publisher: OrphanJobPublisher;
  /** Wall-clock limit for the entire reconciliation pass.  Default: 30 000 ms. */
  timeoutMs?: number;
  /**
   * Injected source for active tool jobs — overridable for tests.
   * Defaults to the real `getActiveToolJobs()` from db.ts.
   */
  getActiveJobs?: () => ToolJobRecord[];
  /**
   * Injected sink for marking a job as interrupted — overridable for tests.
   * Defaults to the real `resolveToolJob(jobId, 'interrupted')` from db.ts.
   */
  markInterrupted?: (jobId: string) => void;
}

/**
 * Format the user-visible interruption notice for a single orphaned job.
 * The message must contain "tool job interrupted" (case-insensitive) and
 * reference the job ID so users can correlate it with the POST /message
 * response they received when they submitted the request (Story 25).
 */
export function formatInterruptionNotice(jobId: string): string {
  return (
    `Tool job interrupted: the assistant service restarted while your request ` +
    `(job ${jobId}) was still running. ` +
    `Please re-send your message to try again.`
  );
}

/**
 * Run the orphan tool-job reconciliation pass.
 *
 * This function is intentionally written to be idempotent: rows whose status
 * is already `interrupted` or `completed` are not returned by
 * `getActiveToolJobs`, so a second call (e.g. after two consecutive restarts)
 * will be a no-op for previously reconciled jobs.
 *
 * Errors for individual jobs are caught and logged; they do not abort the
 * reconciliation of other jobs in the same pass.
 */
export async function reconcileOrphanedJobsOnStartup(
  deps: ReconcileOrphanedJobsDeps,
): Promise<void> {
  const {
    k8s,
    publisher,
    timeoutMs = 30_000,
    getActiveJobs = getActiveToolJobs,
    markInterrupted = (jobId: string) => resolveToolJob(jobId, 'interrupted'),
  } = deps;

  const deadline = Date.now() + timeoutMs;

  let orphans: ToolJobRecord[];
  try {
    orphans = getActiveJobs();
  } catch (err) {
    logger.warn(
      { err },
      'reconcileOrphanedJobsOnStartup: failed to query active tool jobs; skipping',
    );
    return;
  }

  if (orphans.length === 0) {
    logger.debug('reconcileOrphanedJobsOnStartup: no orphaned tool jobs found');
    return;
  }

  logger.info(
    { count: orphans.length },
    'reconcileOrphanedJobsOnStartup: found orphaned tool jobs; reconciling',
  );

  for (const orphan of orphans) {
    if (Date.now() > deadline) {
      logger.warn(
        { remainingJobs: orphans.length },
        'reconcileOrphanedJobsOnStartup: timeout reached; aborting reconciliation',
      );
      break;
    }

    const { job_id, group_folder, chat_jid } = orphan;
    logger.info({ jobId: job_id, groupFolder: group_folder, chatJid: chat_jid }, 'Reconciling orphaned tool job');

    // Step 1: Mark as interrupted FIRST (idempotency token).
    // If the publish or K8s delete fails we still don't re-emit on the next
    // startup because the row is already resolved.  The cost of not delivering
    // the notice once is lower than delivering a duplicate.
    try {
      markInterrupted(job_id);
    } catch (err) {
      logger.warn(
        { jobId: job_id, err },
        'reconcileOrphanedJobsOnStartup: failed to mark job interrupted in DB; skipping',
      );
      continue;
    }

    // Step 2: Publish interruption notice to the group's output channel.
    const notice = formatInterruptionNotice(job_id);
    try {
      await publisher.publish(group_folder, chat_jid, notice);
      logger.info(
        { jobId: job_id, groupFolder: group_folder },
        'reconcileOrphanedJobsOnStartup: interruption notice published',
      );
    } catch (err) {
      logger.warn(
        { jobId: job_id, groupFolder: group_folder, err },
        'reconcileOrphanedJobsOnStartup: failed to publish interruption notice; job already marked interrupted',
      );
    }

    // Step 3: Delete the orphaned K8s Job so cluster resources are freed.
    try {
      await k8s.deleteJob(job_id);
      logger.info(
        { jobId: job_id },
        'reconcileOrphanedJobsOnStartup: K8s job deleted',
      );
    } catch (err) {
      logger.warn(
        { jobId: job_id, err },
        'reconcileOrphanedJobsOnStartup: failed to delete K8s job (may have already completed)',
      );
    }
  }

  logger.info('reconcileOrphanedJobsOnStartup: reconciliation pass complete');
}
