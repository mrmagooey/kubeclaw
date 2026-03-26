import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  KUBECLAW_MODE,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { loadChannelPlugins } from './channels/plugin-loader.js';
import {
  AvailableGroup,
  ContainerOutput,
  getAgentRunner,
  getRunnerForGroup,
  shutdownAllRunners,
} from './runtime/index.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher as startRedisIpcWatcher, startToolPodSpawnWatcher, startAgentJobSpawnWatcher } from './k8s/ipc-redis.js';
import { getOutputChannel, getRedisClient } from './k8s/redis-client.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { detectMentionedSpecialists, loadSpecialists } from './specialists.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { augmentPrompt } from './rag/retriever.js';
import { indexConversationTurn } from './rag/indexer.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

/** @internal - exported for testing */
export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/** @internal - exported for testing */
export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/** @internal - exported for testing */
export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export async function _processGroupMessages(chatJid: string): Promise<boolean> {
  return processGroupMessages(chatJid);
}

/** @internal - exported for testing */
export function _pushChannel(channel: Channel): void {
  channels.push(channel);
}

/** @internal - exported for testing */
export function _resetState(): void {
  channels.length = 0;
  lastTimestamp = '';
  lastAgentTimestamp = {};
  sessions = {};
  registeredGroups = {};
}

export { recoverPendingMessages as _recoverPendingMessages };

// ---- Skill invocation ----

function loadSkillPrompt(name: string): string | null {
  for (const p of [
    path.join(process.cwd(), '.claude', 'skills', name, 'SKILL.md'),
    `/app/.claude/skills/${name}/SKILL.md`,
  ]) {
    try { return fs.readFileSync(p, 'utf-8'); } catch { /* not found */ }
  }
  return null;
}

function buildSkillPrompt(skillName: string, skillMd: string, extraArgs: string): string {
  return `You are applying the skill "${skillName}".

The pre-compiled plugin has already been copied to /workspace/plugins/ by the orchestrator.
Call deploy_channel with the Kubernetes YAML for the new channel pod when ready.

TOOL MAPPING:
- Edit tool → local_edit  |  Write tool → local_write
- Read tool → local_read  |  Bash / run → local_bash
${extraArgs ? `\nUser arguments: ${extraArgs}\n` : ''}
---

${skillMd}`;
}

