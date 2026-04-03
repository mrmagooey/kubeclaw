/**
 * Channel pod entry point.
 *
 * Runs a single communication channel adapter (identified by KUBECLAW_CHANNEL)
 * plus the DirectLLMRunner message loop. Unlike the main orchestrator, channel
 * pods have no Kubernetes RBAC and delegate tool pod spawning to the orchestrator
 * via the kubeclaw:spawn-tool-pod Redis stream.
 *
 * Usage: node dist/channel-runner.js
 * Required env: KUBECLAW_CHANNEL=telegram|discord|slack|whatsapp|irc
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  KUBECLAW_CHANNEL,
  KUBECLAW_CHANNEL_TYPE,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js'; // self-register all channel factories
import { getChannelFactory } from './channels/registry.js';
import { loadChannelPlugins } from './channels/plugin-loader.js';
import { getDirectLLMRunner, shutdownAllRunners } from './runtime/index.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, isValidGroupFolder } from './group-folder.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { detectMentionedSpecialists, loadSpecialists } from './specialists.js';
import { startIpcWatcher, startControlChannelWatcher } from './k8s/ipc-redis.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { AvailableGroup, ContainerOutput } from './runtime/types.js';
import { logger } from './logger.js';

/**
 * Derive a stable, valid group folder name from a channel type + JID.
 * e.g. ("telegram", "-1001234567890") → "tg-1001234567890"
 */
function jidToFolder(channelType: string, jid: string): string {
  const prefix: Record<string, string> = {
    telegram: 'tg',
    discord: 'dc',
    slack: 'sl',
    whatsapp: 'wa',
    irc: 'irc',
    http: 'http',
  };
  const p = prefix[channelType] ?? channelType.slice(0, 3);
  // Sanitize: keep alphanumeric, replace everything else with '-'
  const sanitized = jid
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55);
  const candidate = `${p}-${sanitized}`;
  // Ensure starts with alphanumeric (prefix always does)
  return isValidGroupFolder(candidate) ? candidate : `ch-${Date.now()}`;
}

if (!KUBECLAW_CHANNEL) {
  logger.error('KUBECLAW_CHANNEL env var is required for channel pod mode');
  process.exit(1);
}

// ── Health server state ───────────────────────────────────────────────────────
let channelConnected = false;
let channelReconnecting = false;

function startHealthServer(): void {
  const port = parseInt(process.env.HEALTH_PORT || '9090', 10);
  http
    .createServer((req, res) => {
      if (req.url === '/liveness' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }));
      } else if (req.url === '/health' && req.method === 'GET') {
        const ok = channelConnected;
        const status = ok ? 'ok' : channelReconnecting ? 'reconnecting' : 'starting';
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, channel: KUBECLAW_CHANNEL, connected: channelConnected, uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Health server started');
    });
}

async function connectWithRetry(channel: Channel): Promise<void> {
  const maxRetries = parseInt(process.env.CHANNEL_CONNECT_MAX_RETRIES || '10', 10);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await channel.connect();
      channelConnected = true;
      channelReconnecting = false;
      return;
    } catch (err) {
      if (attempt >= maxRetries) {
        logger.fatal({ err, attempt }, 'Channel connection failed after max retries');
        process.exit(1);
      }
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
      logger.warn({ err, attempt, delayMs }, 'Channel connect failed, retrying');
      channelReconnecting = true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
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
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn({ jid, folder: group.folder }, `Invalid group folder: ${err}`);
    return;
  }
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

