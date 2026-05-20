import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  KUBECLAW_MODE,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { loadChannelPlugins } from './channels/plugin-loader.js';
import {
  AvailableGroup,
  getToolJobRunner,
  getRunnerForGroup,
  shutdownAllRunners,
} from './runtime/index.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setDbQueryCallback,
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
  startToolJobSpawnWatcher,
  startTaskRequestWatcher,
  registerSecretDeps,
  registerCapabilityDeps,
} from './k8s/ipc-redis.js';
import { CatalogInformer } from './k8s/catalog.js';
import { SecretManager } from './k8s/secret-manager.js';
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node';
import { KUBECLAW_NAMESPACE } from './config.js';
import { getOutputChannel, getRedisClient } from './k8s/redis-client.js';
import { jobRunner } from './k8s/job-runner.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startHttpAdminServer } from './admin-shell.js';
import { Registry } from 'prom-client';
import { createOrchestratorMetrics } from './metrics/orchestrator.js';
import { createMetricsServer } from './metrics/registry.js';
import {
  installCapability,
  startCapabilitySubsystem,
  startDiscoveryWatcher,
  stopDiscoveryWatcher,
  startHealthProbes,
} from './capabilities/index.js';
import {
  SpecialistReconciler,
  loadBaselineFromDisk,
} from './specialists/reconciler.js';
import { setSpecialistResolutionCallback } from './specialists.js';
import {
  RealPerGroupK8sClient,
  initPerGroupCapabilityLifecycle,
  onGroupAdded,
} from './per-group-capabilities/index.js';
import {
  buildPerGroupCapabilitySpec,
  type PerGroupCapabilityHelmEntry,
} from './per-group-capabilities/builders/index.js';
import { listCapabilities } from './capabilities/registry.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

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
  void onGroupAdded(group.folder);
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

