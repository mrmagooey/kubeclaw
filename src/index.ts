import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
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
import {
  startIpcWatcher as startRedisIpcWatcher,
  startToolPodSpawnWatcher,
  startAgentJobSpawnWatcher,
  startTaskRequestWatcher,
} from './k8s/ipc-redis.js';
import { getOutputChannel, getRedisClient } from './k8s/redis-client.js';
import { findChannel, formatMessages, formatOutbound, stripInternalTags } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { detectMentionedSpecialists, loadSpecialists } from './specialists.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { RawAttachment } from './k8s/types.js';
import {
  IMAGE_ATTACHMENT_PATTERN,
  PDF_ATTACHMENT_PATTERN,
} from './attachment-markers.js';
import { logger } from './logger.js';
import { augmentPrompt } from './rag/retriever.js';
import { indexConversationTurn } from './rag/indexer.js';
import { startHttpAdminServer } from './admin-shell.js';
import { handleSendFileMarkers } from './outbound-media.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// ── Orchestrator health server ────────────────────────────────────────────────
let healthRedisReady = false;
let healthGroupsLoaded = false;

function startOrchestratorHealthServer(): void {
  const port = parseInt(process.env.HEALTH_PORT || '8080', 10);
  http
    .createServer((req, res) => {
      if (req.url === '/liveness' && req.method === 'GET') {
        // Liveness: just checks the process is responsive (never fails unless hung)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
      } else if (req.url === '/health' && req.method === 'GET') {
        // Readiness: checks full startup (Redis connected, groups loaded)
        const ok = healthRedisReady && healthGroupsLoaded;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: ok ? 'ok' : 'starting',
            redis: healthRedisReady,
            groups: healthGroupsLoaded,
            groupCount: Object.keys(registeredGroups).length,
            uptime: process.uptime(),
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Orchestrator health server started');
    });
}

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
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      /* not found */
    }
  }
  return null;
}

function buildSkillPrompt(
  skillName: string,
  skillMd: string,
  extraArgs: string,
): string {
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
      for (const f of fs
        .readdirSync(srcBase)
        .filter((f) => f.endsWith('.js'))) {
        fs.copyFileSync(
          path.join(srcBase, f),
          path.join('/workspace/plugins', f),
        );
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
  await runAgent(
    skillGroup,
    buildSkillPrompt(skillName, skillMd, extraArgs),
    chatJid,
    async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = stripInternalTags(raw);
        if (text) await channel.sendMessage(chatJid, text);
      }
    },
  );
}

interface AttachmentMarkerHandler {
  // regex with positional groups: group 1 = path, group 2 = caption (optional)
  pattern: RegExp;
  mediaType: string; // used when calling preprocessor
  // how to rewrite after preprocessing: given the done-path content, return replacement string
  rewrite: (outputPath: string, caption?: string) => string;
  fallback: (filename: string) => string;
}

const ATTACHMENT_HANDLERS: AttachmentMarkerHandler[] = [
  {
    pattern: IMAGE_ATTACHMENT_PATTERN,
    mediaType: 'image/jpeg',
    rewrite: (outputPath) => `[Image: ${outputPath}]`,
    fallback: (filename) => `[Image: ${filename} (processing failed)]`,
  },
  {
    pattern: PDF_ATTACHMENT_PATTERN,
    mediaType: 'application/pdf',
    rewrite: () => '', // PDF handler reads .txt inline
    fallback: (filename) => `[Attachment: ${filename} (processing failed)]`,
  },
];

function extractAttachments(
  messages: Array<{ content: string }>,
): RawAttachment[] {
  const result: RawAttachment[] = [];
  for (const handler of ATTACHMENT_HANDLERS) {
    for (const msg of messages) {
      // Reset lastIndex for each message since the regex has the global flag
      handler.pattern.lastIndex = 0;
      for (const m of msg.content.matchAll(handler.pattern)) {
        result.push({
          rawPath: m[1],
          mediaType: handler.mediaType,
          caption: m[2],
        });
      }
    }
  }
  return result;
}

