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
import fsPromises from 'fs/promises';
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
import type { GroupMcpEntry } from './capabilities/types.js';
import {
  appendConversationMessage,
  createTask,
  deleteTaskForGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  clearConversationHistory,
  getAllTasks,
  getActiveToolJobs,
  getConversationHistory,
  getMessagesSince,
  getNewMessages,
  getRecentToolJobsForGroup,
  getRouterState,
  getTasksForGroup,
  initDatabase,
  pruneOldToolJobs,
  recordSpecialistUsage,
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
import { detectMentionedSpecialists } from './specialists.js';
import { SpecialistCatalogLoader } from './specialists/catalog-loader.js';
import type { RunAgentOverrides } from './runtime/types.js';
import { resetRagProvider } from './rag/provider.js';
import {
  handleSearchCommand,
  isSearchCommand,
} from './runtime/search-command.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  startIpcWatcher,
  startControlChannelWatcher,
  type ControlMessage,
} from './k8s/ipc-redis.js';
import {
  getRedisClient,
  getChannelStatusChannel,
  getTaskRequestStream,
} from './k8s/redis-client.js';
import { registerChannel } from './channels/registry.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { AvailableGroup, ContainerOutput } from './runtime/types.js';
import { logger } from './logger.js';
import {
  runCurator,
  CuratorLLMFn,
  CuratorProposal,
} from './runtime/skill-curator.js';
import { createLLMClient, DEFAULT_DIRECT_MODEL } from './runtime/llm-client.js';
import {
  handleSkillsCommand,
  isSkillsCommand,
} from './runtime/skills-commands.js';
import {
  handleCompactCommand,
  parseCompactArgs,
  isCompactCommand,
} from './runtime/compression-commands.js';
import type { CatalogEntry } from './credential-broker/resolver.js';
import { randomBytes } from 'node:crypto';
import {
  listCredentialsTool,
  buildCredentialSystemBlock,
  LIST_CREDENTIALS_TOOL_DEF,
  type IpcClient,
} from './tools/list-credentials.js';
import { Registry } from 'prom-client';
import { createChannelMetrics } from './metrics/channel.js';
import { createMetricsServer } from './metrics/registry.js';

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
    const groupTemplates = capabilities.filter(
      (c) => c.kind === 'mcp-group',
    ) as Array<any>;
    // Update the local group-capability map so /capabilities tools can query it.
    _groupCapabilityEntries.clear();
    for (const entry of groupTemplates as GroupMcpEntry[]) {
      _groupCapabilityEntries.set(entry.name, entry);
    }
    await getDirectLLMRunner().configureMcp(mcpServers);
    if (groupTemplates.length > 0) {
      await getDirectLLMRunner().configureGroupMcpTemplates(groupTemplates);
    }
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

// ── Per-group capability entries (populated by handleCapabilitiesUpdate) ──────
// Keyed by capability name. Populated each time a capabilities_update arrives.
// Exported for test injection.
export const _groupCapabilityEntries: Map<string, GroupMcpEntry> = new Map();

/**
 * Build the shutdown handler for the channel runner.
 *
 * Exported (`_buildShutdown`) so unit tests can verify that the metrics server
 * is closed without spinning up the full main() function.
 */
export function _buildShutdown(
  metricsServer: import('./metrics/registry.js').MetricsServer,
  queue: GroupQueue,
  channelList: Channel[],
): (signal: string) => Promise<void> {
  return async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    channelConnected = false;
    await queue.shutdown(10000);
    await shutdownAllRunners();
    for (const ch of channelList) await ch.disconnect();
    await metricsServer.close();
    process.exit(0);
  };
}

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

// Specialist catalog — loaded from ConfigMap at startup; hot-reloaded via fs.watch.
// In tests this is replaced via _setSpecialistCatalogForTesting.
let specialistCatalog: Pick<SpecialistCatalogLoader, 'getAll'> =
  new SpecialistCatalogLoader('/etc/kubeclaw/specialists/specialists.json');

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

// ── /help command ─────────────────────────────────────────────────────────────

export const HELP_TEXT = [
  'Available slash commands:',
  '  /jobs                    — list active and recent tool jobs',
  '  /search <query>          — full-text search over conversation history',
  '  /skills                  — manage learned skills (review / accept / reject)',
  '  /secret                  — manage credentials (add / remove / list / catalog)',
  '  /memory show             — show your group memory (CLAUDE.md)',
  '  /memory append <text>    — append text to your group memory',
  '  /memory set <text>       — replace your group memory entirely',
  '  /schedule add <type> <value> <prompt>  — schedule a task (cron/interval/once)',
  '  /schedule list           — list your scheduled tasks',
  '  /schedule remove <id>    — remove a scheduled task',
  '  /clear                   — clear conversation context',
  '  /compact                 — compact conversation history',
  '  /summary                 — summarise recent conversation',
  '  /cancel                  — abort the currently running tool job',
].join('\n');

export function isHelpCommand(message: string): boolean {
  return /^\/help(\s|$)/.test(message.trim());
}

// ── /jobs command ─────────────────────────────────────────────────────────────

/**
 * Format an ISO-8601 timestamp to HH:MMZ display format.
 * e.g. "2026-05-20T14:32:00.000Z" → "14:32Z"
 */
export function formatJobTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16) + 'Z';
}

export function isJobsCommand(message: string): boolean {
  return /^\/jobs(\s|$)/.test(message.trim());
}

/**
 * Handle the /jobs slash command.
 *
 * Returns a formatted text reply listing:
 *  - Active running jobs as "[running] @SpecialistName (started HH:MMZ)"
 *  - Recent completed jobs as "[status] @SpecialistName (HH:MMZ → HH:MMZ)"
 *  - "No active jobs." if no running jobs and no recent history.
 */
export function handleJobsCommand(groupFolder: string): string {
  const activeJobs = getActiveToolJobs().filter(
    (j) => j.group_folder === groupFolder,
  );
  const recentJobs = getRecentToolJobsForGroup(groupFolder, 5);

  if (activeJobs.length === 0 && recentJobs.length === 0) {
    return 'No active jobs.';
  }

  const lines: string[] = [];

  for (const job of activeJobs) {
    const nameDisplay = job.specialist_name
      ? ` @${job.specialist_name}` : '';
    lines.push(`[running]${nameDisplay} (started ${formatJobTime(job.created_at)})`);
  }

  for (const job of recentJobs) {
    const resolvedDisplay = job.resolved_at
      ? formatJobTime(job.resolved_at)
      : '?';
    const nameDisplay = job.specialist_name
      ? ` @${job.specialist_name}` : '';
    lines.push(
      `[${job.status}]${nameDisplay} (${formatJobTime(job.created_at)} → ${resolvedDisplay})`,
    );
  }

  return lines.join('\n');
}

// ── /secret command types ─────────────────────────────────────────────────────

/** IPC response envelope returned by the orchestrator for secret.* operations. */
export type IpcResponse<T = unknown> =
  | { ok: true; result?: T }
  | { ok: false; error: string };

/** Parsed /secret add command */
export interface SecretAddCommand {
  catalogId: string;
  fields: Record<string, string>;
}

// ── Coarse-regex backstop ─────────────────────────────────────────────────────

/** Default credential patterns to scan for in every user message. */
const DEFAULT_BACKSTOP_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /r8_[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_\-]{30,}/g,
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/g,
];

