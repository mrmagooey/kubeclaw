/**
 * Redis-based IPC module for Kubernetes runtime
 * Replaces filesystem-based IPC (ipc.ts) with Redis pub/sub and streams
 */
import { CronExpressionParser } from 'cron-parser';
import { Redis } from 'ioredis';

import { SIDECAR_POLL_INTERVAL, TIMEZONE } from '../config.js';
import { AvailableGroup } from '../runtime/types.js';
import { createTask, deleteTask, getTaskById, updateTask } from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import {
  getInputStream,
  getOutputChannel,
  getRedisClient,
  getRedisSubscriber,
  getTaskChannel,
} from './redis-client.js';
import { TaskRequest } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;
let subscribers: Redis[] = [];

interface AgentOutputMessage {
  type: 'message' | 'task_request';
  jobId?: string;
  chatJid?: string;
  text?: string;
  payload?: TaskRequest;
}

/**
 * Start Redis-based IPC watcher
 * Subscribes to channels for each registered group
 */
export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('Redis IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const subscriber = getRedisSubscriber();

  const processMessage = async (
    channel: string,
    message: string,
    sourceGroup: string,
    isMain: boolean,
  ): Promise<void> => {
    try {
      const data: AgentOutputMessage = JSON.parse(message);
      const registeredGroups = deps.registeredGroups();

      if (data.type === 'message' && data.chatJid && data.text) {
        // Authorization: verify this group can send to this chatJid
        const targetGroup = registeredGroups[data.chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          await deps.sendMessage(data.chatJid, data.text);
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'Redis IPC message sent',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized Redis IPC message attempt blocked',
          );
        }
      }
    } catch (err) {
      logger.error(
        { channel, sourceGroup, err, message },
        'Error processing Redis IPC message',
      );
    }
  };

  const processTask = async (
    channel: string,
    message: string,
    sourceGroup: string,
    isMain: boolean,
  ): Promise<void> => {
    try {
      const data: TaskRequest = JSON.parse(message);
      // Pass source group identity to processTaskIpc for authorization
      await processTaskIpc(data, sourceGroup, isMain, deps);
    } catch (err) {
      logger.error(
        { channel, sourceGroup, err, message },
        'Error processing Redis IPC task',
      );
    }
  };

  // Subscribe to channels for all registered groups
  const subscribeToGroup = (groupFolder: string, isMain: boolean) => {
    const outputChannel = getOutputChannel(groupFolder);
    const taskChannel = getTaskChannel(groupFolder);

    subscriber.subscribe(outputChannel, taskChannel, (err) => {
      if (err) {
        logger.error(
          { groupFolder, err },
          'Failed to subscribe to Redis channels',
        );
      } else {
        logger.debug(
          { groupFolder, outputChannel, taskChannel },
          'Subscribed to Redis channels',
        );
      }
    });
  };

  // Handle incoming messages
  subscriber.on('message', (channel, message) => {
    // Extract group folder from channel name (e.g., nanoclaw:messages:mygroup -> mygroup)
    const match = channel.match(/^nanoclaw:(messages|tasks):(.+)$/);
    if (!match) {
      logger.warn({ channel }, 'Received message on unknown channel');
      return;
    }

    const channelType = match[1];
    const sourceGroup = match[2];

    // Determine if this group is main
    const registeredGroups = deps.registeredGroups();
    let isMain = false;
    for (const group of Object.values(registeredGroups)) {
      if (group.folder === sourceGroup && group.isMain) {
        isMain = true;
        break;
      }
    }

    if (channelType === 'messages') {
      void processMessage(channel, message, sourceGroup, isMain);
    } else if (channelType === 'tasks') {
      void processTask(channel, message, sourceGroup, isMain);
    }
  });

  // Subscribe to existing groups
  const registeredGroups = deps.registeredGroups();
  const subscribedFolders = new Set<string>();
  for (const group of Object.values(registeredGroups)) {
    if (!subscribedFolders.has(group.folder)) {
      subscribeToGroup(group.folder, group.isMain === true);
      subscribedFolders.add(group.folder);
    }
  }

  // Periodic check for new groups
  const checkNewGroups = () => {
    const currentGroups = deps.registeredGroups();
    for (const group of Object.values(currentGroups)) {
      if (!subscribedFolders.has(group.folder)) {
        subscribeToGroup(group.folder, group.isMain === true);
        subscribedFolders.add(group.folder);
        logger.info(
          { groupFolder: group.folder },
          'Subscribed to new group channels',
        );
      }
    }
    setTimeout(checkNewGroups, SIDECAR_POLL_INTERVAL);
  };

  checkNewGroups();
  subscribers.push(subscriber);
  logger.info('Redis IPC watcher started');
}

/**
 * Process task requests from agents via Redis
 * Handles authorization based on source group and main status
 */
export async function processTaskIpc(
  data: TaskRequest,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via Redis IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via Redis IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via Redis IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via Redis IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via Redis IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via Redis IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig:
            data.containerConfig as RegisteredGroup['containerConfig'],
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown Redis IPC task type');
  }
}

/**
 * Send a message to a running agent via Redis stream
 */
export async function sendMessageToAgent(
  jobId: string,
  text: string,
): Promise<void> {
  const client = getRedisClient();
  const streamKey = getInputStream(jobId);

  try {
    await client.xadd(streamKey, '*', 'type', 'message', 'text', text);
    logger.debug({ jobId }, 'Message sent to agent via Redis stream');
  } catch (err) {
    logger.error({ jobId, err }, 'Failed to send message to agent');
    throw err;
  }
}

/**
 * Send a close signal to an agent to request graceful shutdown
 */
export async function sendCloseSignal(jobId: string): Promise<void> {
  const client = getRedisClient();
  const streamKey = getInputStream(jobId);

  try {
    await client.xadd(streamKey, '*', 'type', 'close');
    logger.debug({ jobId }, 'Close signal sent to agent via Redis stream');
  } catch (err) {
    logger.error({ jobId, err }, 'Failed to send close signal to agent');
    throw err;
  }
}

/**
 * Stop the Redis IPC watcher and clean up resources
 */
export async function stopIpcWatcher(): Promise<void> {
  ipcWatcherRunning = false;

  for (const subscriber of subscribers) {
    try {
      await subscriber.unsubscribe();
      await subscriber.quit();
    } catch (err) {
      logger.error({ err }, 'Error closing Redis subscriber');
    }
  }
  subscribers = [];

  logger.info('Redis IPC watcher stopped');
}