async function handleSkillInvocation(
  skillName: string,
  skillMd: string,
  extraArgs: string,
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
): Promise<void> {
  // Copy pre-compiled plugin to PVC — orchestrator has direct fs access
  for (const srcBase of [
    path.join(process.cwd(), '.claude', 'skills', skillName, 'plugins'),
    `/app/.claude/skills/${skillName}/plugins`,
  ]) {
    if (fs.existsSync(srcBase)) {
      fs.mkdirSync('/workspace/plugins', { recursive: true });
      for (const f of fs.readdirSync(srcBase).filter((f) => f.endsWith('.js'))) {
        fs.copyFileSync(path.join(srcBase, f), path.join('/workspace/plugins', f));
        logger.info({ plugin: f, skillName }, 'Copied skill plugin to PVC');
      }
      break;
    }
  }

  // Spawn agent job with superuser=true for remaining SKILL.md steps
  const skillGroup: RegisteredGroup = {
    ...group,
    containerConfig: { ...group.containerConfig, superuser: true },
  };
  await runAgent(skillGroup, buildSkillPrompt(skillName, skillMd, extraArgs), chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) await channel.sendMessage(chatJid, text);
    }
  });
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Check for skill command (main group only): message starting with /skill-name
  if (isMainGroup) {
    const lastMsg = missedMessages[missedMessages.length - 1];
    const content = lastMsg.content.trim();
    if (content.startsWith('/')) {
      const [skillName, ...rest] = content.slice(1).split(/\s+/);
      const skillMd = loadSkillPrompt(skillName);
      if (skillMd) {
        lastAgentTimestamp[chatJid] = lastMsg.timestamp;
        saveState();
        await handleSkillInvocation(skillName, skillMd, rest.join(' '), chatJid, group, channel);
        return true;
      }
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Load specialist agents for this group (if any defined)
  const specialists = loadSpecialists(group.folder);
  const mentionedSpecialists = specialists
    ? detectMentionedSpecialists(prompt, specialists)
    : [];

  // Build agent runs: one per mentioned specialist, or a single main agent run
  const agentRuns =
    mentionedSpecialists.length > 0
      ? mentionedSpecialists.map((s) => ({
          prompt: `<specialist name="${s.name}">\n${s.prompt}\n</specialist>\n\n${prompt}`,
        }))
      : [{ prompt }];

  // Advance cursor in memory so the piping path in startMessageLoop sends
  // only new messages as deltas rather than re-fetching the full history.
  // Do NOT persist yet — if the process crashes before the agent completes,
  // the on-disk cursor stays at its previous position and recovery re-queues
  // these messages on next startup.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  for (const agentRun of agentRuns) {
    const output = await runAgent(group, agentRun.prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    if (output === 'error' || hadError) {
      hadError = true;
      break;
    }
  }

  await channel.setTyping?.(chatJid, false);

  if (hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      saveState();
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Persist the advanced cursor only after the agent completes successfully.
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const provider = group.llmProvider || 'claude';
  const sessionId = sessions[group.folder];

  logger.info(
    { group: group.name, provider, hasProviderOverride: !!group.llmProvider },
    'Running agent with LLM provider',
  );

  const agentRunner = getRunnerForGroup(group);

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  agentRunner.writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  agentRunner.writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Prepend retrieved context from vector store (no-op when RAG is not configured).
  const augmentedPrompt = await augmentPrompt(group.folder, prompt);

  try {
    const output = await agentRunner.runAgent(
      group,
      {
        prompt: augmentedPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      undefined,
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    // Index the conversation turn for future retrieval (non-blocking, non-fatal).
    if (output.result) {
      void indexConversationTurn(group.folder, prompt, output.result);
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  await initDatabase();
  logger.info('Database initialized');
  loadState();
  await loadChannelPlugins('/workspace/plugins');

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await shutdownAllRunners();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // In orchestrator mode, channels run in dedicated channel pods — skip inline loading.
  if (KUBECLAW_MODE !== 'orchestrator') {
    const registeredChannelNames = getRegisteredChannelNames();
    logger.info({ channels: registeredChannelNames }, 'Registered channel factories');

    for (const channelName of registeredChannelNames) {
      logger.info({ channel: channelName }, 'Creating channel');
      const factory = getChannelFactory(channelName)!;
      const channel = factory(channelOpts);
      if (!channel) {
        logger.warn(
          { channel: channelName },
          'Channel installed but credentials missing — skipping.',
        );
        continue;
      }
      channels.push(channel);
      await channel.connect();
      logger.info({ channel: channelName }, 'Channel connected successfully');
    }
  } else {
    logger.info('Orchestrator mode: channels run in dedicated pods, skipping inline channel init');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: () => {},
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (!text) return;
      if (KUBECLAW_MODE === 'orchestrator') {
        // Channels run in separate pods — route via Redis pub/sub to the channel pod
        const group = registeredGroups[jid];
        if (!group) {
          logger.warn({ jid }, 'No registered group for JID, cannot route scheduled message');
          return;
        }
        await getRedisClient().publish(
          getOutputChannel(group.folder),
          JSON.stringify({ type: 'message', chatJid: jid, text }),
        );
      } else {
        const channel = findChannel(channels, jid);
        if (!channel) {
          logger.warn({ jid }, 'No channel owns JID, cannot send message');
          return;
        }
        await channel.sendMessage(jid, text);
      }
    },
  });

  const ipcDeps = {
    sendMessage: (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (
      gf: string,
      im: boolean,
      ag: AvailableGroup[],
      rj: Set<string>,
    ) => getAgentRunner().writeGroupsSnapshot(gf, im, ag, rj),
  };
  startRedisIpcWatcher(ipcDeps);
  startToolPodSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Tool pod spawn watcher crashed'),
  );
  startAgentJobSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Agent job spawn watcher crashed'),
  );
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