/** Build additional backstop patterns from catalog apiKeyShape entries. */
export function buildCatalogBackstopPatterns(
  catalog: readonly CatalogEntry[],
): RegExp[] {
  const patterns: RegExp[] = [];
  for (const entry of catalog) {
    if (entry.apiKeyShape) {
      const { prefix, minLength } = entry.apiKeyShape;
      // Escape regex metacharacters in the prefix
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push(
        new RegExp(`${escapedPrefix}[A-Za-z0-9_\\-]{${minLength},}`, 'g'),
      );
    }
  }
  return patterns;
}

/**
 * Apply the coarse-regex backstop to a user message. Returns the message with
 * any credential-shaped strings replaced by `[possible secret redacted]`.
 *
 * This runs independently of the slash-command parser and is applied to every
 * inbound user message before any LLM call.
 */
export function applyCredentialBackstop(
  text: string,
  extraPatterns: RegExp[] = [],
): string {
  const patterns = [...DEFAULT_BACKSTOP_PATTERNS, ...extraPatterns];
  let result = text;
  for (const pattern of patterns) {
    // Reset lastIndex since we're reusing regex objects (global flag)
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[possible secret redacted]');
  }
  return result;
}

// ── /secret command parser ────────────────────────────────────────────────────

export function isSecretCommand(message: string): boolean {
  return /^\/secret(\s|$)/.test(message.trim());
}

/**
 * Parse `/secret add <id> <value>` or `/secret add <id> <field>=<value> [...]`
 * Returns null if the command is not parseable (wrong subcommand, etc.)
 */
export function parseSecretAddCommand(
  message: string,
): SecretAddCommand | null {
  // Match: /secret add <catalogId> <rest>
  const match = /^\/secret\s+add\s+(\S+)\s+(.+)$/i.exec(message.trim());
  if (!match) return null;

  const catalogId = match[1];
  const rest = match[2].trim();

  // Check if rest looks like key=value pairs
  const kvPattern = /^(\S+=\S+)(\s+\S+=\S+)*$/;
  if (kvPattern.test(rest)) {
    // Multi-field form: field1=value1 field2=value2 ...
    const fields: Record<string, string> = {};
    const kvRegex = /(\S+)=(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = kvRegex.exec(rest)) !== null) {
      fields[m[1]] = m[2];
    }
    return { catalogId, fields };
  }

  // Single-field shorthand: the whole rest is the value
  // The field name will be resolved from the catalog's single credentialField
  return { catalogId, fields: { __single__: rest } };
}

/** Parse `/secret remove <id>` */
export function parseSecretRemoveCommand(message: string): string | null {
  const match = /^\/secret\s+remove\s+(\S+)$/i.exec(message.trim());
  return match ? match[1] : null;
}

// ── Redis IPC helper for secret operations ────────────────────────────────────

/**
 * Send a secret-management IPC request to the orchestrator via the
 * task-request stream and await the response with a 5-second timeout.
 *
 * Injected in tests via `_secretIpcFn`; uses real Redis in production.
 */
export type SecretIpcFn = (
  fields: Record<string, string>,
) => Promise<IpcResponse>;

/**
 * Create a real Redis-backed IPC function for a given IPC type.
 * The caller provides any additional fields beyond `type`.
 */
export function createSecretIpcFn(
  type: string,
  baseFields: Record<string, string>,
): SecretIpcFn {
  return async (_fields: Record<string, string>) => {
    const redis = getRedisClient();
    const resultStream = `kubeclaw:secret-result:${Date.now()}-${randomBytes(4).toString('hex')}`;

    // Build the flat field list for XADD
    const allFields: string[] = ['type', type, 'resultStream', resultStream];
    for (const [k, v] of Object.entries(baseFields)) {
      allFields.push(k, v);
    }
    for (const [k, v] of Object.entries(_fields)) {
      allFields.push(k, v);
    }

    await redis.xadd(getTaskRequestStream(), '*', ...allFields);

    // Wait up to 5s for orchestrator response
    const deadline = Date.now() + 5000;
    let lastId = '0-0';
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await redis.xread(
        'COUNT',
        1,
        'BLOCK',
        Math.min(remaining, 1000),
        'STREAMS',
        resultStream,
        lastId,
      );
      if (!response) continue;
      for (const [, messages] of response as [string, [string, string[]][]][]) {
        for (const [, flds] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < flds.length; i += 2) obj[flds[i]] = flds[i + 1];
          if (obj.result) {
            return JSON.parse(obj.result) as IpcResponse;
          }
        }
      }
    }
    return { ok: false, error: 'timeout' };
  };
}

// ── /cancel command ───────────────────────────────────────────────────────────

export function isCancelCommand(message: string): boolean {
  return /^\/cancel(\s|$)/.test(message.trim());
}

/**
 * Dependency injection interface for handleCancelCommand.
 * `cancelFn` is called with the groupFolder and chatJid; it should send a
 * job.cancel IPC request to the orchestrator and return the reply text
 * ("Cancelled" or "No active job"). Injected in production via Redis;
 * stubbed in unit tests.
 */
export interface CancelCommandDeps {
  cancelFn: (groupFolder: string, chatJid: string) => Promise<string>;
}

/**
 * Handle the /cancel slash command.
 *
 * Delegates actual job lookup and deletion to cancelFn (which sends a
 * job.cancel IPC to the orchestrator). Returns the reply text.
 */
export async function handleCancelCommand(
  groupFolder: string,
  chatJid: string,
  deps: CancelCommandDeps,
): Promise<string> {
  return deps.cancelFn(groupFolder, chatJid);
}

/**
 * Build a production-wired cancel function backed by the task-request stream.
 * Sends a job.cancel IPC to the orchestrator and awaits the result with a
 * 5-second timeout.
 */
export function buildCancelFn(): CancelCommandDeps['cancelFn'] {
  return async (groupFolder: string, chatJid: string): Promise<string> => {
    const redis = getRedisClient();
    const resultStream = `kubeclaw:cancel-result:${Date.now()}-${randomBytes(4).toString('hex')}`;

    await redis.xadd(
      getTaskRequestStream(),
      '*',
      'type',
      'job.cancel',
      'groupFolder',
      groupFolder,
      'chatJid',
      chatJid,
      'resultStream',
      resultStream,
    );

    // Wait up to 5s for orchestrator response
    const deadline = Date.now() + 5000;
    let lastId = '0-0';
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await redis.xread(
        'COUNT',
        1,
        'BLOCK',
        Math.min(remaining, 1000),
        'STREAMS',
        resultStream,
        lastId,
      );
      if (!response) continue;
      for (const [, messages] of response as [string, [string, string[]][]][]) {
        for (const [, flds] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < flds.length; i += 2) obj[flds[i]] = flds[i + 1];
          if (obj.result) {
            const parsed = JSON.parse(obj.result) as {
              ok: boolean;
              status?: string;
              error?: string;
            };
            if (!parsed.ok) return `Cancel failed: ${parsed.error ?? 'unknown error'}`;
            return parsed.status === 'no_active_job' ? 'No active job' : 'Cancelled';
          }
        }
      }
    }
    return 'Cancel timed out — orchestrator did not respond';
  };
}

// ── /secret command help text ─────────────────────────────────────────────────

const SECRET_HELP = [
  'Secret commands:',
  '  /secret add <id> <value>                    — single-field shorthand',
  '  /secret add <id> <field>=<value> [...]      — multi-field form',
  '  /secret remove <id>',
  '  /secret list',
  '  /secret catalog',
  '  /secret help',
].join('\n');

