/**
 * Redis-based IPC module for Kubernetes runtime
 * Replaces filesystem-based IPC (ipc.ts) with Redis pub/sub and streams
 */
import { CronExpressionParser } from 'cron-parser';
import { Redis } from 'ioredis';

import { SIDECAR_FILE_POLL_INTERVAL, TIMEZONE } from '../config.js';
import { AvailableGroup } from '../runtime/types.js';
import {
  createTask,
  deleteTask,
  getAllRegisteredGroups,
  getTaskById,
  getTasksForGroup,
  updateTask,
} from '../db.js';
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
  getTaskRequestStream,
} from './redis-client.js';
import { TaskRequest } from './types.js';
import { jobRunner } from './job-runner.js';
import { ASSISTANT_NAME, CONTAINER_TIMEOUT, IDLE_TIMEOUT } from '../config.js';
import {
  deployMcpServer,
  removeMcpServer,
  listMcpServers,
} from '../mcp-registry.js';
import { loadSpecialists } from '../specialists.js';

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

function channelPvcNames(channel: string): {
  groupsPvc: string;
  sessionsPvc: string;
} {
  if (!channel)
    return { groupsPvc: 'kubeclaw-groups', sessionsPvc: 'kubeclaw-sessions' };
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
    setTimeout(checkNewGroups, SIDECAR_FILE_POLL_INTERVAL);
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
        logger.warn(
          { sourceGroup },
          'Unauthorized deploy_channel attempt blocked',
        );
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
        logger.warn(
          { sourceGroup },
          'Unauthorized control_channel attempt blocked',
        );
        break;
      }
      if (data.channelName && data.command) {
        try {
          const client = getRedisClient();
          await client.publish(
            getControlChannel(data.channelName),
            JSON.stringify({ command: data.command }),
          );
          logger.info(
            {
              sourceGroup,
              channelName: data.channelName,
              command: data.command,
            },
            'Control command sent to channel pod',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to send control command');
        }
      }
      break;

    case 'deploy_mcp_server':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized deploy_mcp_server attempt blocked',
        );
        break;
      }
      if (data.name && data.image) {
        try {
          await deployMcpServer({
            name: data.name,
            image: data.image,
            port: data.port ? Number(data.port) : undefined,
            path: data.path || undefined,
            command: data.command
              ? JSON.parse(data.command as string)
              : undefined,
            env: data.env ? JSON.parse(data.env) : undefined,
            channels: data.channels ? JSON.parse(data.channels) : undefined,
            allowedTools: data.allowedTools
              ? JSON.parse(data.allowedTools)
              : undefined,
            resources: data.resources ? JSON.parse(data.resources) : undefined,
          });
          logger.info(
            { sourceGroup, name: data.name },
            'MCP server deployed via IPC',
          );
        } catch (err) {
          logger.error({ err, name: data.name }, 'Failed to deploy MCP server');
        }
      }
      break;

    case 'remove_mcp_server':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remove_mcp_server attempt blocked',
        );
        break;
      }
      if (data.name) {
        try {
          await removeMcpServer(data.name);
          logger.info(
            { sourceGroup, name: data.name },
            'MCP server removed via IPC',
          );
        } catch (err) {
          logger.error({ err, name: data.name }, 'Failed to remove MCP server');
        }
      }
      break;

    case 'list_mcp_servers':
      try {
        const servers = listMcpServers();
        const resultStream = data.resultStream;
        if (resultStream) {
          const client = getRedisClient();
          await client.xadd(
            resultStream,
            '*',
            'result',
            JSON.stringify(servers),
            'status',
            'success',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to list MCP servers');
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
/** Resolve '$' to the actual current last-entry ID so XREAD doesn't miss messages
 *  added between two consecutive blocking calls (race condition with '$'). */
async function resolveStreamTip(redis: Redis, stream: string): Promise<string> {
  const entries = (await redis.xrevrange(stream, '+', '-', 'COUNT', '1')) as [
    string,
    string[],
  ][];
  return entries.length > 0 ? entries[0][0] : '0-0';
}

export async function startToolPodSpawnWatcher(): Promise<void> {
  const redis = getRedisClient();
  const stream = getSpawnToolPodStream();
  // Resolve to the actual last-entry ID before entering the loop.
  // Using '$' raw would cause a race condition: if a message is added between
  // two consecutive XREAD calls, '$' re-evaluates to the new tip and the
  // message is silently skipped forever.
  let lastId = await resolveStreamTip(redis, stream);

  logger.info('Tool pod spawn watcher started');

  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread(
        'COUNT',
        10,
        'BLOCK',
        5000,
        'STREAMS',
        stream,
        lastId,
      );
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];

          const {
            agentJobId,
            groupFolder,
            category,
            timeout,
            channel,
            toolImage,
            toolPattern,
            toolPort,
            toolCommand,
          } = obj;
          if (!agentJobId || !groupFolder || !category) continue;

          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');
          const timeoutMs = Number(timeout) || 60_000;

          let parsedCommand: string[] | undefined;
          if (toolCommand) {
            try {
              parsedCommand = JSON.parse(toolCommand) as string[];
            } catch {
              logger.warn(
                { agentJobId, toolCommand },
                'Failed to parse toolCommand JSON, ignoring',
              );
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
                  pattern: (toolPattern as 'http' | 'file' | 'acp') || 'http',
                  port: toolPort ? Number(toolPort) : 8080,
                  ...(parsedCommand ? { command: parsedCommand } : {}),
                  ...(obj.toolAcpAgentName
                    ? { acpAgentName: obj.toolAcpAgentName }
                    : {}),
                  ...(obj.toolAcpMode
                    ? { acpMode: obj.toolAcpMode as 'sync' | 'async' }
                    : {}),
                },
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
              });
              logger.debug(
                { agentJobId, category, toolImage },
                'Spawned sidecar tool pod for channel pod',
              );
            } else {
              await jobRunner.createToolPodJob({
                agentJobId,
                groupFolder,
                category: category as 'browser' | 'execution',
                timeout: timeoutMs,
                groupsPvc,
                sessionsPvc,
              });
              logger.debug(
                { agentJobId, category },
                'Spawned tool pod for channel pod',
              );
            }
          } catch (err) {
            logger.error(
              { agentJobId, category, err },
              'Failed to spawn tool pod for channel pod',
            );
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
  let lastId = await resolveStreamTip(redis, stream);

  logger.info('Agent job spawn watcher started');

  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread(
        'COUNT',
        5,
        'BLOCK',
        5000,
        'STREAMS',
        stream,
        lastId,
      );
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];

          const {
            agentJobId,
            groupFolder,
            chatJid,
            prompt,
            channel,
            specialist,
          } = obj;
          if (!agentJobId || !groupFolder || !chatJid || !prompt) continue;

          const resultStream = getAgentJobResultStream(agentJobId);
          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');

          // Resolve specialist prompt from agents.json if a specialist name was provided
          let resolvedPrompt = prompt;
          if (specialist) {
            const specialists = loadSpecialists(groupFolder);
            const spec = specialists?.find(
              (s) => s.name.toLowerCase() === specialist.toLowerCase(),
            );
            if (spec) {
              resolvedPrompt = `<specialist name="${spec.name}">\n${spec.prompt}\n</specialist>\n\n${prompt}`;
            } else {
              logger.warn(
                { agentJobId, groupFolder, specialist },
                'Specialist not found in agents.json, running without specialist prompt',
              );
            }
          }

          // Look up the parent group's llmProvider so the child job inherits it
          const allGroups = getAllRegisteredGroups();
          const parentGroup = Object.values(allGroups).find(
            (g) => g.folder === groupFolder,
          );

          // Fire-and-forget: run the agent job and write result when done
          const group = {
            name: groupFolder,
            folder: groupFolder,
            trigger: '',
            added_at: new Date().toISOString(),
            llmProvider: parentGroup?.llmProvider,
          };

          jobRunner
            .runAgentJob(group, {
              groupFolder,
              chatJid,
              isMain: false,
              prompt: resolvedPrompt,
              assistantName: ASSISTANT_NAME,
              groupsPvc,
              sessionsPvc,
            })
            .then(async (output) => {
              const result =
                output.result ?? output.error ?? 'Agent job completed';
              await redis.xadd(
                resultStream,
                '*',
                'result',
                String(result),
                'status',
                output.status,
              );
              logger.debug(
                { agentJobId },
                'Agent job result written to stream',
              );
            })
            .catch(async (err) => {
              logger.error({ agentJobId, err }, 'Agent job failed');
              await redis.xadd(
                resultStream,
                '*',
                'result',
                String(err),
                'status',
                'error',
              );
            });

          logger.debug(
            { agentJobId, groupFolder },
            'Spawned agent job for channel pod',
          );
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
 * Watch the kubeclaw:task-requests stream for task creation requests from
 * channel pods (via DirectLLMRunner). Unlike the per-group pub/sub task
 * channels, this stream is always watched regardless of which groups the
 * orchestrator knows about.
 */
