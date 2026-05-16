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
  GROUPS_DIR,
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
  setCapability,
  deleteCapability,
  getAllCapabilities,
} from './capabilities/db.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConversationHistory,
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
import { resetRagProvider } from './rag/provider.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  startIpcWatcher,
  startControlChannelWatcher,
  type ControlMessage,
} from './k8s/ipc-redis.js';
import { getRedisClient, getChannelStatusChannel } from './k8s/redis-client.js';
import { registerChannel } from './channels/registry.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { AvailableGroup, ContainerOutput } from './runtime/types.js';
import { logger } from './logger.js';
import { runCurator, CuratorLLMFn, CuratorProposal } from './runtime/skill-curator.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import { handleSkillsCommand, isSkillsCommand } from './runtime/skills-commands.js';

const execFileAsync = promisify(execFile);

/** Publish a lifecycle status event to the orchestrator. */
async function publishChannelStatus(
  status: 'ready' | 'configured' | 'error',
  detail?: string,
): Promise<void> {
  try {
    const client = getRedisClient();
    const channel = getChannelStatusChannel(KUBECLAW_CHANNEL);
    await client.publish(channel, JSON.stringify({ status, detail }));
    logger.info({ status, detail }, 'Published channel status');
  } catch (err) {
    logger.error({ err, status }, 'Failed to publish channel status');
  }
}

/**
 * Handle a 'capabilities_update' control command from the orchestrator.
 *
 * The orchestrator broadcasts this whenever a capability is installed or
 * removed. The channel pod filters MCP entries out of the payload, projects
 * them to McpServerStatus shape, reconfigures the MCP runtime, and resets
 * the cached RAG provider so a newly installed Qdrant/LightRAG takes effect
 * without a pod restart.
 *
 * Exported for the e2e test in capabilities-e2e.test.ts.
 */
export async function handleCapabilitiesUpdate(
  msg: ControlMessage,
): Promise<void> {
  try {
    const capabilities = JSON.parse(msg.capabilities || '[]') as Array<{
      name: string;
      kind: string;
      endpoint: string;
      kindMetadata: {
        path?: string;
        allowedTools?: string[];
        backend?: string;
      };
    }>;

    // Mirror the orchestrator's authoritative capability list into this
    // channel pod's local SQLite. Channel-pod callers like getRagEntry()
    // and getEntriesForChannel() (src/capabilities/client.ts,
    // src/capabilities/registry.ts) read from the local DB; without this
    // sync, runtime-installed RAG (and other) capabilities never become
    // visible to DirectLLMRunner's getRagProvider() path.
    //
    // The discovery entries received here are a subset of full
    // CapabilitySpec, so we synthesize the missing fields (image, etc.)
    // with placeholders — they are never used in the channel pod,
    // applySpec is only ever called on the orchestrator side.
    //
    // Wrapped: a failure here must NOT block the MCP runtime
    // reconfigure that follows.
    try {
      syncCapabilitiesToLocalDb(capabilities);
    } catch (err) {
      logger.warn(
        { err },
        'Failed to mirror capabilities to local DB — RAG provider may still resolve to NullRagProvider',
      );
    }

    const mcpServers = capabilities
      .filter((c) => c.kind === 'mcp')
      .map((c) => ({
        name: c.name,
        url: `${c.endpoint}${c.kindMetadata.path ?? '/mcp'}`,
        allowedTools: c.kindMetadata.allowedTools,
      }));
    await getDirectLLMRunner().configureMcp(mcpServers);
    // Drop the cached RAG provider so the next call re-selects against
    // the new capability set (e.g. a newly installed Qdrant or LightRAG).
    resetRagProvider();
    logger.info(
      { count: mcpServers.length, total: capabilities.length },
      'MCP servers reconfigured from capabilities_update',
    );
  } catch (err) {
    logger.error(
      { err },
      'Failed to reconfigure MCP servers from capabilities_update',
    );
  }
}

interface DiscoveryEntryLite {
  name: string;
  kind: string;
  endpoint: string;
  kindMetadata: {
    path?: string;
    allowedTools?: string[];
    backend?: string;
  };
}