// ── /secret command handler ───────────────────────────────────────────────────

/**
 * Handle a /secret slash command.
 *
 * Returns a result object describing what happened so the caller can:
 *  - send the `reply` to the user
 *  - inject `systemEvent` into transcript memory (if present)
 *  - append `assistantTurn` to transcript memory (if present)
 *
 * Cleartext values are zeroed in a `finally` block.
 *
 * The `ipc` parameter is the function used to send IPC requests. In production
 * this is built from createSecretIpcFn(); in tests it is injected as a mock.
 */
export interface SecretCommandResult {
  /** Message to send to the user */
  reply: string;
  /** If set, insert this as a SYSTEM event in transcript memory */
  systemEvent?: string;
  /** If set, append this as an assistant turn in transcript memory */
  assistantTurn?: string;
}

export interface SecretCommandDeps {
  /** Catalog from most-recent IPC catalog.list (may be empty if unavailable) */
  catalog: readonly CatalogEntry[];
  /**
   * IPC function for secret operations. Called with the per-request extra
   * fields (e.g. `{ fields: JSON.stringify(...) }`).
   */
  ipc: (
    type: 'secret.add' | 'secret.remove' | 'secret.list' | 'catalog.list',
    fields: Record<string, string>,
  ) => Promise<IpcResponse>;
}

export async function handleSecretCommand(
  group: string,
  message: string,
  deps: SecretCommandDeps,
): Promise<SecretCommandResult> {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== '/secret') return { reply: SECRET_HELP };

  const verb = parts[1];

  switch (verb) {
    case undefined:
    case 'help':
      return { reply: SECRET_HELP };

    case 'catalog': {
      let res: IpcResponse;
      try {
        res = await deps.ipc('catalog.list', {});
      } catch {
        return { reply: "Couldn't reach the orchestrator. Try again." };
      }
      if (!res.ok) return { reply: `Failed to retrieve catalog: ${res.error}` };
      const catalog = res.result as CatalogEntry[];
      if (!catalog || catalog.length === 0)
        return { reply: 'No catalog entries configured.' };
      const lines = catalog.map((e) => {
        const fields = e.credentialFields
          .map((f) => `${f.name} (${f.envVar})`)
          .join(', ');
        return `  ${e.id} — ${e.host} — fields: ${fields}`;
      });
      return { reply: `Catalog:\n${lines.join('\n')}` };
    }

    case 'list': {
      let res: IpcResponse;
      try {
        res = await deps.ipc('secret.list', { group });
      } catch {
        return { reply: "Couldn't reach the orchestrator. Try again." };
      }
      if (!res.ok) return { reply: `Failed to list secrets: ${res.error}` };
      const entries = res.result as Array<{
        catalogId: string;
        registeredAt: string;
      }>;
      if (!entries || entries.length === 0)
        return { reply: 'No credentials registered for this group.' };
      const lines = entries.map(
        (e) => `  ${e.catalogId} (registered ${e.registeredAt})`,
      );
      return { reply: `Registered credentials:\n${lines.join('\n')}` };
    }

    case 'remove': {
      const catalogId = parseSecretRemoveCommand(message);
      if (!catalogId) return { reply: 'Usage: /secret remove <id>' };

      let res: IpcResponse;
      try {
        res = await deps.ipc('secret.remove', { group, catalogId });
      } catch {
        return {
          reply:
            "Couldn't reach the orchestrator. The credential was NOT removed. Try again.",
        };
      }
      if (!res.ok)
        return { reply: `Failed to remove credential: ${res.error}` };

      const systemEvent = `[SYSTEM] User removed credential for catalog entry '${catalogId}'. Tool-jobs will no longer use credentials for this entry.`;
      const assistantTurn = `Removed — credentials for '${catalogId}' have been cleared for this group.`;
      return {
        reply: assistantTurn,
        systemEvent,
        assistantTurn,
      };
    }

    case 'add': {
      let cleartextFields: Record<string, string> | null = null;
      try {
        const parsed = parseSecretAddCommand(message);
        if (!parsed)
          return {
            reply:
              'Usage: /secret add <id> <value>  OR  /secret add <id> <field>=<value> [...]',
          };

        const { catalogId, fields: rawFields } = parsed;

        // Validate catalogId against catalog
        const catalogEntry = deps.catalog.find((e) => e.id === catalogId);
        if (!catalogEntry) {
          const available = deps.catalog.map((e) => e.id).join(', ') || 'none';
          return {
            reply: `Unknown API '${catalogId}'. Available: ${available}. Use \`/secret catalog\` for full list.`,
          };
        }

        // Resolve single-field shorthand
        let resolvedFields: Record<string, string>;
        if ('__single__' in rawFields) {
          if (catalogEntry.credentialFields.length !== 1) {
            const fieldNames = catalogEntry.credentialFields
              .map((f) => f.name)
              .join(', ');
            return {
              reply: `'${catalogId}' requires multiple fields: ${fieldNames}. Use: /secret add ${catalogId} ${fieldNames.replace(/, /g, '=<value> ')}=<value>`,
            };
          }
          const fieldName = catalogEntry.credentialFields[0].name;
          resolvedFields = { [fieldName]: rawFields['__single__'] };
        } else {
          resolvedFields = rawFields;
        }

        // Validate that all required fields are present
        const requiredFields = catalogEntry.credentialFields.map((f) => f.name);
        const missingFields = requiredFields.filter(
          (f) => !(f in resolvedFields),
        );
        if (missingFields.length > 0) {
          return {
            reply: `'${catalogId}' requires fields: ${requiredFields.join(', ')}. Got: ${Object.keys(resolvedFields).join(', ')}. Missing: ${missingFields.join(', ')}.`,
          };
        }

        // Validate values non-empty
        for (const [fieldName, value] of Object.entries(resolvedFields)) {
          if (!value || value.trim() === '') {
            return { reply: `Value for field '${fieldName}' is empty.` };
          }
        }

        // Keep cleartext in scope for zeroing
        cleartextFields = resolvedFields;

        let res: IpcResponse;
        try {
          res = await deps.ipc('secret.add', {
            group,
            catalogId,
            fields: JSON.stringify(resolvedFields),
          });
        } catch {
          return {
            reply:
              "Couldn't reach the orchestrator. The credential was NOT stored. Try again.",
          };
        }

        if (!res.ok) {
          const errMsg = res.error ?? 'unknown error';
          // Friendly messages for known orchestrator errors
          if (errMsg.includes('timeout')) {
            return {
              reply:
                "Couldn't reach the orchestrator. The credential was NOT stored. Try again.",
            };
          }
          return { reply: `Failed to store credential: ${errMsg}` };
        }

        // Build system event (metadata only — no values)
        const envVarNames = catalogEntry.credentialFields
          .map((f) => f.envVar)
          .join(', ');
        const systemEvent =
          `[SYSTEM] User registered credential for catalog entry '${catalogId}' ` +
          `(host: ${catalogEntry.host}). ` +
          `Tool-jobs will receive envs ${envVarNames} with placeholder values. ` +
          `The broker will substitute the real credential on outbound requests to ${catalogEntry.host}.`;

        const assistantTurn = `Got it — ${catalogEntry.id} is now configured for this group.`;

        return {
          reply: assistantTurn,
          systemEvent,
          assistantTurn,
        };
      } finally {
        // Reassign cleartext to empty string; JS string immutability means the original
        // heap allocation cannot be wiped in-place, but residency is bounded by GC.
        // Documented as accepted risk in docs/SECURITY.md threat model.
        if (cleartextFields) {
          for (const key of Object.keys(cleartextFields)) {
            const buf = Buffer.from(cleartextFields[key], 'utf8');
            buf.fill(0);
            cleartextFields[key] = '';
          }
          cleartextFields = null;
        }
      }
    }

    default:
      return { reply: `Unknown subcommand: ${verb}\n\n${SECRET_HELP}` };
  }
}