function getAvailableGroups(): AvailableGroup[] {
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

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Channel pods always use DirectLLMRunner — no K8s agent jobs
  const agentRunner = getDirectLLMRunner();

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

  const availableGroups = getAvailableGroups();
  agentRunner.writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await agentRunner.runAgent(
      group,
      {
        prompt,
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
      logger.error({ group: group.name, error: output.error }, 'Agent error');
      return 'error';
    }
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

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
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const specialists = loadSpecialists(group.folder);
  const mentionedSpecialists = specialists ? detectMentionedSpecialists(prompt, specialists) : [];

  const agentRuns =
    mentionedSpecialists.length > 0
      ? mentionedSpecialists.map((s) => ({
          prompt: `<specialist name="${s.name}">\n${s.prompt}\n</specialist>\n\n${prompt}`,
        }))
      : [{ prompt }];

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  for (const agentRun of agentRuns) {
    const output = await runAgent(group, agentRun.prompt, chatJid, async (result) => {
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
      }
      if (result.status === 'success') queue.notifyIdle(chatJid);
      if (result.status === 'error') hadError = true;
    });

    if (output === 'error' || hadError) {
      hadError = true;
      break;
    }
  }

  await channel.setTyping?.(chatJid, false);

  if (hadError) {
    if (outputSentToUser) {
      saveState();
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    return false;
  }

  saveState();
  return true;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) return;
  messageLoopRunning = true;

  logger.info(`Channel pod running (channel: ${KUBECLAW_CHANNEL}, trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        lastTimestamp = newTimestamp;
        saveState();

        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) existing.push(msg);
          else messagesByGroup.set(msg.chat_jid, [msg]);
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const ch = findChannel(channels, chatJid);
          if (!ch) continue;

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Message loop error');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

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
  startHealthServer();
  await initDatabase();
  logger.info(`Database initialized (channel: ${KUBECLAW_CHANNEL})`);
  loadState();
  await loadChannelPlugins('/workspace/plugins');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    channelConnected = false;
    await queue.shutdown(10000);
    await shutdownAllRunners();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
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
    ) => {
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      // Auto-register new chats so the bot responds immediately without a manual register_group step
      if (!registeredGroups[chatJid]) {
        const folder = jidToFolder(channel ?? KUBECLAW_CHANNEL_TYPE, chatJid);
        registerGroup(chatJid, {
          name: name || chatJid,
          folder,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          containerConfig: { direct: true },
        });
        logger.info({ chatJid, name, folder }, 'Auto-registered new chat');
      }
    },
    registeredGroups: () => registeredGroups,
  };

  // Load the channel factory by type (KUBECLAW_CHANNEL_TYPE), not instance name (KUBECLAW_CHANNEL).
  // This allows multiple instances of the same type (e.g. "http-dev" and "http-prod" both using "http" factory).
  const factory = getChannelFactory(KUBECLAW_CHANNEL_TYPE);
  if (!factory) {
    logger.error({ channel: KUBECLAW_CHANNEL, type: KUBECLAW_CHANNEL_TYPE }, 'Unknown channel type — no factory registered');
    process.exit(1);
  }

  const channel = factory(channelOpts);
  if (!channel) {
    logger.error(
      { channel: KUBECLAW_CHANNEL },
      'Channel credentials missing — check the Secret for this channel pod',
    );
    process.exit(1);
  }

  logger.info({ channel: KUBECLAW_CHANNEL }, 'Connecting channel...');
  await connectWithRetry(channel);
  logger.info({ channel: KUBECLAW_CHANNEL }, 'Channel connected');
  channels.push(channel);

  // Subscribe to Redis pub/sub so the orchestrator's task scheduler can deliver
  // scheduled messages to this channel pod via kubeclaw:messages:${groupFolder}.
  startIpcWatcher({
    sendMessage: async (jid: string, text: string) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel owns JID, cannot deliver IPC message');
        return;
      }
      await ch.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      for (const ch of channels) await ch.syncGroups?.(force);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (
      gf: string,
      im: boolean,
      ag: AvailableGroup[],
      rj: Set<string>,
    ) => getDirectLLMRunner().writeGroupsSnapshot(gf, im, ag, rj),
  });

  // Subscribe to orchestrator control commands (e.g. reload).
  startControlChannelWatcher(KUBECLAW_CHANNEL, async (msg) => {
    if (msg.command === 'reload') {
      logger.info('Reload command received, reconnecting channel...');
      channelConnected = false;
      channelReconnecting = true;
      for (const ch of channels) {
        try { await ch.disconnect(); } catch (err) { logger.warn({ err }, 'Error disconnecting channel during reload'); }
      }
      channels.length = 0;
      const newChannel = factory!(channelOpts);
      if (!newChannel) {
        logger.error({ channel: KUBECLAW_CHANNEL }, 'Channel factory returned null during reload');
        return;
      }
      await connectWithRetry(newChannel);
      channels.push(newChannel);
      logger.info('Channel reloaded successfully');
    } else if (msg.command === 'mcp_update') {
      try {
        const servers = JSON.parse(msg.servers || '[]');
        await getDirectLLMRunner().configureMcp(servers);
        logger.info({ count: servers.length }, 'MCP servers reconfigured');
      } catch (err) {
        logger.error({ err }, 'Failed to reconfigure MCP servers');
      }
    } else {
      logger.warn({ command: msg.command }, 'Unknown control command');
    }
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed');
    process.exit(1);
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start channel pod');
    process.exit(1);
  });
}
