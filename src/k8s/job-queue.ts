/**
 * Distributed Job Queue for Kubernetes runtime
 * Replaces GroupQueue with Redis-based distributed concurrency control
 */
import {
  getRedisClient,
  getQueueKey,
  getConcurrencyKey,
  getInputStream,
  getJobStatusKey,
} from './redis-client.js';
import { logger } from '../logger.js';
import { ToolJobSpec, DistributedQueueItem } from './types.js';

const MAX_CONCURRENT_JOBS = parseInt(
  process.env.MAX_CONCURRENT_JOBS || '10',
  10,
);

// Atomically increments the concurrency counter only if it is below the limit.
// Returns 1 if the slot was acquired, 0 if the limit has been reached.
const ACQUIRE_SLOT_SCRIPT = `
local limit = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1])) or 0
if current < limit then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
`;
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '300000', 10);
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

interface JobState {
  jobId: string;
  groupJid: string;
  groupFolder: string;
  jobName: string;
  isTask: boolean;
  startTime: Date;
}

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  jobId: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class DistributedJobQueue {
  private redis = getRedisClient();
  private groups = new Map<string, GroupState>();
  private activeJobs = new Map<string, JobState>();
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startQueuePoller();
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        jobId: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  async enqueueMessageCheck(groupJid: string): Promise<void> {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued locally');
      return;
    }

    const acquired = await this.acquireSlot(groupJid);
    if (!acquired) {
      state.pendingMessages = true;
      await this.queueJob(groupJid, 'messages', null, 1);
      logger.debug(
        { groupJid },
        'At concurrency limit, message queued in Redis',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  async enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        await this.closeStdin(groupJid);
      }
      logger.debug(
        { groupJid, taskId },
        'Container active, task queued locally',
      );
      return;
    }

    const acquired = await this.acquireSlot(groupJid);
    if (!acquired) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      await this.queueJob(groupJid, 'task', taskId, 0);
      logger.debug(
        { groupJid, taskId },
        'At concurrency limit, task queued in Redis',
      );
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  async acquireSlot(groupJid: string): Promise<boolean> {
    const concurrencyKey = getConcurrencyKey();

    try {
      const result = await this.redis.eval(
        ACQUIRE_SLOT_SCRIPT,
        1,
        concurrencyKey,
        String(MAX_CONCURRENT_JOBS),
      );
      const acquired = result === 1;
      if (acquired) {
        logger.debug(
          { groupJid, max: MAX_CONCURRENT_JOBS },
          'Acquired concurrency slot',
        );
      }
      return acquired;
    } catch (err) {
      logger.error({ groupJid, err }, 'Error acquiring concurrency slot');
      return false;
    }
  }

  async releaseSlot(groupJid: string): Promise<void> {
    const concurrencyKey = getConcurrencyKey();

    try {
      const newCount = await this.redis.decr(concurrencyKey);
      logger.debug(
        { groupJid, activeCount: Math.max(0, newCount) },
        'Released concurrency slot',
      );

      if (newCount < 0) {
        await this.redis.set(concurrencyKey, '0');
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error releasing concurrency slot');
    }
  }

  private async queueJob(
    groupJid: string,
    jobType: 'messages' | 'task',
    taskId: string | null,
    priority: number,
  ): Promise<void> {
    const queueKey = getQueueKey();
    const jobId = `${groupJid}:${jobType}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const queueItem: DistributedQueueItem = {
      id: jobId,
      groupJid,
      jobSpec: {
        name: jobType,
        groupFolder: groupJid.replace(/[@]/g, '_'),
        chatJid: groupJid,
        isMain: jobType === 'messages',
        prompt: taskId || '',
      },
      priority,
      enqueuedAt: new Date().toISOString(),
    };

    try {
      const score = Date.now() + priority * 1000000;
      await this.redis.zadd(queueKey, score, JSON.stringify(queueItem));
      logger.debug(
        { jobId, groupJid, jobType, priority },
        'Job queued in Redis',
      );
    } catch (err) {
      logger.error({ jobId, groupJid, err }, 'Error queuing job in Redis');
    }
  }

  private startQueuePoller(): void {
    this.pollInterval = setInterval(() => {
      this.processQueue().catch((err) =>
        logger.error({ err }, 'Error processing queue'),
      );
    }, 1000);
  }

  private async processQueue(): Promise<void> {
    if (this.shuttingDown) return;

    const concurrencyKey = getConcurrencyKey();
    const queueKey = getQueueKey();

    try {
      const currentCount = parseInt(
        (await this.redis.get(concurrencyKey)) || '0',
        10,
      );
      const availableSlots = MAX_CONCURRENT_JOBS - currentCount;

      if (availableSlots <= 0) return;

      const items = await this.redis.zrange(queueKey, 0, availableSlots - 1);
      if (!items.length) return;

      for (const itemStr of items) {
        const removed = await this.redis.zrem(queueKey, itemStr);
        if (removed === 0) continue;

        const item: DistributedQueueItem = JSON.parse(itemStr);
        const acquired = await this.acquireSlot(item.groupJid);

        if (!acquired) {
          const score = Date.now() + item.priority * 1000000;
          await this.redis.zadd(queueKey, score, itemStr);
          continue;
        }

        if (item.jobSpec.name === 'task') {
          const state = this.getGroup(item.groupJid);
          const task = state.pendingTasks.shift();
          if (task) {
            this.runTask(item.groupJid, task).catch((err) =>
              logger.error(
                { groupJid: item.groupJid, err },
                'Error running queued task',
              ),
            );
          } else {
            await this.releaseSlot(item.groupJid);
          }
        } else {
          this.runForGroup(item.groupJid, 'drain').catch((err) =>
            logger.error(
              { groupJid: item.groupJid, err },
              'Error running queued messages',
            ),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in queue poller');
    }
  }

  async registerProcess(
    groupJid: string,
    jobName: string,
    groupFolder: string,
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const jobId = `${groupJid}:${Date.now()}`;

    state.active = true;
    state.idleWaiting = false;
    state.groupFolder = groupFolder;
    state.jobId = jobId;

    const jobState: JobState = {
      jobId,
      groupJid,
      groupFolder,
      jobName,
      isTask: jobName !== 'messages',
      startTime: new Date(),
    };
    this.activeJobs.set(jobId, jobState);

    const statusKey = getJobStatusKey(jobId);
    await this.redis.setex(
      statusKey,
      3600,
      JSON.stringify({
        phase: 'Running',
        startTime: new Date().toISOString(),
      }),
    );

    logger.debug({ jobId, groupJid, jobName }, 'Job registered');
  }

  async notifyIdle(groupJid: string): Promise<void> {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;

    if (state.pendingTasks.length > 0) {
      await this.closeStdin(groupJid);
    }
  }

  async sendMessage(groupJid: string, text: string): Promise<boolean> {
    const state = this.getGroup(groupJid);

    if (!state.active || !state.jobId || state.isTaskContainer) {
      return false;
    }

    state.idleWaiting = false;

    const inputStream = getInputStream(state.jobId);
    const message = JSON.stringify({
      type: 'message',
      text,
      timestamp: Date.now(),
    });

    try {
      await this.redis.xadd(inputStream, '*', 'data', message);
      logger.debug(
        { groupJid, jobId: state.jobId },
        'Message sent via Redis stream',
      );
      return true;
    } catch (err) {
      logger.error({ groupJid, err }, 'Error sending message via Redis');
      return false;
    }
  }

  async closeStdin(groupJid: string): Promise<void> {
    const state = this.getGroup(groupJid);

    if (!state.active || !state.jobId) return;

    const inputStream = getInputStream(state.jobId);
    const closeMessage = JSON.stringify({
      type: 'close',
      timestamp: Date.now(),
    });

    try {
      await this.redis.xadd(inputStream, '*', 'data', closeMessage);
      logger.debug(
        { groupJid, jobId: state.jobId },
        'Close signal sent via Redis stream',
      );
    } catch (err) {
      logger.error({ groupJid, err }, 'Error sending close signal');
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;

    logger.debug({ groupJid, reason }, 'Starting job for group');

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      await this.cleanupJob(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;

    logger.debug({ groupJid, taskId: task.id }, 'Running queued task');

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.isTaskContainer = false;
      state.runningTaskId = null;
      await this.cleanupJob(groupJid);
    }
  }

  private async cleanupJob(groupJid: string): Promise<void> {
    const state = this.getGroup(groupJid);

    if (state.jobId) {
      const statusKey = getJobStatusKey(state.jobId);
      await this.redis.setex(
        statusKey,
        3600,
        JSON.stringify({
          phase: 'Succeeded',
          completionTime: new Date().toISOString(),
        }),
      );
      this.activeJobs.delete(state.jobId);
    }

    state.active = false;
    state.jobId = null;
    state.groupFolder = null;

    await this.releaseSlot(groupJid);
    await this.drainGroup(groupJid);
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid).catch((err) =>
          logger.error({ groupJid, err }, 'Error during retry'),
        );
      }
    }, delayMs);
  }

  private async drainGroup(groupJid: string): Promise<void> {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.pendingTasks.length > 0) {
      const acquired = await this.acquireSlot(groupJid);
      if (acquired) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Error in drain runTask',
          ),
        );
      } else {
        const task = state.pendingTasks[0];
        await this.queueJob(groupJid, 'task', task.id, 0);
      }
      return;
    }

    if (state.pendingMessages) {
      const acquired = await this.acquireSlot(groupJid);
      if (acquired) {
        this.runForGroup(groupJid, 'drain').catch((err) =>
          logger.error({ groupJid, err }, 'Error in drain runForGroup'),
        );
      } else {
        await this.queueJob(groupJid, 'messages', null, 1);
      }
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    const shutdownStart = Date.now();
    const activeJobsList = Array.from(this.activeJobs.values());

    logger.info(
      { activeJobs: activeJobsList.length, gracePeriodMs },
      'DistributedJobQueue shutting down',
    );

    for (const job of activeJobsList) {
      const elapsed = Date.now() - shutdownStart;
      const remaining = gracePeriodMs - elapsed;

      if (remaining <= 0) break;

      try {
        await this.closeStdin(job.groupJid);

        const statusKey = getJobStatusKey(job.jobId);
        await this.redis.setex(
          statusKey,
          3600,
          JSON.stringify({
            phase: 'Failed',
            completionTime: new Date().toISOString(),
            reason: 'Shutdown',
            message: 'Container received shutdown signal',
          }),
        );
      } catch (err) {
        logger.error(
          { jobId: job.jobId, err },
          'Error during shutdown cleanup',
        );
      }
    }

    logger.info(
      { activeJobs: this.activeJobs.size },
      'Shutdown complete, detached from active jobs',
    );
  }
}
