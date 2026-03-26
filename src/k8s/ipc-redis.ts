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
  getAgentJobResultStream,
  getControlChannel,
  getInputStream,
  getOutputChannel,
  getRedisClient,
  getRedisSubscriber,
  getSpawnAgentJobStream,
  getSpawnToolPodStream,
  getTaskChannel,
} from './redis-client.js';
import { TaskRequest } from './types.js';
import { jobRunner } from './job-runner.js';
import { ASSISTANT_NAME, CONTAINER_TIMEOUT, IDLE_TIMEOUT } from '../config.js';

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

function channelPvcNames(channel: string): { groupsPvc: string; sessionsPvc: string } {
  if (!channel) return { groupsPvc: 'kubeclaw-groups', sessionsPvc: 'kubeclaw-sessions' };
  return {
    groupsPvc: `kubeclaw-channel-${channel}-groups`,
    sessionsPvc: `kubeclaw-channel-${channel}-sessions`,
  };
}

// Track tool pod jobs per agent job for cleanup
const toolPodsByAgent = new Map<string, Set<string>>();

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
    // Extract group folder from channel name (e.g., kubeclaw:messages:mygroup -> mygroup)
    const match = channel.match(/^kubeclaw:(messages|tasks):(.+)$/);
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

    case 'tool_pod_request':
      if (data.agentJobId && data.category && data.groupFolder) {
        const { agentJobId, category, groupFolder: podGroupFolder } = data;
        try {
          const timeout = Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000);
          const podJobId = await jobRunner.createToolPodJob({
            agentJobId,
            groupFolder: podGroupFolder,
            category,
            timeout,
          });

          // Track pod for cleanup when agent ends
          if (!toolPodsByAgent.has(agentJobId)) {
            toolPodsByAgent.set(agentJobId, new Set());
          }
          toolPodsByAgent.get(agentJobId)!.add(podJobId);

          // Send ack back to agent via input stream
          const client = getRedisClient();
          const streamKey = getInputStream(agentJobId);
          await client.xadd(
            streamKey,
            '*',
            'type',
            'tool_pod_ack',
            'category',
            category,
            'podJobId',
            podJobId,
          );
          logger.info(
            { agentJobId, category, podJobId },
            'Tool pod created and ack sent',
          );
        } catch (err) {
          logger.error(
            { agentJobId, category, err },
            'Failed to create tool pod',
          );
        }
      }
      break;

    case 'deploy_channel':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized deploy_channel attempt blocked');
        break;
      }
      if (data.yaml) {
        try {
          await jobRunner.applyYamlToK8s(data.yaml);
          logger.info({ sourceGroup }, 'Channel deployment applied');
        } catch (err) {
          logger.error({ err }, 'Failed to apply channel deployment');
        }
      }
      break;

    case 'control_channel':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized control_channel attempt blocked');
        break;
      }
      if (data.channelName && data.command) {
        try {
          const client = getRedisClient();
          await client.publish(
            getControlChannel(data.channelName),
            JSON.stringify({ command: data.command }),
          );
          logger.info({ sourceGroup, channelName: data.channelName, command: data.command }, 'Control command sent to channel pod');
        } catch (err) {
          logger.error({ err }, 'Failed to send control command');
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown Redis IPC task type');
  }
}

/**
 * Clean up all tool pods associated with an agent job
 */