function rewriteAttachmentMarkers<T extends { content: string }>(
  messages: T[],
  groupDir: string,
): T[] {
  return messages.map((msg) => {
    let content = msg.content;
    for (const handler of ATTACHMENT_HANDLERS) {
      handler.pattern.lastIndex = 0;
      content = content.replace(
        handler.pattern,
        (_match: string, rawPath: string, caption?: string) => {
          const donePath = path.join(groupDir, rawPath + '.done');
          if (!fs.existsSync(donePath)) {
            return handler.fallback(path.basename(rawPath));
          }
          const outputPath = fs.readFileSync(donePath, 'utf-8').trim();
          return handler.rewrite(outputPath, caption);
        },
      );
    }
    return { ...msg, content };
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
  let missedMessages = getMessagesSince(
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
        await handleSkillInvocation(
          skillName,
          skillMd,
          rest.join(' '),
          chatJid,
          group,
          channel,
        );
        return true;
      }
    }
  }

  // Preprocessing gate: spawn K8s job to process raw attachments before agent runs
  const rawAttachments = extractAttachments(missedMessages);
  if (rawAttachments.length > 0) {
    const runner = getRunnerForGroup(group);
    if (runner.runPreprocessingJob) {
      logger.info(
        { group: group.name, count: rawAttachments.length },
        'Spawning attachment preprocessing job',
      );
      const groupDir = path.join(GROUPS_DIR, group.folder);
      const ok = await runner.runPreprocessingJob(
        group,
        rawAttachments,
        {
          groupsPvc: (group as any).groupsPvc,
        },
      );
      if (!ok) {
        logger.warn(
          { group: group.name },
          'Preprocessing job failed — continuing with unprocessed attachments',
        );
      }
      missedMessages = rewriteAttachmentMarkers(missedMessages, groupDir);
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
      ? mentionedSpecialists.map((s) => {
          // Merge specialist overrides onto the base group
          const specialistGroup: RegisteredGroup = {
            ...group,
            // Override llmProvider if specialist specifies one
            ...(s.llmProvider !== undefined && {
              llmProvider: s.llmProvider as RegisteredGroup['llmProvider'],
            }),
            // Merge containerConfig: specialist's partial overrides win
            containerConfig: s.containerConfig
              ? {
                  ...group.containerConfig,
                  ...(s.containerConfig as RegisteredGroup['containerConfig']),
                }
              : group.containerConfig,
          };
          // Isolated memory: use specialist-scoped session key
          const sessionKey = s.memory?.isolated
            ? `${group.folder}:${s.name}`
            : group.folder;
          // Append claudemd to the specialist prompt block if provided
          const claudemdSection = s.claudemd
            ? `\n<specialist_instructions>\n${s.claudemd}\n</specialist_instructions>`
            : '';
          return {
            group: specialistGroup,
            sessionKey,
            prompt: `<specialist name="${s.name}">\n${s.prompt}\n</specialist>${claudemdSection}\n\n${prompt}`,
          };
        })
      : [{ group, sessionKey: group.folder, prompt }];

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
    const output = await runAgent(
      agentRun.group,
      agentRun.prompt,
      chatJid,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const stripped = stripInternalTags(raw);
          logger.info(
            { group: group.name },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          // Handle [SendFile: ...] markers — send media and strip/replace markers
          const text = await handleSendFileMarkers(
            stripped,
            channel,
            chatJid,
            group.folder,
            GROUPS_DIR,
          );
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
      },
      agentRun.sessionKey,
    );

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
  sessionKey?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const provider = group.llmProvider || 'claude';
  // sessionKey allows isolated specialist memory; defaults to group folder
  const effectiveSessionKey = sessionKey ?? group.folder;
  const sessionId = sessions[effectiveSessionKey];

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
          sessions[effectiveSessionKey] = output.newSessionId;
          setSession(effectiveSessionKey, output.newSessionId);
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
  startOrchestratorHealthServer();
  await initDatabase();
  logger.info('Database initialized');

  // Start admin HTTP interface if configured (runs in-process, no sidecar needed)
  if (process.env.ADMIN_HTTP_PORT) {
    startHttpAdminServer();
  }

  loadState();
  healthGroupsLoaded = true;
  await loadChannelPlugins('/workspace/plugins');

  // Track Redis readiness for health probe
  const redisClient = getRedisClient();
  if (redisClient.status === 'ready') healthRedisReady = true;
  redisClient.on('ready', () => {
    healthRedisReady = true;
  });
  redisClient.on('close', () => {
    healthRedisReady = false;
  });
  redisClient.on('error', () => {
    healthRedisReady = false;
  });

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
    logger.info(
      { channels: registeredChannelNames },
      'Registered channel factories',
    );

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
    logger.info(
      'Orchestrator mode: channels run in dedicated pods, skipping inline channel init',
    );
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
          logger.warn(
            { jid },
            'No registered group for JID, cannot route scheduled message',
          );
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
  startTaskRequestWatcher().catch((err) =>
    logger.error({ err }, 'Task request watcher crashed'),
  );

  // Sync MCP servers from values.yaml (MCP_SERVERS_VALUES env var) and notify channel pods
  try {
    const { syncFromValues, notifyAllChannels } =
      await import('./mcp-registry.js');
    const mcpValuesJson = process.env.MCP_SERVERS_VALUES;
    if (mcpValuesJson) {
      const mcpSpecs = JSON.parse(mcpValuesJson);
      await syncFromValues(mcpSpecs);
      logger.info(
        { count: mcpSpecs.length },
        'Synced MCP servers from values.yaml',
      );
    }
    // Always notify channels on startup (covers servers already in DB from previous runs)
    await notifyAllChannels();
  } catch (err) {
    logger.error({ err }, 'Failed to sync MCP servers on startup');
  }

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