export async function startTaskRequestWatcher(): Promise<void> {
  const redis = getRedisClient();
  const stream = getTaskRequestStream();
  let lastId = await resolveStreamTip(redis, stream);

  logger.info('Task request stream watcher started');

  while (ipcWatcherRunning) {
    try {
      const resp = await redis.xread(
        'COUNT',
        10,
        'BLOCK',
        5000,
        'STREAMS',
        stream,
        lastId,
      );
      if (!resp) continue;

      for (const [, messages] of resp as [string, [string, string[]][]][]) {
        for (const [id, fields] of messages) {
          lastId = id;
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];

          const { type, groupFolder } = obj;
          if (!type || !groupFolder) continue;

          if (type === 'schedule_task') {
            const {
              taskId,
              chatJid,
              prompt,
              schedule_type,
              schedule_value,
              context_mode,
              resultStream,
            } = obj;
            if (!prompt || !schedule_type || !schedule_value || !chatJid)
              continue;

            const existingTasks = getTasksForGroup(groupFolder);
            const activeTasks = existingTasks.filter(
              (t) => t.status === 'active' || t.status === 'paused',
            );

            // Per-group task limit (default 3, configurable via MAX_TASKS_PER_GROUP env var)
            const maxTasks = parseInt(
              process.env.MAX_TASKS_PER_GROUP || '3',
              10,
            );
            if (activeTasks.length >= maxTasks) {
              logger.warn(
                { groupFolder, count: activeTasks.length, maxTasks },
                'Task limit reached',
              );
              if (resultStream)
                await redis.xadd(
                  resultStream,
                  '*',
                  'result',
                  `Task limit reached (${maxTasks} active tasks). Cancel an existing task first.`,
                );
              continue;
            }

            // Deduplication: reject if an active task with the same prompt and schedule already exists
            const duplicate = activeTasks.find(
              (t) =>
                t.prompt.trim() === prompt.trim() &&
                t.schedule_type === schedule_type &&
                t.schedule_value === schedule_value,
            );
            if (duplicate) {
              logger.info(
                { groupFolder, duplicateId: duplicate.id },
                'Duplicate task rejected',
              );
              if (resultStream)
                await redis.xadd(
                  resultStream,
                  '*',
                  'result',
                  `A task with the same prompt and schedule already exists (ID: ${duplicate.id}).`,
                );
              continue;
            }

            const scheduleType = schedule_type as 'cron' | 'interval' | 'once';
            let nextRun: string | null = null;

            try {
              if (scheduleType === 'cron') {
                const interval = CronExpressionParser.parse(schedule_value, {
                  tz: TIMEZONE,
                });
                nextRun = interval.next().toISOString();
              } else if (scheduleType === 'interval') {
                const ms = parseInt(schedule_value, 10);
                if (isNaN(ms) || ms <= 0) {
                  logger.warn(
                    { schedule_value },
                    'Invalid interval in task request',
                  );
                  continue;
                }
                nextRun = new Date(Date.now() + ms).toISOString();
              } else if (scheduleType === 'once') {
                const date = new Date(schedule_value);
                if (isNaN(date.getTime())) {
                  logger.warn(
                    { schedule_value },
                    'Invalid timestamp in task request',
                  );
                  continue;
                }
                nextRun = date.toISOString();
              }
            } catch (err) {
              logger.warn(
                { schedule_value, err },
                'Failed to parse schedule in task request',
              );
              continue;
            }

            const finalTaskId =
              taskId ||
              `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            createTask({
              id: finalTaskId,
              group_folder: groupFolder,
              chat_jid: chatJid,
              prompt,
              schedule_type: scheduleType,
              schedule_value,
              context_mode: context_mode === 'group' ? 'group' : 'isolated',
              next_run: nextRun,
              status: 'active',
              created_at: new Date().toISOString(),
            });
            logger.info(
              { taskId: finalTaskId, groupFolder, scheduleType },
              'Task created via task-request stream',
            );
            if (resultStream)
              await redis.xadd(
                resultStream,
                '*',
                'result',
                `Scheduled task "${finalTaskId}" (${scheduleType}: ${schedule_value}). It will run automatically.`,
              );
          } else if (type === 'list_tasks') {
            const tasks = getTasksForGroup(groupFolder);
            const resultStream = obj.resultStream;
            if (resultStream) {
              const summary =
                tasks.length === 0
                  ? 'No scheduled tasks.'
                  : tasks
                      .map(
                        (t) =>
                          `ID: ${t.id} | ${t.schedule_type} ${t.schedule_value} | status: ${t.status} | next: ${t.next_run || 'N/A'} | prompt: ${t.prompt.slice(0, 80)}`,
                      )
                      .join('\n');
              await redis.xadd(resultStream, '*', 'result', summary);
            }
          } else if (type === 'cancel_task') {
            const taskId = obj.taskId;
            const resultStream = obj.resultStream;
            if (taskId) {
              const task = getTaskById(taskId);
              if (task && task.group_folder === groupFolder) {
                deleteTask(taskId);
                logger.info(
                  { taskId, groupFolder },
                  'Task cancelled via task-request stream',
                );
                if (resultStream)
                  await redis.xadd(
                    resultStream,
                    '*',
                    'result',
                    `Task "${taskId}" cancelled.`,
                  );
              } else {
                if (resultStream)
                  await redis.xadd(
                    resultStream,
                    '*',
                    'result',
                    `Task "${taskId}" not found or does not belong to this group.`,
                  );
              }
            }
          } else if (type === 'pause_task') {
            const taskId = obj.taskId;
            const action = obj.action as 'pause' | 'resume';
            const resultStream = obj.resultStream;
            if (taskId && (action === 'pause' || action === 'resume')) {
              const task = getTaskById(taskId);
              if (task && task.group_folder === groupFolder) {
                const newStatus = action === 'pause' ? 'paused' : 'active';
                updateTask(taskId, { status: newStatus });
                logger.info(
                  { taskId, groupFolder, action },
                  'Task status updated via task-request stream',
                );
                if (resultStream)
                  await redis.xadd(
                    resultStream,
                    '*',
                    'result',
                    `Task "${taskId}" ${action}d.`,
                  );
              } else {
                if (resultStream)
                  await redis.xadd(
                    resultStream,
                    '*',
                    'result',
                    `Task "${taskId}" not found or does not belong to this group.`,
                  );
              }
            }
          } else if (type === 'deploy_mcp_server') {
            if (obj.isMain !== 'true') {
              logger.warn({ groupFolder }, 'Unauthorized deploy_mcp_server');
              continue;
            }
            if (obj.name && obj.image) {
              try {
                await deployMcpServer({
                  name: obj.name,
                  image: obj.image,
                  port: obj.port ? Number(obj.port) : undefined,
                  path: obj.path || undefined,
                  command: obj.command ? JSON.parse(obj.command) : undefined,
                  env: obj.env ? JSON.parse(obj.env) : undefined,
                  channels: obj.channels ? JSON.parse(obj.channels) : undefined,
                  allowedTools: obj.allowedTools
                    ? JSON.parse(obj.allowedTools)
                    : undefined,
                  resources: obj.resources
                    ? JSON.parse(obj.resources)
                    : undefined,
                });
                logger.info(
                  { name: obj.name },
                  'MCP server deployed via stream',
                );
              } catch (err) {
                logger.error(
                  { err, name: obj.name },
                  'Failed to deploy MCP server',
                );
              }
            }
          } else if (type === 'remove_mcp_server') {
            if (obj.isMain !== 'true') {
              logger.warn({ groupFolder }, 'Unauthorized remove_mcp_server');
              continue;
            }
            if (obj.name) {
              try {
                await removeMcpServer(obj.name);
                logger.info(
                  { name: obj.name },
                  'MCP server removed via stream',
                );
              } catch (err) {
                logger.error(
                  { err, name: obj.name },
                  'Failed to remove MCP server',
                );
              }
            }
          } else if (type === 'list_mcp_servers') {
            try {
              const servers = listMcpServers();
              if (obj.resultStream)
                await redis.xadd(
                  obj.resultStream,
                  '*',
                  'result',
                  JSON.stringify(servers),
                  'status',
                  'success',
                );
            } catch (err) {
              logger.error({ err }, 'Failed to list MCP servers');
            }
          }
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'Task request watcher error');
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
export interface ControlMessage {
  command: string;
  servers?: string; // JSON-encoded McpServerStatus[] for mcp_update
  [key: string]: unknown;
}

export function startControlChannelWatcher(
  channelName: string,
  onCommand: (msg: ControlMessage) => Promise<void>,
): void {
  const subscriber = getRedisSubscriber();
  const channel = getControlChannel(channelName);
  subscriber.subscribe(channel, (err) => {
    if (err)
      logger.error({ err, channel }, 'Failed to subscribe to control channel');
    else logger.info({ channel }, 'Subscribed to control channel');
  });
  subscriber.on('message', (ch, message) => {
    if (ch !== channel) return;
    try {
      const data = JSON.parse(message) as ControlMessage;
      if (data.command) {
        onCommand(data).catch((err) =>
          logger.error(
            { err, command: data.command },
            'Error handling control command',
          ),
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