export async function cleanupToolPods(agentJobId: string): Promise<void> {
  const pods = toolPodsByAgent.get(agentJobId);
  if (!pods || pods.size === 0) return;

  toolPodsByAgent.delete(agentJobId);
  for (const podJobId of pods) {
    try {
      await jobRunner.stopJob(podJobId);
      logger.info({ agentJobId, podJobId }, 'Tool pod cleaned up');
    } catch (err) {
      logger.warn({ agentJobId, podJobId, err }, 'Failed to cleanup tool pod');
    }
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
 * Watch the kubeclaw:spawn-tool-pod stream and create K8s tool pod jobs on
 * behalf of channel pods, which have no K8s RBAC.
 * Called by the orchestrator at startup.
 */
export async function startToolPodSpawnWatcher(): Promise<void> {
  const redis = getRedisClient();
  const stream = getSpawnToolPodStream();
  // Use '$' so orchestrator restarts don't replay stale requests.
  // If the orchestrator missed a request, the channel pod's tool call will
  // time out (TOOL_TIMEOUT_MS) and the user gets a graceful error.
  let lastId = '$';

  logger.info('Tool pod spawn watcher started');

  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread('COUNT', 10, 'BLOCK', 5000, 'STREAMS', stream, lastId);
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

          const { agentJobId, groupFolder, category, timeout, channel, toolImage, toolPattern, toolPort, toolCommand } = obj;
          if (!agentJobId || !groupFolder || !category) continue;

          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');
          const timeoutMs = Number(timeout) || 60_000;

          let parsedCommand: string[] | undefined;
          if (toolCommand) {
            try {
              parsedCommand = JSON.parse(toolCommand) as string[];
            } catch {
              logger.warn({ agentJobId, toolCommand }, 'Failed to parse toolCommand JSON, ignoring');
            }
          }

          try {
            if (toolImage) {
              await jobRunner.createSidecarToolPodJob({
                agentJobId,
                groupFolder,
                toolName: category,
                toolSpec: {
                  name: category,
                  description: '',
                  parameters: {},
                  image: toolImage,
                  pattern: (toolPattern as 'http' | 'file') || 'http',
                  port: toolPort ? Number(toolPort) : 8080,
                  ...(parsedCommand ? { command: parsedCommand } : {}),
                },
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
              });
              logger.debug({ agentJobId, category, toolImage }, 'Spawned sidecar tool pod for channel pod');
            } else {
              await jobRunner.createToolPodJob({
                agentJobId,
                groupFolder,
                category: category as 'browser' | 'execution',
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
              });
              logger.debug({ agentJobId, category }, 'Spawned tool pod for channel pod');
            }
          } catch (err) {
            logger.error({ agentJobId, category, err }, 'Failed to spawn tool pod for channel pod');
          }
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'Tool pod spawn watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * Watch the kubeclaw:spawn-agent-job stream and run full K8s agent jobs on
 * behalf of channel pods. Writes the final result to
 * kubeclaw:agent-job-result:{agentJobId} so the channel pod can return it.
 */
export async function startAgentJobSpawnWatcher(): Promise<void> {
  const redis = getRedisClient();
  const stream = getSpawnAgentJobStream();
  let lastId = '$';

  logger.info('Agent job spawn watcher started');

  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread('COUNT', 5, 'BLOCK', 5000, 'STREAMS', stream, lastId);
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

          const { agentJobId, groupFolder, chatJid, prompt, channel } = obj;
          if (!agentJobId || !groupFolder || !chatJid || !prompt) continue;

          const resultStream = getAgentJobResultStream(agentJobId);
          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');

          // Fire-and-forget: run the agent job and write result when done
          const group = {
            name: groupFolder,
            folder: groupFolder,
            trigger: '',
            added_at: new Date().toISOString(),
          };

          jobRunner
            .runAgentJob(group, {
              groupFolder,
              chatJid,
              isMain: false,
              prompt,
              assistantName: ASSISTANT_NAME,
              groupsPvc,
              sessionsPvc,
            })
            .then(async (output) => {
              const result = output.result ?? output.error ?? 'Agent job completed';
              await redis.xadd(resultStream, '*', 'result', String(result), 'status', output.status);
              logger.debug({ agentJobId }, 'Agent job result written to stream');
            })
            .catch(async (err) => {
              logger.error({ agentJobId, err }, 'Agent job failed');
              await redis.xadd(resultStream, '*', 'result', String(err), 'status', 'error');
            });

          logger.debug({ agentJobId, groupFolder }, 'Spawned agent job for channel pod');
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'Agent job spawn watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * Subscribe to the control channel for a channel pod and invoke onCommand
 * when a control message arrives (e.g. { command: 'reload' }).
 * Called by channel-runner.ts after startIpcWatcher().
 */
export function startControlChannelWatcher(
  channelName: string,
  onCommand: (msg: { command: string }) => Promise<void>,
): void {
  const subscriber = getRedisSubscriber();
  const channel = getControlChannel(channelName);
  subscriber.subscribe(channel, (err) => {
    if (err) logger.error({ err, channel }, 'Failed to subscribe to control channel');
    else logger.info({ channel }, 'Subscribed to control channel');
  });
  subscriber.on('message', (ch, message) => {
    if (ch !== channel) return;
    try {
      const data = JSON.parse(message) as { command: string };
      if (data.command) {
        onCommand(data).catch((err) =>
          logger.error({ err, command: data.command }, 'Error handling control command'),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to parse control channel message');
    }
  });
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