function syncCapabilitiesToLocalDb(entries: DiscoveryEntryLite[]): void {
  const incoming = new Map<string, DiscoveryEntryLite>();
  for (const e of entries) incoming.set(e.name, e);

  // Drop locally cached entries that are no longer in the authoritative list.
  const deleted: string[] = [];
  for (const local of getAllCapabilities()) {
    if (!incoming.has(local.name)) {
      deleteCapability(local.name);
      deleted.push(local.name);
    }
  }

  const written: { name: string; kind: string }[] = [];
  for (const entry of entries) {
    const portMatch = entry.endpoint.match(/:(\d+)(?:\/|$)/);
    const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
    const common = {
      name: entry.name,
      image: '__channel-side-placeholder__',
      ...(port !== undefined ? { port } : {}),
    };
    let spec: import('./capabilities/types.js').CapabilitySpec;
    switch (entry.kind) {
      case 'mcp':
        spec = {
          ...common,
          kind: 'mcp',
          ...(entry.kindMetadata.path ? { path: entry.kindMetadata.path } : {}),
          ...(entry.kindMetadata.allowedTools
            ? { allowedTools: entry.kindMetadata.allowedTools }
            : {}),
        };
        break;
      case 'rag': {
        const backend = entry.kindMetadata.backend;
        if (backend !== 'qdrant' && backend !== 'lightrag') {
          // Unknown backend — skip rather than write a malformed row.
          continue;
        }
        spec = { ...common, kind: 'rag', backend };
        break;
      }
      case 'http':
        spec = { ...common, kind: 'http' };
        break;
      default:
        continue;
    }
    setCapability(spec);
    written.push({ name: entry.name, kind: entry.kind });
  }
  logger.info(
    { written, deleted, total: entries.length },
    'Synced capabilities to local DB',
  );
}

/**
 * Handle a 'configure' control command from the orchestrator.
 *
 * Installs npm dependencies, dynamically imports the channel module,
 * registers it, and starts the connection. This is the self-configuration
 * path for blank channel pods.
 *
 * SECURITY: This handler is only reachable via the Redis control channel
 * (kubeclaw:control:{channelName}), which only the orchestrator can
 * publish to (enforced by Redis ACL). User messages cannot trigger this.
 */
async function handleConfigure(
  msg: ControlMessage,
  channelOpts: {
    onMessage: (chatJid: string, msg: NewMessage) => void;
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => void;
    registeredGroups: () => Record<string, RegisteredGroup>;
  },
  channelsArray: Channel[],
): Promise<void> {
  const channelType = msg.channelType;
  if (!channelType) {
    logger.error('Configure command missing channelType');
    await publishChannelStatus('error', 'Missing channelType');
    return;
  }

  // Install npm dependencies if specified
  const deps = (msg as any).dependencies as string[] | undefined;
  if (deps && deps.length > 0) {
    logger.info({ deps }, 'Installing npm dependencies...');
    try {
      await execFileAsync('npm', ['install', '--save', ...deps], {
        cwd: process.cwd(),
        timeout: 120_000,
      });
      logger.info({ deps }, 'Dependencies installed successfully');
    } catch (err) {
      logger.error({ err, deps }, 'Failed to install dependencies');
      await publishChannelStatus('error', `npm install failed: ${err}`);
      return;
    }
  }

  // If the channel factory is already registered (built-in), use it directly
  let factory = getChannelFactory(channelType);

  // If not registered, try to dynamically import it
  if (!factory) {
    try {
      const modulePath = `./channels/${channelType}.js`;
      await import(modulePath);
      factory = getChannelFactory(channelType);
    } catch (err) {
      logger.error({ err, channelType }, 'Failed to import channel module');
      await publishChannelStatus('error', `Import failed: ${err}`);
      return;
    }
  }

  if (!factory) {
    logger.error({ channelType }, 'Channel factory not found after import');
    await publishChannelStatus('error', `No factory for ${channelType}`);
    return;
  }

  // Create and connect the channel
  const channel = factory(channelOpts);
  if (!channel) {
    logger.error({ channelType }, 'Channel factory returned null');
    await publishChannelStatus(
      'error',
      'Factory returned null — check credentials',
    );
    return;
  }

  await connectWithRetry(channel);
  channelsArray.push(channel);
  logger.info({ channelType }, 'Channel configured and connected');
  await publishChannelStatus('configured');
}

