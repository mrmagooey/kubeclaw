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
  appendConversationMessage,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConversationHistory,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
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

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  overrides: RunAgentOverrides = {},
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

  // Slash command intercepts: /search, /skills and /secret must live here — BEFORE
  // formatMessages wraps the content in XML, which would break the regex match.
  const lastMsg = missedMessages[missedMessages.length - 1];

  // /search chat command: full-text search over conversation history.
  if (lastMsg && isSearchCommand(lastMsg.content)) {
    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();
    await channel.setTyping?.(chatJid, true);
    try {
      const reply = handleSearchCommand(group.folder, lastMsg.content.trim());
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
    return true;
  }

  // /skills chat command: handle locally without invoking the LLM.
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

  // /secret command: handle upstream of LLM; raw user line is dropped from
  // transcript memory and a SYSTEM event is injected in its place.
  if (lastMsg && isSecretCommand(lastMsg.content)) {
    // Build a minimal IPC function backed by the real Redis task-request stream
    const secretIpc: SecretCommandDeps['ipc'] = async (type, fields) => {
      const ipcFn = createSecretIpcFn(type, {});
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
      lastMsg.content.trim(),
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

    lastAgentTimestamp[chatJid] = lastMsg.timestamp;
    saveState();
    await channel.setTyping?.(chatJid, true);
    try {
      await channel.sendMessage(chatJid, result.reply);
    } finally {
      await channel.setTyping?.(chatJid, false);
    }
    return true;
  }

  // Coarse-regex backstop: scrub credential-shaped strings from all messages
  // before passing them to the LLM. The backstop is independent of the
  // slash-command parser — if the parser already handled the message, we
  // never reach here.
  const backstopMessages = missedMessages.map((m) =>
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
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

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
      );
      if (agentStatus === 'error') status = 'error';
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

  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      hadError = true;
      logger.error(
        { err: r.reason, specialist: runs[i].specialistName },
        'specialist run failed',
      );
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
