/**
 * Redis-based IPC module for Kubernetes runtime
 * Replaces filesystem-based IPC (ipc.ts) with Redis pub/sub and streams
 */
import { CronExpressionParser } from 'cron-parser';
import { Redis } from 'ioredis';

import { TIMEZONE } from '../config.js';
import { AvailableGroup } from '../runtime/types.js';
import type { CatalogInformer } from './catalog.js';
import type { SecretManager } from './secret-manager.js';
import {
  createTask,
  deleteTask,
  getAllRegisteredGroups,
  getTaskById,
  getTasksForGroup,
  updateTask,
  recordToolJob,
  resolveToolJob,
  getToolJobByIdForGroup,
} from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import {
  getToolJobResultStream,
  getControlChannel,
  getInputStream,
  getOutputChannel,
  getRedisClient,
  getRedisSubscriber,
  getSpawnToolJobStream,
  getSpawnToolPodStream,
  getTaskChannel,
  getTaskRequestStream,
  createStreamWatcherClient,
} from './redis-client.js';
import { TaskRequest } from './types.js';
import { jobRunner } from './job-runner.js';
import { ASSISTANT_NAME } from '../config.js';
import {
  installCapability,
  removeCapability,
  listCapabilities,
} from '../capabilities/index.js';
// loadSpecialists removed — per-group agents.json specialist loading is deprecated.
// Task 12 will clean up the remaining IPC specialist-dispatch path.
import type { OrchestratorMetrics } from '../metrics/orchestrator.js';
import type { PerGroupK8sClient } from '../per-group-capabilities/k8s-client.js';
import { resolveToolByName } from '../tools/reconciler.js';
import type { ToolSpec } from '../tools/types.js';
import {
  provisionCapability,
  listGroupCapabilities,
  removeCapabilityInstance,
  type ProvisionDeps,
} from '../per-group-capabilities/index.js';
import { processCommitChannelConfig } from './ipc-redis-bootstrap.js';
import type { CommitChannelConfigDeps } from './ipc-redis-bootstrap.js';
import {
  getFindToolsStream,
  getFindToolsResultStream,
} from './redis-client.js';
import {
  runToolSelection,
  finalizeCredentialApproval,
} from '../tool-selection/agent.js';
import type { ChatFn } from '../tool-selection/matcher.js';
import { recordAutoToolUse } from '../tool-selection/provenance.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  /**
   * Optional callback invoked when a published message carries `persist: true`
   * (e.g. orphan interruption notices from Story 37). The channel pod should
   * store the notice in its `messages` table with `is_from_me=1, is_bot_message=1`.
   *
   * @param jid       — the chat JID the notice is addressed to
   * @param text      — the notice text
   * @param noticeId  — a stable, deterministic ID for idempotent storage
   */
  storeBotMessage?: (jid: string, text: string, noticeId: string) => void;
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
  metrics?: OrchestratorMetrics;
}

let ipcWatcherRunning = false;
let subscribers: Redis[] = [];
let ipcMetrics: OrchestratorMetrics | undefined;

// Secret management deps — set by registerSecretDeps() called from index.ts
let _secretManager: SecretManager | null = null;
let _catalogInformer: CatalogInformer | null = null;

/**
 * Register secret-management dependencies used by the secret.* and catalog.*
 * IPC handlers. Must be called before startTaskRequestWatcher().
 */
export function registerSecretDeps(
  secretManager: SecretManager,
  catalogInformer: CatalogInformer,
): void {
  _secretManager = secretManager;
  _catalogInformer = catalogInformer;
}

// Per-group capability provision deps — set by registerCapabilityDeps()
let _capabilityDeps: ProvisionDeps | null = null;

/**
 * Register per-group capability provisioning dependencies used by the
 * capability.add / capability.list / capability.remove IPC handlers.
 * Must be called before startTaskRequestWatcher().
 */
export function registerCapabilityDeps(deps: ProvisionDeps): void {
  _capabilityDeps = deps;
}

/** Test-only: reset capability deps. */
export function _resetCapabilityDepsForTest(): void {
  _capabilityDeps = null;
}

// Bootstrap deps — set by registerBootstrapDeps() called from index.ts (Story 174)
let _bootstrapCommitDeps: CommitChannelConfigDeps | null = null;
let _channelBaseImage = 'kubeclaw-agent:latest';
let _bootstrapNamespace = process.env.KUBECLAW_NAMESPACE || 'kubeclaw';

// SSE publisher — set by registerBootstrapSsePublisher() called from admin-shell.ts
// so that bootstrap Redis events can be forwarded to admin SSE clients without
// creating a circular import (admin-shell → ipc-redis, not the reverse).
let _bootstrapSsePublisher: ((type: string, text: string) => void) | null =
  null;

/**
 * Register a callback that will be invoked whenever a bootstrap event worth
 * forwarding arrives on the kubeclaw:bootstrap:* Redis topic. Called from
 * startHttpAdminServer() in admin-shell.ts to wire the event bridge.
 */
export function registerBootstrapSsePublisher(
  fn: (type: string, text: string) => void,
): void {
  _bootstrapSsePublisher = fn;
}