// ── /schedule command ──────────────────────────────────────────────────────


const SCHEDULE_HELP = [
  'Schedule commands:',
  '  /schedule add interval <ms> <prompt>    — run every <ms> milliseconds',
  '  /schedule add cron <expr> <prompt>      — run on a cron schedule',
  '  /schedule add once <iso-date> <prompt>  — run once at the given time',
  '  /schedule list                          — list tasks for this group',
  '  /schedule remove <id>                   — remove a task by id',
  '  /schedule help                          — show this help',
].join('\n');

export function isScheduleCommand(message: string): boolean {
  return /^\/schedule(\s|$)/.test(message.trim());
}

/**
 * Parsed form of a `/schedule add` command.
 *
 * schedule_type: 'interval' | 'cron' | 'once'
 * schedule_value: the raw value string (ms, cron expr, or ISO date)
 * prompt: the remainder of the line after the type + value tokens
 */
export interface ScheduleAddCommand {
  schedule_type: 'interval' | 'cron' | 'once';
  schedule_value: string;
  prompt: string;
}

/**
 * Parse `/schedule add <type> <value> <prompt>`.
 * Returns null if the subcommand is missing, the type is unrecognised,
 * or the prompt is empty.
 */
export function parseScheduleAddCommand(
  message: string,
): ScheduleAddCommand | null {
  // /schedule add <type> <value> <...prompt>
  const m = /^\/schedule\s+add\s+(\S+)\s+(\S+)\s+(.+)$/is.exec(message.trim());
  if (!m) return null;

  const raw = m[1].toLowerCase();
  if (raw !== 'interval' && raw !== 'cron' && raw !== 'once') return null;

  return {
    schedule_type: raw as 'interval' | 'cron' | 'once',
    schedule_value: m[2],
    prompt: m[3].replace(/^["']|["']$/g, '').trim(),
  };
}

/**
 * Handle a `/schedule` slash command.
 *
 * All DB operations are synchronous (sql.js) — no async required, but the
 * function signature is async for consistency with handleSecretCommand and to
 * allow future I/O without a signature change.
 */
export async function handleScheduleCommand(
  groupFolder: string,
  chatJid: string,
  message: string,
): Promise<string> {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== '/schedule') return SCHEDULE_HELP;

  const verb = parts[1];

  switch (verb) {
    case undefined:
    case 'help':
      return SCHEDULE_HELP;

    case 'add': {
      const parsed = parseScheduleAddCommand(message);
      if (!parsed) {
        return (
          'Usage: /schedule add <interval|cron|once> <value> <prompt>\n\n' +
          SCHEDULE_HELP
        );
      }

      const { schedule_type, schedule_value, prompt } = parsed;

      // Compute next_run based on type
      let next_run: string | null;
      if (schedule_type === 'once') {
        next_run = schedule_value;
      } else if (schedule_type === 'interval') {
        const ms = parseInt(schedule_value, 10);
        if (!ms || ms <= 0) {
          return `Invalid interval value '${schedule_value}'. Must be a positive integer (milliseconds).`;
        }
        next_run = new Date(Date.now() + ms).toISOString();
      } else {
        // cron — validate by attempting parse; fall back to a safe next run
        try {
          const { CronExpressionParser } = await import('cron-parser');
          next_run = CronExpressionParser.parse(schedule_value, {
            tz: TIMEZONE,
          })
            .next()
            .toISOString();
        } catch {
          return `Invalid cron expression: '${schedule_value}'`;
        }
      }

      const id = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

      createTask({
        id,
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt,
        schedule_type,
        schedule_value,
        context_mode: 'isolated',
        next_run,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      return `Scheduled task created.\nid: ${id}\ntype: ${schedule_type}\nvalue: ${schedule_value}\nnext_run: ${next_run}`;
    }

    case 'list': {
      const tasks = getTasksForGroup(groupFolder);
      if (tasks.length === 0) return 'No scheduled tasks.';

      const lines = tasks.map((t) =>
        [
          `id: ${t.id}`,
          `  type: ${t.schedule_type}`,
          `  value: ${t.schedule_value}`,
          `  status: ${t.status}`,
          `  next_run: ${t.next_run ?? 'n/a'}`,
          `  prompt: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '…' : ''}`,
        ].join('\n'),
      );
      return `Scheduled tasks (${tasks.length}):\n\n${lines.join('\n\n')}`;
    }

    case 'remove': {
      const id = parts[2];
      if (!id) return 'Usage: /schedule remove <id>';

      const deleted = deleteTaskForGroup(id, groupFolder);
      if (!deleted) {
        return `Task '${id}' not found for this group.`;
      }
      return `Removed task '${id}'.`;
    }

    default:
      return `Unknown subcommand: ${verb}\n\n${SCHEDULE_HELP}`;
  }
}

// ── /memory command ───────────────────────────────────────────────────────────

export function isMemoryCommand(message: string): boolean {
  return /^\/memory(\s|$)/.test(message.trim());
}

/**
 * Handle a /memory slash command.
 *
 * Reads or writes `groups/<groupFolder>/CLAUDE.md` for the authenticated
 * user's group. The path is always constructed from `groupFolder`, which
 * comes from the authenticated user's JID — no user-supplied path component
 * is accepted.
 *
 * Subcommands:
 *   /memory show            — print the file, or "No memory set" if absent
 *   /memory append <text>   — append text (with newline), creating if needed
 *   /memory set <text>      — overwrite entirely (empty string truncates)
 */
export async function handleMemoryCommand(
  groupFolder: string,
  message: string,
  groupsDir: string = GROUPS_DIR,
): Promise<string> {
  // Defence-in-depth: validate the folder name even though production call
  // sites already pre-validate via registerGroup.
  if (!isValidGroupFolder(groupFolder)) {
    return 'Memory command failed: invalid group folder.';
  }
  const memoryPath = path.join(groupsDir, groupFolder, 'CLAUDE.md');
  const parts = message.trim().split(/\s+/);
  const verb = parts[1];

  switch (verb) {
    case undefined:
    case 'help':
      return [
        'Memory commands:',
        '  /memory show              — show your group memory',
        '  /memory append <text>     — append text to your group memory',
        '  /memory set <text>        — replace your group memory entirely',
      ].join('\n');

    case 'show': {
      try {
        const content = await fsPromises.readFile(memoryPath, 'utf8');
        return content.trim() === '' ? 'No memory set.' : content;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return 'No memory set.';
        }
        throw err;
      }
    }

    case 'append': {
      const text = parts.slice(2).join(' ');
      if (!text) return 'Usage: /memory append <text>';
      await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
      let existing = '';
      try {
        existing = await fsPromises.readFile(memoryPath, 'utf8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const separator = existing.endsWith('\n') || existing === '' ? '' : '\n';
      await fsPromises.writeFile(
        memoryPath,
        existing + separator + text + '\n',
        'utf8',
      );
      return 'Memory updated.';
    }

    case 'set': {
      // Everything after "set" is the replacement text. Trim leading/trailing
      // whitespace to stay consistent with /memory append.
      const text = message
        .trim()
        .replace(/^\/memory\s+set\s*/, '')
        .trim();
      await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
      await fsPromises.writeFile(memoryPath, text, 'utf8');
      return text === '' ? 'Memory cleared.' : 'Memory updated.';
    }

    default:
      return [
        `Unknown subcommand: ${verb}`,
        'Memory commands:',
        '  /memory show              — show your group memory',
        '  /memory append <text>     — append text to your group memory',
        '  /memory set <text>        — replace your group memory entirely',
      ].join('\n');
  }
}

// ── /specialists command ──────────────────────────────────────────────────────

/**
 * Return true if the message is a `/specialists` slash command.
 */
export function isSpecialistsCommand(message: string): boolean {
  return /^\/specialists(\s|$)/i.test(message.trim());
}

/**
 * Handle a `/specialists` command. Reads from the channel's in-process catalog
 * (no IPC round-trip) and returns a formatted plain-text reply.
 *
 * Sub-commands:
 *   /specialists list — list all specialists (name + truncated description)
 *   anything else     — usage hint
 */
export function handleSpecialistsCommand(
  message: string,
  catalog: Pick<SpecialistCatalogLoader, 'getAll'>,
): string {
  const trimmed = message.trim();
  const subCommand = trimmed
    .replace(/^\/specialists\s*/i, '')
    .trim()
    .toLowerCase();

  if (subCommand !== 'list') {
    return 'Usage: /specialists list';
  }

  const specialists = catalog.getAll();
  if (specialists.length === 0) {
    return 'No specialists configured';
  }

  const lines = specialists.map((s) => {
    // Iterate code points so we don't split a surrogate pair (and produce a
    // mojibake U+FFFD) on emoji-containing prompts.
    const codepoints = [...s.prompt];
    const desc =
      codepoints.length > 80
        ? codepoints.slice(0, 80).join('') + '…'
        : s.prompt;
    return `@${s.name} — ${desc}`;
  });
  return lines.join('\n');
}

// ── /capabilities command ─────────────────────────────────────────────────────

export function isCapabilitiesCommand(message: string): boolean {
  return /^\/capabilities(\s|$)/.test(message.trim());
}

const CAPABILITIES_HELP = [
  'Capability commands:',
  '  /capabilities add <type>      — provision a per-group capability',
  '  /capabilities list            — list active capabilities for this group',
  '  /capabilities remove <type>   — remove a per-group capability',
  '  /capabilities tools <type>    — list MCP tools exposed by a provisioned per-group capability',
  '  /capabilities help',
].join('\n');

export interface CapabilityCommandResult {
  reply: string;
}

export type CapabilityIpcFn = (
  type: 'capability.add' | 'capability.list' | 'capability.remove',
  fields: Record<string, string>,
) => Promise<IpcResponse>;

/**
 * Create a real Redis-backed IPC function for capability operations.
 * Mirrors createSecretIpcFn but for the capability.* verb set.
 */
export function createCapabilityIpcFn(): CapabilityIpcFn {
  return async (type, fields) => {
    const redis = getRedisClient();
    const resultStream = `kubeclaw:capability-result:${Date.now()}-${randomBytes(4).toString('hex')}`;

    const allFields: string[] = ['type', type, 'resultStream', resultStream];
    for (const [k, v] of Object.entries(fields)) {
      allFields.push(k, v);
    }
    await redis.xadd(getTaskRequestStream(), '*', ...allFields);

    // 10s timeout (vs the 5s used by createSecretIpcFn) — capability.add
    // triggers a K8s reconcile (Deployment + Service + NetworkPolicy apply)
    // which is meaningfully slower than the SQLite write that backs secret.*.
    const deadline = Date.now() + 10_000;
    let lastId = '0-0';
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await redis.xread(
        'COUNT',
        1,
        'BLOCK',
        Math.min(remaining, 1000),
        'STREAMS',
        resultStream,
        lastId,
      );
      if (!response) continue;
      for (const [, messages] of response as [string, [string, string[]][]][]) {
        for (const [, flds] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < flds.length; i += 2) obj[flds[i]] = flds[i + 1];
          if (obj.result) {
            return JSON.parse(obj.result) as IpcResponse;
          }
        }
      }
    }
    return { ok: false, error: 'timeout' };
  };
}

/**
 * Handle a /capabilities slash command.
 *
 * groupFolder is the per-group folder (e.g. 'http-http-alice'); it is passed
 * in every IPC call so the orchestrator scopes operations correctly (AC5).
 */
export async function handleCapabilitiesCommand(
  groupFolder: string,
  message: string,
  ipc: CapabilityIpcFn,
): Promise<CapabilityCommandResult> {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== '/capabilities') return { reply: CAPABILITIES_HELP };

  const verb = parts[1];

  switch (verb) {
    case undefined:
    case 'help':
      return { reply: CAPABILITIES_HELP };

    case 'add': {
      const capabilityType = parts[2];
      if (!capabilityType) {
        return { reply: 'Usage: /capabilities add <type>' };
      }
      let res: IpcResponse;
      try {
        res = await ipc('capability.add', { groupFolder, capabilityType });
      } catch {
        return { reply: "Couldn't reach the orchestrator. Try again." };
      }
      if (!res.ok) {
        return {
          reply: `Failed to provision capability: ${(res as { ok: false; error: string }).error}`,
        };
      }
      const addResult = res.result as {
        deploymentName?: string;
        message: string;
        alreadyProvisioned: boolean;
      };
      if (addResult.alreadyProvisioned) {
        return {
          reply: `Already provisioned — deployment '${addResult.deploymentName ?? capabilityType}' already exists for this group.`,
        };
      }
      return {
        reply: `Provisioned — capability '${capabilityType}' is being deployed as '${addResult.deploymentName ?? capabilityType}'.`,
      };
    }

    case 'list': {
      let res: IpcResponse;
      try {
        res = await ipc('capability.list', { groupFolder });
      } catch {
        return { reply: "Couldn't reach the orchestrator. Try again." };
      }
      if (!res.ok) {
        return {
          reply: `Failed to list capabilities: ${(res as { ok: false; error: string }).error}`,
        };
      }
      const entries = res.result as Array<{
        type: string;
        deploymentName: string;
        replicas: number;
        lastUsedAt: number | null;
        scaleDownAfterIdleSeconds: number;
      }>;
      if (!entries || entries.length === 0) {
        return { reply: 'No capabilities provisioned for this group.' };
      }
      const lines = entries.map((e) => {
        const lastUsed = e.lastUsedAt
          ? new Date(e.lastUsedAt * 1000).toISOString()
          : 'never';
        return `  ${e.type} | deployment: ${e.deploymentName} | replicas: ${e.replicas} | lastUsedAt: ${lastUsed} | scaleDownAfterIdleSeconds: ${e.scaleDownAfterIdleSeconds}`;
      });
      return { reply: `Active capabilities:\n${lines.join('\n')}` };
    }

    case 'remove': {
      const capabilityType = parts[2];
      if (!capabilityType) {
        return { reply: 'Usage: /capabilities remove <type>' };
      }
      let res: IpcResponse;
      try {
        res = await ipc('capability.remove', { groupFolder, capabilityType });
      } catch {
        return { reply: "Couldn't reach the orchestrator. Try again." };
      }
      if (!res.ok) {
        return {
          reply: `Failed to remove capability: ${(res as { ok: false; error: string }).error}`,
        };
      }
      return {
        reply: `Removed — capability '${capabilityType}' has been deleted for this group.`,
      };
    }

    case 'tools': {
      const type = parts[2];
      if (!type) {
        return { reply: 'Usage: /capabilities tools <type>\n\n' + CAPABILITIES_HELP };
      }
      const entry = _groupCapabilityEntries.get(type);
      if (!entry) {
        return { reply: `Capability '${type}' is not provisioned for this group.` };
      }
      if (entry.state === 'pending-schema') {
        return { reply: `Capability '${type}' is provisioned but schema not yet available, try again in a few seconds.` };
      }
      if (entry.state === 'failed') {
        return { reply: `Capability '${type}' schema scrape failed: ${entry.error ?? 'unknown error'}.` };
      }
      const schemas = entry.toolSchemas;
      if (!schemas || schemas.length === 0) {
        return { reply: `Capability '${type}' has no tools registered.` };
      }
      const lines = schemas.map((t) => {
        const desc = t.description
          ? t.description.slice(0, 80) + (t.description.length > 80 ? '…' : '')
          : '(no description)';
        return `  ${t.name} — ${desc}`;
      });
      return { reply: `Tools for '${type}':\n${lines.join('\n')}` };
    }

    default:
      return { reply: `Unknown subcommand: ${verb}\n\n${CAPABILITIES_HELP}` };
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  overrides: RunAgentOverrides = {},
  originMessageId?: string | null,
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
        originMessageId: originMessageId ?? null,
      },
      undefined,
      wrappedOnOutput,
      overrides,
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

/** @internal Test use only — inject fake state so processGroupMessages can be called in isolation. */
export function _testInjectState(
  groups: Record<string, RegisteredGroup>,
  channelsArray: Channel[],
): void {
  for (const [jid, group] of Object.entries(groups)) {
    registeredGroups[jid] = group;
  }
  for (const ch of channelsArray) {
    channels.push(ch);
  }
}

/** @internal Test use only — reset module-level state between tests. */
export function _testResetState(): void {
  for (const key of Object.keys(registeredGroups)) {
    delete registeredGroups[key];
  }
  channels.length = 0;
  for (const key of Object.keys(lastAgentTimestamp)) {
    delete lastAgentTimestamp[key];
  }
}

export async function processGroupMessages(chatJid: string): Promise<boolean> {
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

  // Slash command intercepts: each message in the batch is inspected before
  // being passed to the LLM. Slash commands are handled in-loop and skipped
  // from the normalMessages list; non-slash messages accumulate for a single
  // LLM call at the end.
  //
  // This ensures a mixed batch like ["tell me about Rust", "/search rust"] gets
  // BOTH responses: the /search reply and an LLM turn for the normal message —
  // rather than only the last message being checked (the old behaviour).
  //
  // Must run BEFORE formatMessages wraps content in XML, which would break the
  // regex matches inside isSearchCommand / isSkillsCommand / isSecretCommand.

  const normalMessages: typeof missedMessages = [];

  for (const msg of missedMessages) {
    const content = msg.content;

    // /help chat command: list available slash commands without invoking the LLM.
    if (isHelpCommand(content)) {
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, HELP_TEXT);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /search chat command: full-text search over conversation history.
    if (isSearchCommand(content)) {
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        const reply = handleSearchCommand(group.folder, content.trim());
        await channel.sendMessage(chatJid, reply);
      } catch (err) {
        logger.error({ err, chatJid }, 'Search command failed');
        try {
          await channel.sendMessage(
            chatJid,
            'Search failed: invalid query. Try simpler terms.',
          );
        } catch (sendErr) {
          logger.error(
            { err: sendErr, chatJid },
            'Failed to send search error reply',
          );
        }
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /clear chat command: wipe conversation history without invoking the LLM.
    if (/^\/clear(\s|$)/.test(content.trim())) {
      clearConversationHistory(group.folder);
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      try {
        await channel.sendMessage(
          chatJid,
          'Conversation history and summaries cleared.',
        );
      } catch (err) {
        logger.error({ err, chatJid }, '/clear reply send failed');
      }
      continue;
    }

    // /skills chat command: handle locally without invoking the LLM.
    if (isSkillsCommand(content)) {
      const reply = handleSkillsCommand(
        GROUPS_DIR,
        group.folder,
        chatJid,
        content.trim(),
      );
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /compact and /summary chat commands: handle without invoking the LLM
    // (for /summary and no-op /compact paths). For /compact when summarisation
    // is needed, pass the channel's LLM client and model. We exclude /clear here
    // because that verb is already handled by the compression-commands module
    // itself via handleCompactCommand, so routing it through here is harmless —
    // but we still want to catch all three verbs via isCompactCommand and let
    // handleCompactCommand dispatch on the verb internally.
    if (isCompactCommand(content)) {
      const { verb } = parseCompactArgs(content.trim());
      // Only intercept compact and summary here; clear falls through to the
      // same handleCompactCommand path. We intercept all three so none reach the LLM.
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        const client = createLLMClient();
        const reply = await handleCompactCommand(
          group.folder,
          content.trim(),
          client,
          DEFAULT_DIRECT_MODEL,
        );
        await channel.sendMessage(chatJid, reply);
      } catch (err) {
        logger.error({ err, chatJid, verb }, 'Compact/summary command failed');
        try {
          await channel.sendMessage(
            chatJid,
            `Command failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch (sendErr) {
          logger.error(
            { err: sendErr, chatJid },
            'Failed to send compact error reply',
          );
        }
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /cancel command: abort the currently running tool job for this group.
    if (isCancelCommand(content)) {
      const cancelDeps: CancelCommandDeps = { cancelFn: buildCancelFn() };
      const reply = await handleCancelCommand(group.folder, chatJid, cancelDeps);
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /jobs command: list active and recent tool jobs for this group.
    if (isJobsCommand(content)) {
      const reply = handleJobsCommand(group.folder);
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /secret command: handle upstream of LLM; raw user line is dropped from
    // transcript memory and a SYSTEM event is injected in its place.
    if (isSecretCommand(content)) {
      // Build a minimal IPC function backed by the real Redis task-request stream
      // Carry the group folder so the orchestrator's task watcher accepts the
      // request — without it the watcher silently drops every secret IPC.
      const secretIpc: SecretCommandDeps['ipc'] = async (type, fields) => {
        const ipcFn = createSecretIpcFn(type, { groupFolder: group.folder });
        return ipcFn(fields);
      };

      // Fetch catalog for validation (best-effort; empty catalog means unknown-id errors)
      let catalog: readonly CatalogEntry[] = [];
      try {
        const catalogRes = await secretIpc('catalog.list', {});
        if (catalogRes.ok && Array.isArray(catalogRes.result)) {
          catalog = catalogRes.result as CatalogEntry[];
        }
      } catch {
        // Catalog unavailable; proceed with empty catalog (will report unknown-id error)
      }

      const result = await handleSecretCommand(
        group.folder,
        content.trim(),
        {
          catalog,
          ipc: secretIpc,
        },
      );

      // Persist the system event and assistant turn so subsequent LLM turns see
      // the credential-registration context in conversation history. The raw
      // /secret line is intentionally NOT stored (already dropped by the
      // getMessagesSince query never being called for it).
      if (result.systemEvent) {
        appendConversationMessage(group.folder, 'user', result.systemEvent);
      }
      if (result.assistantTurn) {
        appendConversationMessage(
          group.folder,
          'assistant',
          result.assistantTurn,
        );
      }

      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, result.reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /schedule command: add/list/remove user-managed scheduled tasks. No LLM.
    if (isScheduleCommand(content)) {
      let reply: string;
      try {
        reply = await handleScheduleCommand(group.folder, chatJid, content);
      } catch (err) {
        logger.error({ err, chatJid }, '/schedule command failed');
        reply = 'Schedule command failed. Please try again.';
      }
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /memory command: read/append/set per-group CLAUDE.md. No LLM, no IPC.
    if (isMemoryCommand(content)) {
      let reply: string;
      try {
        reply = await handleMemoryCommand(group.folder, content);
      } catch (err) {
        logger.error({ err, chatJid }, '/memory command failed');
        reply = 'Memory command failed. Please try again.';
      }
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /specialists command: reads from the channel's in-process catalog, no IPC.
    if (isSpecialistsCommand(content)) {
      const reply = handleSpecialistsCommand(
        content.trim(),
        specialistCatalog,
      );
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // /capabilities command: handle upstream of LLM; group-scoped provisioning.
    if (isCapabilitiesCommand(content)) {
      const capIpc = createCapabilityIpcFn();
      const capResult = await handleCapabilitiesCommand(
        group.folder,
        content.trim(),
        capIpc,
      );
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      await channel.setTyping?.(chatJid, true);
      try {
        await channel.sendMessage(chatJid, capResult.reply);
      } finally {
        await channel.setTyping?.(chatJid, false);
      }
      continue;
    }

    // Not a slash command — collect for the LLM batch call below.
    normalMessages.push(msg);
  }

  // If every message in the batch was a slash command, we're done.
  // Advance the timestamp to the last message so those messages aren't
  // reprocessed on the next poll.
  if (normalMessages.length === 0) {
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Coarse-regex backstop: scrub credential-shaped strings from all messages
  // before passing them to the LLM. The backstop is independent of the
  // slash-command parser — if the parser already handled the message, we
  // never reach here.
  const backstopMessages = normalMessages.map((m) =>
    m.is_from_me ? m : { ...m, content: applyCredentialBackstop(m.content) },
  );

  const prompt = formatMessages(backstopMessages, TIMEZONE);
  // For memory.isolated specialists, the prompt must also be isolated from
  // the group's prior turns — otherwise the LLM sees them inline and treats
  // them as conversation history, even though the *session* is per-specialist.
  // Build a single-message prompt from just the last (triggering) message so
  // the isolated specialist sees the @mention turn with no prior context.
  const isolatedPrompt =
    backstopMessages.length > 0
      ? formatMessages(
          [backstopMessages[backstopMessages.length - 1]],
          TIMEZONE,
        )
      : prompt;
  const catalog = specialistCatalog.getAll();
  const mentionedSpecialists = detectMentionedSpecialists(prompt, catalog);

  // ── Per-turn credential system block ─────────────────────────────────────
  // Rebuild fresh on each turn so that newly registered credentials (via
  // /secret add in this conversation) are reflected immediately. The block
  // is prepended to the prompt so the LLM sees it as part of the user turn.
  let credentialSystemBlock = '';
  try {
    const credIpc = buildCredentialIpcClient();
    const credEntries = await listCredentialsTool(
      { group: group.folder },
      { ipc: credIpc },
    );
    credentialSystemBlock = buildCredentialSystemBlock(
      credEntries,
      group.folder,
    );
  } catch {
    // Catalog unavailable — omit the block rather than failing the turn.
  }

  interface DispatchRun {
    specialistName?: string;
    prompt: string;
    overrides: RunAgentOverrides;
  }

  const runs: DispatchRun[] =
    mentionedSpecialists.length > 0
      ? mentionedSpecialists.map((s) => {
          const isolated = s.memory?.isolated === true;
          // For isolated specialists, the specialist prompt + CLAUDE.md
          // become the LLM's system message and the user content is just
          // the triggering @mention turn — no group history, no embedded
          // specialist directive. Non-isolated specialists keep the
          // single-user-message format so the LLM can see the group
          // conversation context.
          const specPrompt = isolated ? isolatedPrompt : prompt;
          const specialistBlock = `<specialist name="${s.name}">\n${s.prompt}${
            s.claudemd ? `\n\n${s.claudemd}` : ''
          }\n</specialist>`;
          const systemPromptOverride = isolated
            ? credentialSystemBlock
              ? `${credentialSystemBlock}\n\n${specialistBlock}`
              : specialistBlock
            : undefined;
          const userPrompt = isolated
            ? specPrompt
            : credentialSystemBlock
              ? `${credentialSystemBlock}\n\n${specialistBlock}\n\n${specPrompt}`
              : `${specialistBlock}\n\n${specPrompt}`;
          return {
            specialistName: s.name,
            prompt: userPrompt,
            overrides: {
              sessionKey: isolated ? `${group.folder}:${s.name}` : group.folder,
              llmProvider: s.llmProvider,
              toolFilter:
                s.tools && s.tools.length > 0 ? new Set(s.tools) : undefined,
              systemPromptOverride,
            },
          };
        })
      : [
          {
            prompt: credentialSystemBlock
              ? `${credentialSystemBlock}\n\n${prompt}`
              : prompt,
            overrides: {},
          },
        ];

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: normalMessages.length },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Tracks specialists whose runs completed with an error (agentStatus='error'
  // or runAgent threw) so we can emit a user-visible error reply for each one.
  const failedSpecialists: string[] = [];

  // Named helper so Task 11 (telemetry) has a stable extension point.
  async function runOne(run: DispatchRun): Promise<void> {
    const start = Date.now();
    let status: 'success' | 'error' = 'success';
    try {
      const agentStatus = await runAgent(
        group,
        run.prompt,
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
              const out = run.specialistName
                ? `[@${run.specialistName}] ${text}`
                : text;
              await channel!.sendMessage(chatJid, out);
              outputSentToUser = true;
            }
          }
          if (result.status === 'success') queue.notifyIdle(chatJid);
          if (result.status === 'error') {
            status = 'error';
            hadError = true;
          }
        },
        run.overrides,
        // Pass the originating message ID so tool jobs can be correlated back
        // to the user's request if the orchestrator restarts (Story 37 AC2).
        normalMessages[normalMessages.length - 1]?.id ?? null,
      );
      if (agentStatus === 'error') {
        status = 'error';
        hadError = true;
        // Story 51: track in failedSpecialists so the post-loop block sends
        // the user-visible reply + storeMessage. The guard mirrors the
        // throw-path's catch-arm push: skip if partial output already reached
        // the user (post-loop's outputSentToUser early-return then suppresses).
        if (run.specialistName && !outputSentToUser) {
          failedSpecialists.push(run.specialistName);
        }
      }
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      if (run.specialistName) {
        recordSpecialistUsage({
          groupFolder: group.folder,
          specialistName: run.specialistName,
          durationMs: Date.now() - start,
          status,
        });
      }
    }
  }

  const results = await Promise.allSettled(runs.map(runOne));

  // Defensive guard: in normal operation `runAgent` catches all exceptions
  // internally and returns { status: 'error' } — so `runOne` settles
  // `fulfilled` and this loop is a no-op. We keep it in case a future
  // refactor changes runAgent's contract; logging here surfaces the
  // regression rather than silently swallowing the rejection.
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      hadError = true;
      const specName = runs[i].specialistName;
      logger.error(
        { err: r.reason, specialist: specName },
        'specialist run failed (unexpected rejection — runAgent should catch internally)',
      );
      if (specName && !failedSpecialists.includes(specName)) {
        failedSpecialists.push(specName);
      }
    }
  }

  await channel.setTyping?.(chatJid, false);

  if (hadError) {
    if (outputSentToUser) {
      // Partial output already reached the user — don't send a confusing
      // error on top of it. Just persist what we have and move on.
      saveState();
      return true;
    }
    // No output reached the user yet. Send a visible error for each failed
    // specialist so the user knows to retry rather than stare at silence.
    for (const [idx, specName] of failedSpecialists.entries()) {
      const errText = `[@${specName}] Error: specialist run failed`;
      await channel.sendMessage(chatJid, errText);
      storeMessage({
        // Include `idx` so two specialists failing in the same millisecond
        // (unlikely under sequential await, but theoretically possible if
        // failedSpecialists has duplicates from concurrent rejections) get
        // distinct PKs.
        id: `err-${specName}-${Date.now()}-${idx}`,
        chat_jid: chatJid,
        sender: 'system',
        sender_name: 'system',
        content: errText,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    }
    saveState();
    return true;
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

const CURATOR_INTERVAL_MS = Number(
  process.env.SKILL_CURATOR_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);

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
            {
              group: group.name,
              folder: group.folder,
              candidates: res.candidatesWritten,
            },
            'skill curator staged candidates',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'skill curator interval iteration failed');
    }
  }, CURATOR_INTERVAL_MS).unref();
}

// ── Tool-job prune scheduler ──────────────────────────────────────────────────

/**
 * How many days to retain resolved tool_jobs rows.
 * 0 = disabled (no pruning). Defaults to 30 days.
 * Injected via TOOL_JOBS_RETENTION_DAYS env var (set from Helm value
 * httpChannel.toolJobsRetentionDays).
 */
export const TOOL_JOBS_RETENTION_DAYS = parseInt(
  process.env.TOOL_JOBS_RETENTION_DAYS ?? '30',
  10,
);

/**
 * The prune interval in milliseconds. Runs once per hour by default.
 * Exported for testing.
 */
export const TOOL_JOBS_PRUNE_INTERVAL_MS = Number(
  process.env.TOOL_JOBS_PRUNE_INTERVAL_MS ?? 60 * 60 * 1000,
);

/**
 * Start a low-frequency interval that deletes resolved tool_jobs rows older
 * than TOOL_JOBS_RETENTION_DAYS.
 *
 * Fires once per hour (3 600 000 ms) — well below the poll tick frequency so
 * it has no measurable effect on message throughput.
 *
 * When TOOL_JOBS_RETENTION_DAYS=0 the function returns immediately without
 * scheduling anything.
 */
export function startToolJobPruneInterval(): void {
  if (!Number.isFinite(TOOL_JOBS_RETENTION_DAYS) || TOOL_JOBS_RETENTION_DAYS <= 0) {
    logger.info(
      'tool-job prune disabled (TOOL_JOBS_RETENTION_DAYS=0)',
    );
    return;
  }
  setInterval(() => {
    try {
      const deleted = pruneOldToolJobs(TOOL_JOBS_RETENTION_DAYS);
      if (deleted > 0) {
        logger.info(
          { deleted, retentionDays: TOOL_JOBS_RETENTION_DAYS },
          'Pruned old tool_jobs rows',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'tool-job prune interval iteration failed');
    }
  }, TOOL_JOBS_PRUNE_INTERVAL_MS).unref();
}

/**
 * Build the reusable IPC client for credential tool calls.
 * Wraps createSecretIpcFn to match the IpcClient call signature.
 */
function buildCredentialIpcClient(): IpcClient {
  return async (type, fields) => {
    const fn = createSecretIpcFn(type, {});
    return fn(fields);
  };
}

/**
 * Register channel-resident credential tools with the DirectLLMRunner singleton.
 * Called once at startup before the first runAgent() invocation.
 *
 * The list_credentials tool is intercepted locally — no K8s tool pod is spawned.
 */
export function registerCredentialTools(
  runner: ReturnType<typeof getDirectLLMRunner>,
  ipcOverride?: IpcClient,
): void {
  const ipc = ipcOverride ?? buildCredentialIpcClient();
  runner.registerLocalTool('list_credentials', {
    def: LIST_CREDENTIALS_TOOL_DEF,
    handler: async (_args, input) => {
      try {
        const entries = await listCredentialsTool(
          { group: input.groupFolder },
          { ipc },
        );
        return JSON.stringify(entries);
      } catch (err) {
        return `list_credentials error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
  logger.debug('Registered list_credentials local tool');
}

// ── Test-only exports ────────────────────────────────────────────────────────
// These are prefixed with _ and must not be called in production code.

export function _setRegisteredGroupsForTesting(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

export function _pushChannelForTesting(ch: Channel): void {
  channels.push(ch);
}

export function _resetStateForTesting(): void {
  registeredGroups = {};
  lastAgentTimestamp = {};
  sessions = {};
  channels.length = 0;
}

export function _setSpecialistCatalogForTesting(
  catalog: Pick<SpecialistCatalogLoader, 'getAll'>,
): void {
  specialistCatalog = catalog;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start the specialist catalog watcher before the message loop.
  (specialistCatalog as SpecialistCatalogLoader).start?.();
  startHealthServer();

  const channelMetricsRegistry = new Registry();
  const channelMetrics = createChannelMetrics(channelMetricsRegistry);
  const channelMetricsServer = createMetricsServer({
    registry: channelMetricsRegistry,
    port: parseInt(process.env.METRICS_PORT ?? '9091', 10),
  });
  await channelMetricsServer.listen();

  // Wire channel metrics into the DirectLLMRunner
  getDirectLLMRunner().setChannelMetrics(channelMetrics);

  await initDatabase();
  logger.info(`Database initialized (channel: ${KUBECLAW_CHANNEL})`);
  startSkillCuratorInterval();
  startToolJobPruneInterval();
  loadState();
  await loadChannelPlugins('/workspace/plugins');
  registerCredentialTools(getDirectLLMRunner());

  const shutdown = _buildShutdown(channelMetricsServer, queue, channels);
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
          logger.info(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message',
          );
          return;
        }
      }
      storeMessage(msg);
      // Record inbound message after allowlist check passes
      const group = registeredGroups[chatJid];
      if (group) {
        channelMetrics.recordMessage({
          channelKind: KUBECLAW_CHANNEL_TYPE,
          group: group.folder,
        });
      }
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
    // AC4 (Story 37): persist interruption notices in the channel DB so the
    // messages table has a row with is_from_me=1, is_bot_message=1.
    storeBotMessage: (jid: string, text: string, noticeId: string) => {
      storeMessage({
        id: noticeId,
        chat_jid: jid,
        sender: 'assistant',
        sender_name: 'assistant',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
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