/**
 * Return the folder prefix used for a given channel type.
 *
 * Built-in mappings:
 *   telegram  → tg
 *   discord   → dc
 *   slack     → sl
 *   whatsapp  → wa
 *   irc       → irc
 *   http      → http
 *
 * Unknown types fall back to the first 3 characters of the channel name.
 *
 * Exported so channel authors can discover their prefix at runtime
 * and so the table can be tested in isolation.
 */
export function folderPrefixForChannel(channelName: string): string {
  const prefix: Record<string, string> = {
    telegram: 'tg',
    discord: 'dc',
    slack: 'sl',
    whatsapp: 'wa',
    irc: 'irc',
    http: 'http',
    'oauth-webchat': 'oauth',
  };
  return prefix[channelName] ?? channelName.slice(0, 3);
}

/**
 * Derive a stable, valid group folder name from a channel type + JID.
 * e.g. ("telegram", "-1001234567890") → "tg-1001234567890"
 */
function jidToFolder(channelType: string, jid: string): string {
  const p = folderPrefixForChannel(channelType);
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
        const status = ok
          ? 'ok'
          : channelReconnecting
            ? 'reconnecting'
            : 'starting';
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status,
            channel: KUBECLAW_CHANNEL,
            connected: channelConnected,
            uptime: process.uptime(),
          }),
        );
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
  const maxRetries = parseInt(
    process.env.CHANNEL_CONNECT_MAX_RETRIES || '10',
    10,
  );
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await channel.connect();
      channelConnected = true;
      channelReconnecting = false;
      return;
    } catch (err) {
      if (attempt >= maxRetries) {
        logger.fatal(
          { err, attempt },
          'Channel connection failed after max retries',
        );
        process.exit(1);
      }
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 60_000);
      logger.warn(
        { err, attempt, delayMs },
        'Channel connect failed, retrying',
      );
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
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
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
  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
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

/**
 * NOT ON THE PRODUCTION PATH — kept for unit-test coverage only.
 *
 * The live intercept now lives in processGroupMessages (before formatMessages)
 * so that isSkillsCommand can match the raw user text. This helper is retained
 * because src/channel-runner.test.ts exercises it directly; calling it from
 * runAgent would never fire because prompt is already XML-wrapped by then.
 */
export async function dispatchSkillsCommandIfApplicable(
  group: RegisteredGroup,
  prompt: string,
  jid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<boolean> {
  if (!isSkillsCommand(prompt)) return false;
  const reply = handleSkillsCommand(GROUPS_DIR, group.folder, jid, prompt);
  if (onOutput) {
    await onOutput({ status: 'success', result: reply });
  }
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Channel pods always use DirectLLMRunner — no K8s tool jobs
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
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );
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

  // /skills chat command: handle locally without invoking the LLM.
  // The intercept must live here — BEFORE formatMessages wraps the content
  // in XML, which would break the isSkillsCommand regex match.
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (lastMsg && isSkillsCommand(lastMsg.content)) {
    const reply = handleSkillsCommand(
      GROUPS_DIR,
      group.folder,
      chatJid,
      lastMsg.content.trim(),
    );
    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();
    await channel.setTyping?.(chatJid, true);
    try {
      await channel.sendMessage(chatJid, reply);
    } finally {
      await channel.setTyping?.(chatJid, false);
    }
    return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const specialists = loadSpecialists(group.folder);
  const mentionedSpecialists = specialists
    ? detectMentionedSpecialists(prompt, specialists)
    : [];

  const agentRuns =
    mentionedSpecialists.length > 0
      ? mentionedSpecialists.map((s) => ({
          prompt: `<specialist name="${s.name}">\n${s.prompt}\n</specialist>\n\n${prompt}`,
        }))
      : [{ prompt }];

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
      group,
      agentRun.prompt,
      chatJid,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
          }
        }
        if (result.status === 'success') queue.notifyIdle(chatJid);
        if (result.status === 'error') hadError = true;
      },
    );

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

  logger.info(
    `Channel pod running (channel: ${KUBECLAW_CHANNEL}, trigger: @${ASSISTANT_NAME})`,
  );

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

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
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
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

const CURATOR_INTERVAL_MS = Number(process.env.SKILL_CURATOR_INTERVAL_MS ?? 24 * 60 * 60 * 1000);