// Story 180: in-memory map of most-recent step label per bootstrapJobId.
// Updated by the bootstrap topic subscriber when a { type: "step" } message arrives.
// Exported so bootstrap-runner.ts can read it when building active entries.
export const currentStepByJob: Map<string, { label: string; ts: string }> =
  new Map();

// In-memory map of the most-recent unanswered admin question per bootstrapJobId.
// Populated by the bootstrap topic subscriber when a { type: "question" } message
// arrives (published by the bootstrap pod's ask_admin tool), and cleared when the
// admin forwards a reply via reply_to_bootstrap. The admin shell reads this to
// surface the pending question into the admin LLM's context so it knows what to
// forward — without it, ask_admin questions never reach the admin and the
// bootstrap pod stalls waiting for a reply.
export const pendingBootstrapQuestionByJob: Map<
  string,
  { text: string; ts: string }
> = new Map();

/**
 * Register bootstrap dependencies used by the commit_channel_config IPC handler.
 * Must be called before startBootstrapTaskWatcher().
 */
export function registerBootstrapDeps(
  deps: CommitChannelConfigDeps,
  channelBaseImage: string,
  namespace: string,
): void {
  _bootstrapCommitDeps = deps;
  _channelBaseImage = channelBaseImage;
  _bootstrapNamespace = namespace;
}

/**
 * Watch the kubeclaw:bootstrap-task:* pub/sub pattern for commit_channel_config
 * messages sent by bootstrap pods. Each message is handled by processCommitChannelConfig.
 *
 * Story 180: also psubscribes kubeclaw:bootstrap:* to capture { type: "step" }
 * messages published by bootstrap pods via report_step, updating currentStepByJob.
 */
export function startBootstrapTaskWatcher(): void {
  const subscriber = getRedisSubscriber();

  // Existing: listen for commit_channel_config messages from bootstrap pods.
  subscriber.psubscribe('kubeclaw:bootstrap-task:*', (err) => {
    if (err)
      logger.error({ err }, 'Failed to subscribe to bootstrap task pattern');
    else
      logger.info(
        'Bootstrap task watcher subscribed (kubeclaw:bootstrap-task:*)',
      );
  });

  // Story 180: listen for step/question/commit_ack messages published on the
  // SSE-forward topic by bootstrap pods so we can update currentStepByJob.
  subscriber.psubscribe('kubeclaw:bootstrap:*', (err) => {
    if (err)
      logger.error({ err }, 'Failed to subscribe to bootstrap topic pattern');
    else
      logger.info('Bootstrap step watcher subscribed (kubeclaw:bootstrap:*)');
  });

  subscriber.on(
    'pmessage',
    (_pattern: string, channel: string, message: string) => {
      // Handle commit_channel_config (existing path)
      if (channel.startsWith('kubeclaw:bootstrap-task:')) {
        if (!_bootstrapCommitDeps) {
          logger.error(
            { channel },
            'commit_channel_config received but bootstrap deps not registered',
          );
          return;
        }
        try {
          const data = JSON.parse(message);
          if (data.type === 'commit_channel_config') {
            void processCommitChannelConfig(
              data,
              _bootstrapCommitDeps,
              _bootstrapNamespace,
              _channelBaseImage,
            );
          }
        } catch (err) {
          logger.error(
            { err, channel },
            'Error processing bootstrap task message',
          );
        }
        return;
      }

      // Story 180: handle step messages on kubeclaw:bootstrap:<bootstrapJobId>
      if (channel.startsWith('kubeclaw:bootstrap:')) {
        const bootstrapJobId = channel.slice('kubeclaw:bootstrap:'.length);
        try {
          const data = JSON.parse(message) as {
            type?: string;
            label?: string;
            text?: string;
            ts?: string;
          };
          if (data.type === 'step' && typeof data.label === 'string') {
            const label = data.label.slice(0, 200); // server-side 200-char cap
            const ts = data.ts ?? new Date().toISOString();
            currentStepByJob.set(bootstrapJobId, { label, ts });
            logger.debug(
              { bootstrapJobId, label },
              'bootstrap step label recorded',
            );
            _bootstrapSsePublisher?.('bootstrap', label);
          } else if (
            data.type === 'question' &&
            typeof data.text === 'string'
          ) {
            const ts = data.ts ?? new Date().toISOString();
            // Cap length the same way step labels are capped — the text is
            // embedded verbatim into the admin LLM prompt on every turn.
            const text = data.text.slice(0, 500);
            pendingBootstrapQuestionByJob.set(bootstrapJobId, { text, ts });
            logger.info(
              { bootstrapJobId },
              'bootstrap admin question recorded (awaiting reply_to_bootstrap)',
            );
            _bootstrapSsePublisher?.('bootstrap', text);
          } else if (data.type === 'timeout' && typeof data.text === 'string') {
            logger.info(
              { bootstrapJobId },
              'bootstrap timeout received; forwarding to admin SSE',
            );
            _bootstrapSsePublisher?.('bootstrap', data.text.slice(0, 500));
          }
        } catch (err) {
          logger.warn(
            { err, channel },
            'Error processing bootstrap topic message',
          );
        }
      }
    },
  );
}

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