async function main(): Promise<void> {
  if (KUBECLAW_MODE === 'credential-broker') {
    const { startBroker } = await import('./credential-broker/index.js');
    await startBroker();
    // The broker keeps the process alive via its HTTP server.
    // No further orchestrator/channel setup runs in this mode.
    return;
  }

  startOrchestratorHealthServer();

  const metricsRegistry = new Registry();
  const orchMetrics = createOrchestratorMetrics(metricsRegistry);
  const metricsServer = createMetricsServer({
    registry: metricsRegistry,
    port: parseInt(process.env.METRICS_PORT ?? '9091', 10),
  });
  await metricsServer.listen();

  // Wire metrics into the job runner singleton
  jobRunner.metrics = orchMetrics;

  // Wire specialist resolution recording
  setSpecialistResolutionCallback((specialistName) => {
    orchMetrics.recordSpecialistResolution({ specialist: specialistName });
  });

  // Wire db query timing recording
  setDbQueryCallback((operation, durationMs) => {
    orchMetrics.recordDbQuery({ operation, durationMs });
  });

  // Sample group queue depth every 5 s and publish to Prometheus.
  // Choice: periodic setInterval rather than hooking enqueue/dequeue paths
  // because the gauge is a sampled snapshot metric and polling keeps specialists.ts
  // and group-queue.ts free of metrics imports.
  const queueDepthInterval = setInterval(() => {
    for (const jid of Object.keys(registeredGroups)) {
      const group = registeredGroups[jid];
      if (!group) continue;
      const depth = queue.queueDepth(jid);
      orchMetrics.setGroupQueueDepth({ group: group.folder }, depth);
    }
  }, 5000);
  queueDepthInterval.unref(); // don't keep the process alive

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

  // Catalog informer + SecretManager — initialised before IPC handlers start
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(CoreV1Api);

  const catalogInformer = new CatalogInformer({
    namespace: KUBECLAW_NAMESPACE,
    configMapName: 'kubeclaw-credential-broker-config',
    readConfigMap: async (ns, name) => {
      const res = await coreApi.readNamespacedConfigMap({
        name,
        namespace: ns,
      });
      return { data: res.data as Record<string, string> | undefined };
    },
  });
  const stopCatalog = catalogInformer.start(30_000);

  const secretClient = {
    readSecret: async (name: string) => {
      const res = await coreApi.readNamespacedSecret({
        name,
        namespace: KUBECLAW_NAMESPACE,
      });
      return {
        data: res.data as Record<string, string> | undefined,
        metadata: res.metadata,
      };
    },
    createSecret: async (body: unknown) => {
      await coreApi.createNamespacedSecret({
        namespace: KUBECLAW_NAMESPACE,
        body: body as any,
      });
    },
    patchSecret: async (name: string, patch: unknown) => {
      await coreApi.patchNamespacedSecret({
        name,
        namespace: KUBECLAW_NAMESPACE,
        body: patch as any,
      });
    },
    deleteSecret: async (name: string) => {
      await coreApi.deleteNamespacedSecret({
        name,
        namespace: KUBECLAW_NAMESPACE,
      });
    },
  };

  const secretManager = new SecretManager({
    namespace: KUBECLAW_NAMESPACE,
    catalog: catalogInformer,
    k8s: secretClient,
  });

  registerSecretDeps(secretManager, catalogInformer);
  logger.info('CatalogInformer and SecretManager initialised');

  // ── Specialist catalog reconcile ──────────────────────────────────────────
  // On orchestrator startup, merge the Helm baseline with any SQLite overrides
  // and write the result to the kubeclaw-specialists ConfigMap so channel pods
  // can mount and hot-reload it.
  if (KUBECLAW_MODE === 'orchestrator') {
    const specialistReconciler = new SpecialistReconciler({
      baselineLoader: loadBaselineFromDisk,
      configMapApply: async (rendered: string) => {
        const data: Record<string, string> = { 'specialists.json': rendered };
        const body = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'kubeclaw-specialists',
            namespace: KUBECLAW_NAMESPACE,
          },
          data,
        };
        // Try patch first; fall back to create if not found.
        try {
          await coreApi.patchNamespacedConfigMap({
            name: 'kubeclaw-specialists',
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            await coreApi.createNamespacedConfigMap({
              namespace: KUBECLAW_NAMESPACE,
              body,
            });
          } else {
            throw err;
          }
        }
      },
    });
    try {
      await specialistReconciler.apply();
      logger.info('Specialists ConfigMap reconciled');
    } catch (err) {
      logger.warn(
        { err },
        'Specialist reconcile failed; channel pods will use stale or empty catalog',
      );
    }
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopCatalog();
    clearInterval(queueDepthInterval);
    stopDiscoveryWatcher();
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
    ) => getToolJobRunner().writeGroupsSnapshot(gf, im, ag, rj),
    metrics: orchMetrics,
  };
  startRedisIpcWatcher(ipcDeps);
  startToolPodSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Tool pod spawn watcher crashed'),
  );
  startToolJobSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Tool job spawn watcher crashed'),
  );
  startTaskRequestWatcher({ registerGroup }).catch((err) =>
    logger.error({ err }, 'Task request watcher crashed'),
  );
  // Start the unified capabilities subsystem.
  startDiscoveryWatcher();
  startHealthProbes();
  await startCapabilitySubsystem();

  // One-shot ingest of values.yaml-supplied specs (env: CAPABILITIES_VALUES, JSON array).
  // Backwards compat: also accept MCP_SERVERS_VALUES (kind injected as 'mcp').
  const capValuesJson = process.env.CAPABILITIES_VALUES;
  if (capValuesJson) {
    let specs: Array<Parameters<typeof installCapability>[0]>;
    try {
      specs = JSON.parse(capValuesJson);
    } catch (err) {
      logger.fatal(
        { err },
        'CAPABILITIES_VALUES is not valid JSON; refusing to start',
      );
      process.exit(1);
    }
    for (const spec of specs) {
      try {
        await installCapability(spec);
      } catch (err) {
        logger.error(
          { err, spec },
          'Failed to install capability from CAPABILITIES_VALUES',
        );
        // continue installing the remaining specs
      }
    }
    logger.info(
      { count: specs.length },
      'Synced capabilities from values.yaml',
    );
  }

  const mcpValuesJson = process.env.MCP_SERVERS_VALUES;
  if (mcpValuesJson) {
    let mcpSpecs: Array<Omit<Parameters<typeof installCapability>[0], 'kind'>>;
    try {
      const parsed = JSON.parse(mcpValuesJson);
      // The helm chart renders `mcpServers:` (a map keyed by name) via toJson,
      // so the env var arrives as an object: { name: { image, port, ... } }.
      // Accept both that map form and the array form for back-compat.
      mcpSpecs = Array.isArray(parsed)
        ? parsed
        : Object.entries(parsed as Record<string, Record<string, unknown>>).map(
            ([name, spec]) => ({ name, ...spec }) as (typeof mcpSpecs)[number],
          );
    } catch (err) {
      logger.fatal(
        { err },
        'MCP_SERVERS_VALUES is not valid JSON; refusing to start',
      );
      process.exit(1);
    }
    for (const m of mcpSpecs) {
      try {
        await installCapability({ ...m, kind: 'mcp' });
      } catch (err) {
        logger.error(
          { err, spec: m },
          'Failed to install MCP server from MCP_SERVERS_VALUES',
        );
      }
    }
    logger.warn(
      { count: mcpSpecs.length },
      'Synced legacy MCP_SERVERS_VALUES (deprecated, use CAPABILITIES_VALUES)',
    );
  }

  // One-shot ingest of values.yaml-supplied per-group capability type declarations
  // (env: PER_GROUP_CAPABILITIES_VALUES, JSON array).
  // Each entry has { type, image, scaleDownAfterIdleSeconds? }; the type field
  // selects a registered builder (e.g. "echo"). Unknown types cause a fatal error
  // at boot so the operator gets immediate feedback rather than a silent no-op.
  const perGroupCapValuesJson = process.env.PER_GROUP_CAPABILITIES_VALUES;
  if (perGroupCapValuesJson) {
    let perGroupEntries: PerGroupCapabilityHelmEntry[];
    try {
      perGroupEntries = JSON.parse(perGroupCapValuesJson);
    } catch (err) {
      logger.fatal(
        { err },
        'PER_GROUP_CAPABILITIES_VALUES is not valid JSON; refusing to start',
      );
      process.exit(1);
    }
    for (const entry of perGroupEntries) {
      let spec;
      try {
        spec = buildPerGroupCapabilitySpec(entry);
      } catch (err) {
        logger.fatal(
          { err, entry },
          'Unknown per-group capability type in PER_GROUP_CAPABILITIES_VALUES; refusing to start',
        );
        process.exit(1);
      }
      try {
        await installCapability(spec);
      } catch (err) {
        logger.error(
          { err, entry },
          'Failed to install per-group capability from PER_GROUP_CAPABILITIES_VALUES',
        );
        // continue installing remaining entries
      }
    }
    logger.info(
      { count: perGroupEntries.length },
      'Synced per-group capabilities from values.yaml',
    );
  }

  // Per-group MCP capability lifecycle: startup reconcile + sweeper + periodic safety pass.
  const perGroupK8s = new RealPerGroupK8sClient();
  const groupsPvcName =
    process.env.KUBECLAW_GROUPS_PVC ?? 'kubeclaw-groups-pvc';
  await initPerGroupCapabilityLifecycle({
    client: perGroupK8s,
    namespace: KUBECLAW_NAMESPACE,
    groupsPvcName,
    listGroupFolders: () =>
      Object.values(getAllRegisteredGroups()).map((g) => g.folder),
    listSpecs: () => listCapabilities(),
  });

  // Wire up capability provisioning IPC handlers (capability.add / .list / .remove).
  registerCapabilityDeps({
    client: perGroupK8s,
    namespace: KUBECLAW_NAMESPACE,
    groupsPvcName,
    listSpecs: () => listCapabilities(),
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start KubeClaw');
    process.exit(1);
  });
}