function startSkillCuratorInterval(): void {
  if (CURATOR_INTERVAL_MS <= 0) {
    logger.info('skill curator disabled (SKILL_CURATOR_INTERVAL_MS=0)');
    return;
  }
  setInterval(async () => {
    try {
      const groups = Object.values(registeredGroups);
      const client = createLLMClient();
      for (const group of groups) {
        // Pass limit=0 for an unlimited DB query, then cap at 200 turns to bound
        // token cost. This approximates "last 24h"; precise time windowing
        // (e.g. WHERE created_at >= now-24h) is a future enhancement.
        const transcript = getConversationHistory(group.folder, 0).slice(-200);
        const llm: CuratorLLMFn = async (tx, existing) => {
          const sys = `You analyze a recent assistant-user transcript and propose at most 3 skill candidates. Reply JSON: {"proposals": [{"action":"new"|"edit"|"tune-description","target":string|null,"name":string,"description":string,"body":string}]}. Prefer "edit" over "new" when the topic overlaps an existing skill. Skip project-specific facts (those belong elsewhere) and one-off solutions.`;
          const existingDigest = existing
            .map((s) => `- ${s.frontmatter.name}: ${s.frontmatter.description}`)
            .join('\n');
          const transcriptStr = tx
            .map((t) => `[${t.role}] ${t.content}`)
            .join('\n')
            .slice(0, 12000);
          const completion = await client.chat.completions.create({
            model: DEFAULT_DIRECT_MODEL,
            messages: [
              { role: 'system', content: sys },
              {
                role: 'user',
                content: `Existing skills:\n${existingDigest || '(none)'}\n\nTranscript:\n${transcriptStr}`,
              },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 1200,
          });
          try {
            const parsed = JSON.parse(
              completion.choices[0].message.content ?? '{"proposals":[]}',
            );
            return Array.isArray(parsed.proposals)
              ? (parsed.proposals as CuratorProposal[])
              : [];
          } catch {
            return [];
          }
        };
        const res = await runCurator(group.folder, {
          groupsRoot: GROUPS_DIR,
          getTranscript: () => transcript,
          llm,
        });
        if (res.candidatesWritten > 0) {
          logger.info(
            { group: group.name, folder: group.folder, candidates: res.candidatesWritten },
            'skill curator staged candidates',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'skill curator interval iteration failed');
    }
  }, CURATOR_INTERVAL_MS).unref();
}

async function main(): Promise<void> {
  startHealthServer();
  await initDatabase();
  logger.info(`Database initialized (channel: ${KUBECLAW_CHANNEL})`);
  startSkillCuratorInterval();
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
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
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

  // Notify orchestrator that this channel pod is ready to receive commands.
  await publishChannelStatus('ready');

  // Load the channel factory by type (KUBECLAW_CHANNEL_TYPE), not instance name (KUBECLAW_CHANNEL).
  // This allows multiple instances of the same type (e.g. "http-dev" and "http-prod" both using "http" factory).
  const factory = getChannelFactory(KUBECLAW_CHANNEL_TYPE);
  if (!factory) {
    logger.error(
      { channel: KUBECLAW_CHANNEL, type: KUBECLAW_CHANNEL_TYPE },
      'Unknown channel type — no factory registered',
    );
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

  // Subscribe to orchestrator control commands (e.g. reload, configure).
  startControlChannelWatcher(KUBECLAW_CHANNEL, async (msg) => {
    if (msg.command === 'reload') {
      logger.info('Reload command received, reconnecting channel...');
      channelConnected = false;
      channelReconnecting = true;
      for (const ch of channels) {
        try {
          await ch.disconnect();
        } catch (err) {
          logger.warn({ err }, 'Error disconnecting channel during reload');
        }
      }
      channels.length = 0;
      const newChannel = factory!(channelOpts);
      if (!newChannel) {
        logger.error(
          { channel: KUBECLAW_CHANNEL },
          'Channel factory returned null during reload',
        );
        return;
      }
      await connectWithRetry(newChannel);
      channels.push(newChannel);
      logger.info('Channel reloaded successfully');
    } else if (msg.command === 'capabilities_update') {
      await handleCapabilitiesUpdate(msg);
    } else if (msg.command === 'configure') {
      await handleConfigure(msg, channelOpts, channels);
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
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start channel pod');
    process.exit(1);
  });
}