// Track tool pod jobs per tool job for cleanup
const toolPodsByAgent = new Map<string, Set<string>>();

/**
 * Active K8s agent-job names keyed by groupFolder.
 * Populated by startToolJobSpawnWatcher when onProcess fires (i.e. the K8s Job
 * exists and has a real name). Cleared when the job resolves or rejects.
 * Used by the job.cancel IPC handler to look up the K8s job name from a
 * groupFolder without requiring the channel pod to know the jobName.
 */
const activeAgentJobsByGroup = new Map<string, string>();

interface AgentOutputMessage {
  type: 'message' | 'task_request';
  jobId?: string;
  chatJid?: string;
  text?: string;
  payload?: TaskRequest;
  /**
   * When `true`, the channel pod should also persist this message in its
   * `messages` table with `is_from_me=1, is_bot_message=1` (Story 37 AC4).
   */
  persist?: boolean;
  /**
   * Stable, deterministic ID for the message row.  Required when `persist`
   * is `true` so the channel can store the row idempotently.
   */
  noticeId?: string;
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
  ipcMetrics = deps.metrics;

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
          // AC4 (Story 37): persist interruption notices in the messages table
          // with is_from_me=1, is_bot_message=1 BEFORE delivering to SSE so
          // the DB row is always present even if the SSE delivery fails.
          if (data.persist && data.noticeId && deps.storeBotMessage) {
            try {
              deps.storeBotMessage(data.chatJid, data.text, data.noticeId);
            } catch (err) {
              logger.warn(
                { chatJid: data.chatJid, noticeId: data.noticeId, err },
                'Redis IPC: failed to persist bot message; delivering to SSE anyway',
              );
            }
          }
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
    setTimeout(checkNewGroups, 1000); // 1s group-subscription poll
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

    case 'install_capability':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized install_capability attempt blocked',
        );
        break;
      }
      if (data.spec) {
        try {
          const spec = JSON.parse(data.spec);
          await installCapability(spec);
          logger.info(
            { sourceGroup, name: spec.name, kind: spec.kind },
            'Capability installed via IPC',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to install capability');
        }
      }
      break;

    case 'remove_capability':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remove_capability attempt blocked',
        );
        break;
      }
      if (data.name) {
        try {
          await removeCapability(data.name);
          logger.info(
            { sourceGroup, name: data.name },
            'Capability removed via IPC',
          );
        } catch (err) {
          logger.error({ err, name: data.name }, 'Failed to remove capability');
        }
      }
      break;

    case 'list_capabilities':
      try {
        const capabilities = listCapabilities();
        const resultStream = data.resultStream;
        if (resultStream) {
          const client = getRedisClient();
          await client.xadd(
            resultStream,
            '*',
            'result',
            JSON.stringify(capabilities),
            'status',
            'success',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to list capabilities');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown Redis IPC task type');
  }
}

/**
 * Clean up all tool pods associated with a tool job
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
 * Write a diagnostic error entry to the tool-results stream for a spawn that
 * was rejected before any pod was created (unknown tool name, channel-ACL
 * mismatch). NOTE: the channel-side reader matches results by requestId, which
 * the spawn stream does not currently carry — so this entry surfaces the reason
 * in orchestrator logs/diagnostics, but the waiting channel call still ends via
 * its own TOOL_TIMEOUT rather than seeing this message. Threading requestId
 * through the spawn stream for exact matching is a documented future enhancement
 * (see docs/superpowers/plans/2026-06-13-tool-catalog.md, Task 8 / Out of scope).
 */
async function writeToolError(
  agentJobId: string,
  category: string,
  message: string,
): Promise<void> {
  const client = getRedisClient();
  const stream = `kubeclaw:toolresults:${agentJobId}:${category}`;
  await client.xadd(stream, '*', 'error', message);
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

export async function startToolPodSpawnWatcher(
  resolveTool: (name: string) => ToolSpec | undefined = (n) =>
    resolveToolByName(n),
): Promise<void> {
  // Each blocking-XREAD watcher needs its own dedicated connection.
  // Multiple watchers sharing one connection serialize behind each other's
  // BLOCK timeout; a fresh connection per watcher lets them run concurrently.
  const redis = createStreamWatcherClient();
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
          ipcMetrics?.recordRedisMessage({ stream });
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];

          const { agentJobId, groupFolder, category, timeout, channel } = obj;
          if (!agentJobId || !groupFolder || !category) continue;

          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');
          const timeoutMs = Number(timeout) || 60_000;
          const maxToolOutputBytes = obj.maxToolOutputBytes
            ? Number(obj.maxToolOutputBytes)
            : undefined;

          try {
            // Catalog tool: orchestrator resolves the spec by name and
            // re-checks the channel ACL. The channel only sent the name.
            const spec = resolveTool(category);
            if (!spec) {
              await writeToolError(
                agentJobId,
                category,
                `Unknown tool: ${category}`,
              );
              logger.warn(
                { agentJobId, category },
                'Unknown catalog tool; dropped spawn',
              );
              continue;
            }
            if (
              spec.channels?.length &&
              !spec.channels.includes(channel ?? '')
            ) {
              await writeToolError(
                agentJobId,
                category,
                `Tool ${category} is not available on this channel`,
              );
              logger.warn(
                { agentJobId, category, channel },
                'Catalog tool not scoped to channel; rejected',
              );
              continue;
            }
            // maxToolOutputBytes is not forwarded to catalog sidecar tools —
            // output sizing for the tool-bridge path is out of scope here
            // (tracked under spawn-path hardening, not the catalog work).
            await jobRunner.createSidecarToolPodJob({
              agentJobId,
              groupFolder,
              toolName: category,
              toolSpec: spec,
              timeout: timeoutMs,
              groupsPvc,
              sessionsPvc,
            });
            recordAutoToolUse(category, Date.now());
            logger.debug(
              { agentJobId, category, image: spec.image },
              'Resolved + spawned catalog sidecar tool pod',
            );
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
 * Watch the kubeclaw:spawn-agent-job stream and run full K8s tool jobs on
 * behalf of channel pods. Writes the final result to
 * kubeclaw:agent-job-result:{agentJobId} so the channel pod can return it.
 */
export async function startToolJobSpawnWatcher(): Promise<void> {
  // Each blocking-XREAD watcher needs its own dedicated connection.
  // Multiple watchers sharing one connection serialize behind each other's
  // BLOCK timeout; a fresh connection per watcher lets them run concurrently.
  const redis = createStreamWatcherClient();
  const stream = getSpawnToolJobStream();
  let lastId = await resolveStreamTip(redis, stream);

  // Story 43 / Story 46: wire publishers on the jobRunner singleton so
  // DeadlineExceeded and OOMKilled events can emit a user-visible notice via
  // the group's Redis pub/sub output channel.  The two share the same
  // ToolJobTimeoutPublisher shape; we set them as sibling fields rather than
  // sharing a single instance so a future refactor can specialise either.
  const failurePublisher = {
    async publish(
      groupFolder: string,
      chatJid: string,
      text: string,
      noticeId: string,
    ): Promise<void> {
      await getRedisClient().publish(
        getOutputChannel(groupFolder),
        JSON.stringify({
          type: 'message',
          chatJid,
          text,
          persist: true,
          noticeId,
        }),
      );
    },
  };
  jobRunner.timeoutPublisher = failurePublisher;
  jobRunner.oomKillPublisher = failurePublisher;

  logger.info('Tool job spawn watcher started');

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
          ipcMetrics?.recordRedisMessage({ stream });
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
            messageId,
          } = obj;
          if (!agentJobId || !groupFolder || !chatJid || !prompt) continue;

          const resultStream = getToolJobResultStream(agentJobId);
          const { groupsPvc, sessionsPvc } = channelPvcNames(channel ?? '');

          // Specialist prompt resolution from agents.json is deprecated;
          // global specialist dispatch is now handled in channel-runner.
          // Task 12 will remove this IPC handler entirely.
          const resolvedPrompt = prompt;

          // Look up the parent group's llmProvider so the child job inherits it
          const allGroups = getAllRegisteredGroups();
          const parentGroup = Object.values(allGroups).find(
            (g) => g.folder === groupFolder,
          );

          // Fire-and-forget: run the tool job and write result when done
          const group = {
            name: groupFolder,
            folder: groupFolder,
            trigger: '',
            added_at: new Date().toISOString(),
            llmProvider: parentGroup?.llmProvider,
          };

          jobRunner
            .runToolJob(
              group,
              {
                groupFolder,
                chatJid,
                isMain: false,
                prompt: resolvedPrompt,
                assistantName: ASSISTANT_NAME,
                groupsPvc,
                sessionsPvc,
              },
              // onProcess: as soon as the K8s Job exists, write an end-of-input
              // (eoi) signal so the agent pod exits its follow-up wait loop after
              // completing the initial prompt. Without this the pod waits
              // indefinitely for further input and the K8s Job never reaches
              // Succeeded state, causing waitForJobCompletion — and therefore the
              // result write to resultStream — to never fire.
              // NOTE: this is NOT a cancel signal — the agent must finish its
              // current work (including in-flight tool rounds) before exiting.
              (jobName: string) => {
                // Record the job so orphan reconciliation can detect it on restart.
                // messageId is the user-facing ID from the POST /message
                // response (Story 25) — passed through the IPC envelope so the
                // interruption notice (AC2) can reference it.
                try {
                  recordToolJob(
                    jobName,
                    groupFolder,
                    chatJid,
                    messageId ?? null,
                  );
                } catch (err) {
                  logger.warn(
                    { jobName, groupFolder, err },
                    'Failed to record tool job for orphan tracking',
                  );
                }
                // Track so job.cancel IPC can find the K8s job name by groupFolder.
                activeAgentJobsByGroup.set(groupFolder, jobName);
                const inputStream = getInputStream(jobName);
                redis
                  .xadd(inputStream, '*', 'type', 'eoi')
                  .then(() =>
                    logger.debug(
                      { agentJobId, jobName },
                      'Sent end-of-input signal to single-prompt tool job',
                    ),
                  )
                  .catch((err) =>
                    logger.warn(
                      { agentJobId, jobName, err },
                      'Failed to send end-of-input signal to tool job',
                    ),
                  );
              },
            )
            .then(async (output) => {
              // Job done — remove from active tracking.
              activeAgentJobsByGroup.delete(groupFolder);
              // Mark the job as completed so it is not treated as an orphan.
              // Story 43: skip for 'timeout' — job-runner already called
              // resolveToolJob(jobId, 'timeout') in the DeadlineExceeded branch.
              // Story 46: same for 'oomkill' — already resolved by the OOMKill
              // branch in job-runner. The DB row's WHERE status='active' guard
              // would no-op anyway, but skip explicitly to avoid the warn log
              // on the (always-empty) result set.
              if (
                output.jobId &&
                output.status !== 'timeout' &&
                output.status !== 'oomkill'
              ) {
                try {
                  resolveToolJob(output.jobId, 'completed');
                } catch (err) {
                  logger.warn(
                    { jobId: output.jobId, err },
                    'Failed to resolve tool job tracking record',
                  );
                }
              }
              const result =
                output.result ?? output.error ?? 'Tool job completed';
              await redis.xadd(
                resultStream,
                '*',
                'result',
                String(result),
                'status',
                output.status,
              );
              logger.debug({ agentJobId }, 'Tool job result written to stream');
            })
            .catch(async (err) => {
              // Job errored — remove from active tracking.
              activeAgentJobsByGroup.delete(groupFolder);
              logger.error({ agentJobId, err }, 'Tool job failed');
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
            'Spawned tool job for channel pod',
          );
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'Tool job spawn watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

export interface TaskRequestWatcherDeps {
  /**
   * Called when a schedule_task arrives for a group that is not yet registered
   * in the orchestrator's in-memory state. Implementations should persist the
   * group to the orchestrator's DB and update its in-memory registry so the
   * task scheduler can find the group when the task fires.
   */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

/**
 * Watch the kubeclaw:task-requests stream for task creation requests from
 * channel pods (via DirectLLMRunner). Unlike the per-group pub/sub task
 * channels, this stream is always watched regardless of which groups the
 * orchestrator knows about.
 */
export async function startTaskRequestWatcher(
  deps?: TaskRequestWatcherDeps,
): Promise<void> {
  // Each blocking-XREAD watcher needs its own dedicated connection.
  // Multiple watchers sharing one connection serialize behind each other's
  // BLOCK timeout; a fresh connection per watcher lets them run concurrently.
  const redis = createStreamWatcherClient();
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
          ipcMetrics?.recordRedisMessage({ stream });
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

            // Ensure the group is registered in the orchestrator's DB so the
            // task scheduler can find it when the task fires.  Channel pods
            // auto-register groups only in their own per-channel SQLite;
            // the orchestrator's messages.db may not have the entry yet.
            if (deps?.registerGroup) {
              try {
                const knownGroups = getAllRegisteredGroups();
                const alreadyKnown = Object.values(knownGroups).some(
                  (g) => g.folder === groupFolder,
                );
                if (!alreadyKnown && isValidGroupFolder(groupFolder)) {
                  const syntheticGroup: RegisteredGroup = {
                    name: chatJid,
                    folder: groupFolder,
                    trigger: '',
                    added_at: new Date().toISOString(),
                    requiresTrigger: false,
                    containerConfig: { direct: true },
                  };
                  deps.registerGroup(chatJid, syntheticGroup);
                  logger.info(
                    { chatJid, groupFolder },
                    'Auto-registered group in orchestrator from task-request stream',
                  );
                }
              } catch (err) {
                logger.warn(
                  { chatJid, groupFolder, err },
                  'Failed to auto-register group from task-request stream; task will still be created',
                );
              }
            }

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
          } else if (type === 'install_capability') {
            if (obj.isMain !== 'true') {
              logger.warn({ groupFolder }, 'Unauthorized install_capability');
              continue;
            }
            try {
              const spec = JSON.parse(obj.spec);
              await installCapability(spec);
              logger.info(
                { name: spec.name, kind: spec.kind },
                'Capability installed via stream',
              );
            } catch (err) {
              logger.error({ err }, 'Failed to install capability');
            }
          } else if (type === 'remove_capability') {
            if (obj.isMain !== 'true') {
              logger.warn({ groupFolder }, 'Unauthorized remove_capability');
              continue;
            }
            if (obj.name) {
              try {
                await removeCapability(obj.name);
                logger.info(
                  { name: obj.name },
                  'Capability removed via stream',
                );
              } catch (err) {
                logger.error(
                  { err, name: obj.name },
                  'Failed to remove capability',
                );
              }
            }
          } else if (type === 'list_capabilities') {
            try {
              const capabilities = listCapabilities();
              if (obj.resultStream)
                await redis.xadd(
                  obj.resultStream,
                  '*',
                  'result',
                  JSON.stringify(capabilities),
                  'status',
                  'success',
                );
            } catch (err) {
              logger.error({ err }, 'Failed to list capabilities');
            }
          } else if (type === 'secret.add') {
            const { group, catalogId, fields: fieldsJson, resultStream } = obj;
            if (!group || !catalogId || !fieldsJson || !resultStream) continue;
            let response: string;
            try {
              const fields = JSON.parse(fieldsJson) as Record<string, string>;
              if (!_secretManager)
                throw new Error('SecretManager not initialised');
              await _secretManager.setGroupSecret(group, catalogId, fields);
              logger.info(
                { group, catalogId },
                'secret.add: credential stored via IPC',
              );
              response = JSON.stringify({ ok: true });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ group, catalogId, error }, 'secret.add failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'secret.remove') {
            const { group, catalogId, resultStream } = obj;
            if (!group || !catalogId || !resultStream) continue;
            let response: string;
            try {
              if (!_secretManager)
                throw new Error('SecretManager not initialised');
              await _secretManager.deleteGroupSecret(group, catalogId);
              logger.info(
                { group, catalogId },
                'secret.remove: credential deleted via IPC',
              );
              response = JSON.stringify({ ok: true });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ group, catalogId, error }, 'secret.remove failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'secret.list') {
            const { group, resultStream } = obj;
            if (!group || !resultStream) continue;
            let response: string;
            try {
              if (!_secretManager)
                throw new Error('SecretManager not initialised');
              const entries = await _secretManager.listGroupSecrets(group);
              response = JSON.stringify({ ok: true, result: entries });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ group, error }, 'secret.list failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'catalog.list') {
            const { resultStream } = obj;
            if (!resultStream) continue;
            let response: string;
            try {
              if (!_catalogInformer)
                throw new Error('CatalogInformer not initialised');
              const catalog = _catalogInformer.getCatalog();
              response = JSON.stringify({ ok: true, result: catalog });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ error }, 'catalog.list failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'capability.add') {
            // Provision a per-group capability for the requesting group.
            const { capabilityType, resultStream } = obj;
            if (!groupFolder || !capabilityType || !resultStream) continue;
            let response: string;
            try {
              if (!_capabilityDeps)
                throw new Error('CapabilityDeps not initialised');
              const result = await provisionCapability(
                groupFolder,
                capabilityType,
                _capabilityDeps,
              );
              if (result.ok) {
                response = JSON.stringify({
                  ok: true,
                  result: {
                    deploymentName: result.deploymentName,
                    message: result.message,
                    alreadyProvisioned: result.alreadyProvisioned ?? false,
                  },
                });
              } else {
                response = JSON.stringify({ ok: false, error: result.message });
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn(
                { groupFolder, capabilityType, error },
                'capability.add failed',
              );
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'capability.list') {
            // List per-group capability instances for the requesting group.
            const { resultStream } = obj;
            if (!groupFolder || !resultStream) continue;
            let response: string;
            try {
              if (!_capabilityDeps)
                throw new Error('CapabilityDeps not initialised');
              const entries = listGroupCapabilities(
                groupFolder,
                _capabilityDeps,
              );
              response = JSON.stringify({ ok: true, result: entries });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ groupFolder, error }, 'capability.list failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'capability.remove') {
            // Remove a per-group capability instance for the requesting group.
            const { capabilityType, resultStream } = obj;
            if (!groupFolder || !capabilityType || !resultStream) continue;
            let response: string;
            try {
              if (!_capabilityDeps)
                throw new Error('CapabilityDeps not initialised');
              const result = await removeCapabilityInstance(
                groupFolder,
                capabilityType,
                _capabilityDeps,
              );
              if (result.ok) {
                response = JSON.stringify({
                  ok: true,
                  result: { message: result.message },
                });
              } else {
                response = JSON.stringify({ ok: false, error: result.message });
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn(
                { groupFolder, capabilityType, error },
                'capability.remove failed',
              );
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
          } else if (type === 'job.cancel') {
            // Cancel the in-flight K8s tool job for a group.
            // The channel pod sends groupFolder; we look up the K8s job name,
            // delete the job, and publish a "Cancelled" notice back to the
            // channel's output pub/sub so it appears in the SSE stream.
            //
            // Story 66: if jobId is present, perform targeted cancel with DB ownership check.
            // Story 49: if no jobId, do group-level cancel (legacy path).
            const { resultStream: cancelResultStream, jobId: cancelJobId } =
              obj;

            if (cancelJobId) {
              // Story 66: targeted cancel by jobId with DB ownership check.
              const row = getToolJobByIdForGroup(cancelJobId, groupFolder);
              if (!row) {
                // Unknown id or belongs to a different group — same wording for both.
                logger.info(
                  { groupFolder, cancelJobId },
                  'job.cancel (by id): not found or cross-group',
                );
                if (cancelResultStream)
                  await redis.xadd(
                    cancelResultStream,
                    '*',
                    'result',
                    JSON.stringify({ ok: true, status: 'not_found' }),
                  );
              } else if (row.status !== 'active') {
                // Job exists for this group but is already resolved.
                logger.info(
                  { groupFolder, cancelJobId, currentStatus: row.status },
                  'job.cancel (by id): job is not active',
                );
                if (cancelResultStream)
                  await redis.xadd(
                    cancelResultStream,
                    '*',
                    'result',
                    JSON.stringify({
                      ok: true,
                      status: 'not_active',
                      currentStatus: row.status,
                    }),
                  );
              } else {
                // Active row found for this group — look up K8s job name and stop it.
                const jobName = activeAgentJobsByGroup.get(groupFolder);
                if (!jobName) {
                  // DB says active but the K8s job name is gone — treat as already stopped.
                  logger.info(
                    { groupFolder, cancelJobId },
                    'job.cancel (by id): active in DB but no K8s job tracked — treating as stopped',
                  );
                  if (cancelResultStream)
                    await redis.xadd(
                      cancelResultStream,
                      '*',
                      'result',
                      JSON.stringify({ ok: true, status: 'cancelled' }),
                    );
                } else {
                  try {
                    await jobRunner.stopJob(jobName);
                    activeAgentJobsByGroup.delete(groupFolder);
                    logger.info(
                      { groupFolder, cancelJobId, jobName },
                      'job.cancel (by id): job stopped',
                    );
                    if (cancelResultStream)
                      await redis.xadd(
                        cancelResultStream,
                        '*',
                        'result',
                        JSON.stringify({
                          ok: true,
                          status: 'cancelled',
                          jobName,
                        }),
                      );
                  } catch (err) {
                    activeAgentJobsByGroup.delete(groupFolder);
                    const error =
                      err instanceof Error ? err.message : String(err);
                    logger.error(
                      { groupFolder, cancelJobId, jobName, error },
                      'job.cancel (by id): failed to stop job',
                    );
                    if (cancelResultStream)
                      await redis.xadd(
                        cancelResultStream,
                        '*',
                        'result',
                        JSON.stringify({ ok: false, error }),
                      );
                  }
                }
              }
            } else {
              // Story 49: legacy /cancel — find active K8s job for the group.
              const jobName = activeAgentJobsByGroup.get(groupFolder);
              if (!jobName) {
                logger.info(
                  { groupFolder },
                  'job.cancel: no active job for group',
                );
                if (cancelResultStream)
                  await redis.xadd(
                    cancelResultStream,
                    '*',
                    'result',
                    JSON.stringify({ ok: true, status: 'no_active_job' }),
                  );
              } else {
                try {
                  await jobRunner.stopJob(jobName);
                  // Clear the map entry immediately on success so a subsequent
                  // /cancel returns "no active job" rather than failing on a
                  // stale entry. (stopJob already silently swallows NotFound.)
                  activeAgentJobsByGroup.delete(groupFolder);
                  logger.info(
                    { groupFolder, jobName },
                    'job.cancel: job stopped',
                  );

                  // Publish a "Cancelled" notice to the channel's output channel
                  // using the same envelope as regular bot messages so the channel
                  // pod's storeBotMessage callback persists it to conversation_history
                  // with is_bot_message=1 and streams it to the SSE client.
                  // Publish failure is non-fatal: the job IS stopped; SSE delivery
                  // is best-effort.
                  const noticeId = `cancel-${Date.now()}-${groupFolder}`;
                  const outputChannel = getOutputChannel(groupFolder);
                  try {
                    await getRedisClient().publish(
                      outputChannel,
                      JSON.stringify({
                        type: 'message',
                        chatJid: obj.chatJid ?? groupFolder,
                        text: 'Cancelled',
                        persist: true,
                        noticeId,
                      }),
                    );
                  } catch (pubErr) {
                    logger.warn(
                      { groupFolder, jobName, err: pubErr },
                      'job.cancel: notice publish failed (job was stopped successfully)',
                    );
                  }

                  if (cancelResultStream)
                    await redis.xadd(
                      cancelResultStream,
                      '*',
                      'result',
                      JSON.stringify({
                        ok: true,
                        status: 'cancelled',
                        jobName,
                      }),
                    );
                } catch (err) {
                  // stopJob threw — clear the map entry anyway so a retried
                  // /cancel doesn't try to stop a job that might already be gone.
                  activeAgentJobsByGroup.delete(groupFolder);
                  const error =
                    err instanceof Error ? err.message : String(err);
                  logger.error(
                    { groupFolder, jobName, error },
                    'job.cancel: failed to stop job',
                  );
                  if (cancelResultStream)
                    await redis.xadd(
                      cancelResultStream,
                      '*',
                      'result',
                      JSON.stringify({ ok: false, error }),
                    );
                }
              }
            } // end else (Story 49 path)
          } else if (type === 'job.logs') {
            // Fetch K8s pod logs for a completed tool job.
            // Group ownership is enforced via DB lookup BEFORE calling K8s.
            const { jobId, resultStream } = obj;
            if (!jobId || !groupFolder || !resultStream) continue;
            let response: string;
            try {
              // Ownership check: only reveal logs for jobs belonging to the
              // requesting group. Returns null for cross-group or missing jobs.
              const row = getToolJobByIdForGroup(jobId, groupFolder);
              if (!row) {
                response = JSON.stringify({ ok: false, error: 'not_found' });
              } else {
                const logs = await jobRunner.getJobLogs(jobId);
                response = JSON.stringify({ ok: true, result: logs });
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.warn({ jobId, groupFolder, error }, 'job.logs failed');
              response = JSON.stringify({ ok: false, error });
            }
            await redis.xadd(resultStream, '*', 'result', response);
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
  /** JSON-encoded CapabilityDiscoveryEntry[] for capabilities_update */
  capabilities?: string;
  /** Channel type for configure command (e.g. telegram, discord) */
  channelType?: string;
  /** Skill document content for channel self-configuration */
  skillDocument?: string;
  [key: string]: unknown;
}

/**
 * Publish a control command to a channel pod.
 * Called by the orchestrator to send configure, reload, etc. commands.
 */
export async function publishControlCommand(
  channelName: string,
  msg: ControlMessage,
): Promise<void> {
  const client = getRedisClient();
  await client.publish(getControlChannel(channelName), JSON.stringify(msg));
  logger.info(
    { channelName, command: msg.command },
    'Published control command to channel',
  );
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
 * @internal Test-only helper — seed a K8s job name into activeAgentJobsByGroup.
 * Allows integration tests to exercise the job.cancel handler without spinning
 * up a real startToolJobSpawnWatcher loop.
 */
export function _testSetActiveAgentJob(
  groupFolder: string,
  jobName: string,
): void {
  activeAgentJobsByGroup.set(groupFolder, jobName);
}

// ── find-tools watcher ────────────────────────────────────────────────────────

export interface FindToolsHandlerDeps {
  chat: ChatFn;
  liveCatalog: () => import('../tools/types.js').ToolSpec[];
  library: () => import('../tools/types.js').ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  /** Write the serialized result back to the caller stream. */
  writeResult: (requestId: string, json: string) => Promise<void>;
  /** Stable server secret used to key approval-token HMACs (mint/verify). */
  secret: string;
}

/**
 * Handle a single message from the kubeclaw:find-tools stream.
 * Exported so it can be unit-tested without a live Redis loop.
 */
export async function handleFindToolsMessage(
  obj: Record<string, string> & { kind?: string },
  deps: FindToolsHandlerDeps,
): Promise<void> {
  const { requestId } = obj;
  if (!requestId) {
    logger.warn({ obj }, 'find-tools message missing requestId; skipped');
    return;
  }

  // Key the approval token on the stable server secret (not a per-request
  // nonce): mint (during the find request) and verify (during the separate
  // approve request) must agree even though the two requests carry different
  // requestIds. Forging a token still requires the secret.
  const nonce = deps.secret;

  let result: import('../tool-selection/types.js').FindToolsResult;

  if (obj.kind === 'approve') {
    const { toolName, catalogId, approvalToken } = obj;
    result = await finalizeCredentialApproval(
      { toolName, catalogId, approvalToken },
      {
        library: deps.library,
        catalogHostLookup: deps.catalogHostLookup,
        reconcile: deps.reconcile,
        now: () => Date.now(),
        nonce,
      },
    );
  } else {
    const { groupFolder, channel, taskDescription } = obj;
    result = await runToolSelection(
      { requestId, groupFolder, channel, taskDescription },
      {
        chat: deps.chat,
        liveCatalog: deps.liveCatalog,
        library: deps.library,
        catalogHostLookup: deps.catalogHostLookup,
        reconcile: deps.reconcile,
        now: () => Date.now(),
        nonce,
      },
    );
  }

  await deps.writeResult(requestId, JSON.stringify(result));
}

/**
 * Watch the kubeclaw:find-tools stream and run tool selection on behalf of
 * channel pods (which have no LLM context). Writes the result JSON to
 * kubeclaw:find-tools-result:{requestId} so the channel pod can read it.
 * Called by the orchestrator at startup.
 */
export async function startFindToolsWatcher(
  deps: Omit<FindToolsHandlerDeps, 'writeResult'>,
): Promise<void> {
  const redis = createStreamWatcherClient();
  const stream = getFindToolsStream();
  let lastId = await resolveStreamTip(redis, stream);

  const writeResult = async (
    requestId: string,
    json: string,
  ): Promise<void> => {
    await getRedisClient().xadd(
      getFindToolsResultStream(requestId),
      '*',
      'result',
      json,
    );
  };

  const handlerDeps: FindToolsHandlerDeps = { ...deps, writeResult };

  logger.info('Find-tools watcher started');

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
          ipcMetrics?.recordRedisMessage({ stream });
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];

          handleFindToolsMessage(obj, handlerDeps).catch((err) =>
            logger.error(
              { err, requestId: obj.requestId },
              'find-tools handler error',
            ),
          );
        }
      }
    } catch (err) {
      if (ipcWatcherRunning) {
        logger.error({ err }, 'Find-tools watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
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
