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
  getDirectLLMRunner,
  shutdownAllRunners,
} from './runtime/index.js';
import { installProxyDispatcher } from './runtime/proxy-dispatcher.js';
import {
  recordBootstrapTerminal,
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
  registerBootstrapDeps,
  startBootstrapTaskWatcher,
} from './k8s/ipc-redis.js';
import { CatalogInformer } from './k8s/catalog.js';
import { startAclCleanupSweep } from './k8s/acl-manager.js';
import { SecretManager } from './k8s/secret-manager.js';
import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  BatchV1Api,
  NetworkingV1Api,
  Exec,
} from '@kubernetes/client-node';
import { readBootstrapPvcFiles } from './k8s/read-bootstrap-pvc-files.js';
import { writeBootstrapPvcFiles } from './k8s/write-bootstrap-pvc-files.js';
import { loadChannelSource } from './channel-src/loader.js';
import {
  activeBootstraps,
  startBootstrapHistoryGcInterval,
  reconcileChannelManifestsOnStartup,
} from './admin-shell.js';
import {
  getBootstrapMeta,
  deregisterBootstrapMeta,
  reconcileOrphanedBootstrapsOnStartup,
} from './k8s/bootstrap-runner.js';
import {
  patchRuntimePvc,
  waitForDeploymentRollout,
} from './skills/orchestrator/channel-setup.js';
import { KUBECLAW_NAMESPACE } from './config.js';
import { getOutputChannel, getRedisClient } from './k8s/redis-client.js';
import { jobRunner } from './k8s/job-runner.js';
import { reconcileOrphanedJobsOnStartup } from './k8s/orphan-jobs.js';
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
import {
  ToolReconciler,
  loadBaselineFromDisk as loadToolBaselineFromDisk,
  mergeCatalog,
} from './tools/reconciler.js';
import { listToolOverrides } from './skills/orchestrator/tool-registry.js';
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
  installProxyDispatcher();
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
  const batchApi = kc.makeApiClient(BatchV1Api);

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

  // ── Bootstrap channel IPC deps (Story 174) ───────────────────────────────
  const appsApi = kc.makeApiClient(AppsV1Api);
  const networkingApi = kc.makeApiClient(NetworkingV1Api);
  const channelBaseImage =
    process.env.KUBECLAW_BOOTSTRAP_AGENT_IMAGE || 'kubeclaw-agent:latest';
  const redisForBootstrap = getRedisClient();

  registerBootstrapDeps(
    {
      createSecret: async (name: string, data: Record<string, string>) => {
        // Base64-encode all values for the K8s Secret
        const b64 = Object.fromEntries(
          Object.entries(data).map(([k, v]) => [
            k,
            Buffer.from(v).toString('base64'),
          ]),
        );
        try {
          await coreApi.createNamespacedSecret({
            namespace: KUBECLAW_NAMESPACE,
            body: {
              apiVersion: 'v1',
              kind: 'Secret',
              metadata: { name, namespace: KUBECLAW_NAMESPACE },
              data: b64,
            },
          });
        } catch (err: any) {
          if (err?.code === 409 || err?.statusCode === 409 || err?.body?.code === 409) {
            // Already exists — patch it
            await coreApi.patchNamespacedSecret({
              name,
              namespace: KUBECLAW_NAMESPACE,
              body: { data: b64 },
            });
          } else {
            throw err;
          }
        }
      },
      createDeployment: async (body) => {
        try {
          await appsApi.createNamespacedDeployment({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } catch (err: any) {
          if (err?.code === 409 || err?.statusCode === 409 || err?.body?.code === 409) {
            await appsApi.replaceNamespacedDeployment({
              name: body.metadata!.name!,
              namespace: KUBECLAW_NAMESPACE,
              body,
            });
          } else {
            throw err;
          }
        }
      },
      publishReply: async (replyChannel, payload) => {
        await redisForBootstrap.publish(replyChannel, JSON.stringify(payload));
      },
      publishSse: async (topic, text) => {
        await redisForBootstrap.publish(topic, text);
      },
      getManifestHash: async (channelType: string) => {
        try {
          const cm = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-channel-manifests',
            namespace: KUBECLAW_NAMESPACE,
          });
          const raw = cm.data?.[`${channelType}.json`];
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { manifestHash?: string };
          return parsed.manifestHash ?? null;
        } catch {
          return null;
        }
      },
      releaseBootstrap: (instanceName: string) => {
        activeBootstraps.delete(instanceName);
      },
      // Story 176: independently read package.json + package-lock.json from the
      // runtime PVC by exec-ing into the inspector sidecar (TOCTOU defense).
      readPvcFiles: async (instanceName: string) =>
        readBootstrapPvcFiles(
          { coreApi, exec: new Exec(kc), namespace: KUBECLAW_NAMESPACE },
          instanceName,
        ),
      // Task 3: push channel source files onto the bootstrap pod's /runtime
      // (RW mount) before the steady-state Deployment is created.
      writeChannelSource: async (instanceName: string, channelType: string) =>
        writeBootstrapPvcFiles(
          { coreApi, exec: new Exec(kc), namespace: KUBECLAW_NAMESPACE },
          instanceName,
          loadChannelSource(channelType),
        ),
      // Task 5: read the channel manifest's hostMode from the ConfigMap.
      getChannelHostMode: async (channelType: string) => {
        try {
          const cm = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-channel-manifests',
            namespace: KUBECLAW_NAMESPACE,
          });
          const raw = cm.data?.[`${channelType}.json`];
          if (!raw) return 'standalone';
          const hm = (JSON.parse(raw) as { hostMode?: string }).hostMode;
          return hm === 'channel-runner' ? 'channel-runner' : 'standalone';
        } catch {
          return 'standalone';
        }
      },
      // channel-runner.js lives in the orchestrator image (WORKDIR /app), not the
      // agent/bootstrap image. Read the orchestrator's own Deployment image so
      // channel-runner-mode pods run the right binary.
      getChannelRunnerImage: async () => {
        try {
          const dep = await appsApi.readNamespacedDeployment({
            name: 'kubeclaw-orchestrator',
            namespace: KUBECLAW_NAMESPACE,
          });
          const c =
            dep.spec?.template?.spec?.containers?.find(
              (x) => x.name === 'orchestrator',
            ) ?? dep.spec?.template?.spec?.containers?.[0];
          return c?.image ?? 'kubeclaw-orchestrator:latest';
        } catch {
          return 'kubeclaw-orchestrator:latest';
        }
      },
      // Task 5: create a PVC (idempotent; AlreadyExists → ignore).
      createPvc: async (name: string, sizeGi: number) => {
        try {
          await coreApi.createNamespacedPersistentVolumeClaim({
            namespace: KUBECLAW_NAMESPACE,
            body: {
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              metadata: { name, labels: { 'kubeclaw/channel-pvc': 'true' } },
              spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${sizeGi}Gi` } } },
            },
          });
        } catch (err: any) {
          if (err?.code === 409 || err?.statusCode === 409 || err?.body?.code === 409) return;
          throw err;
        }
      },
      deleteJob: async (name: string) => {
        try {
          await batchApi.deleteNamespacedJob({
            name,
            namespace: KUBECLAW_NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: any) {
          if (err?.code === 404 || err?.statusCode === 404 || err?.body?.code === 404) return;
          throw err;
        }
      },
      deletePvc: async (name: string) => {
        try {
          await coreApi.deleteNamespacedPersistentVolumeClaim({
            name,
            namespace: KUBECLAW_NAMESPACE,
            gracePeriodSeconds: 0,
          });
        } catch (err: any) {
          if (err?.code === 404 || err?.statusCode === 404 || err?.body?.code === 404) return;
          throw err;
        }
      },
      recordMismatch: ({ channel_type }: { channel_type: string }) => {
        orchMetrics.recordBootstrapManifestMismatch({ channel_type });
      },
      // Story 180: record terminal outcome in bootstrap_history and free meta
      recordTerminal: (args: {
        instanceName: string;
        bootstrapJobId: string;
        outcome:
          | 'succeeded'
          | 'timed-out'
          | 'manifest-divergence'
          | 'rejected'
          | 'error';
        errorCode?: string;
        errorMessage?: string;
      }) => {
        const meta = getBootstrapMeta(args.instanceName);
        recordBootstrapTerminal({
          bootstrapJobId: args.bootstrapJobId,
          channelType: meta?.channelType ?? 'unknown',
          instanceName: args.instanceName,
          skillName: meta?.skillName ?? 'unknown',
          startedAt: meta?.startedAt ?? new Date().toISOString(),
          outcome: args.outcome,
          errorCode: args.errorCode,
          errorMessage: args.errorMessage,
        });
        deregisterBootstrapMeta(args.instanceName);
      },
      // Story 181: upgrade-path deps — patch Deployment PVC, wait for rollout,
      // schedule old PVC deletion after grace period.
      patchDeployment: async (instanceName: string, newPvcName: string) => {
        await patchRuntimePvc(instanceName, newPvcName, {
          appsV1: appsApi,
          namespace: KUBECLAW_NAMESPACE,
        });
      },
      waitForRollout: async (deploymentName: string) => {
        await waitForDeploymentRollout(deploymentName, {
          appsV1: appsApi,
          namespace: KUBECLAW_NAMESPACE,
        });
      },
      scheduleOldPvcDeletion: (oldPvcName: string) => {
        const graceSec = parseInt(
          process.env.UPGRADE_OLD_PVC_GRACE_SECONDS || '300',
          10,
        );
        setTimeout(async () => {
          try {
            await coreApi.deleteNamespacedPersistentVolumeClaim({
              name: oldPvcName,
              namespace: KUBECLAW_NAMESPACE,
              gracePeriodSeconds: 0,
            });
            logger.info(
              { oldPvcName },
              'Upgrade grace period: old PVC deleted',
            );
          } catch (err) {
            logger.warn(
              { oldPvcName, err },
              'Upgrade grace period: failed to delete old PVC',
            );
          }
        }, graceSec * 1000);
        logger.info({ oldPvcName, graceSec }, 'Old PVC deletion scheduled');
      },
      // Task 2: read the channel manifest's httpPort from the ConfigMap.
      // Returns the numeric port, or null if absent/unknown/error.
      getChannelHttpPort: async (channelType: string) => {
        try {
          const cm = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-channel-manifests',
            namespace: KUBECLAW_NAMESPACE,
          });
          const raw = cm.data?.[`${channelType}.json`];
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { httpPort?: number };
          return typeof parsed.httpPort === 'number' ? parsed.httpPort : null;
        } catch {
          return null;
        }
      },
      // Sidecar aux-backend: read the sidecar spec for a channel type from the
      // ConfigMap. Returns undefined when absent, unknown, or on error.
      getChannelSidecar: async (channelType: string) => {
        try {
          const cm = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-channel-manifests',
            namespace: KUBECLAW_NAMESPACE,
          });
          const raw = cm.data?.[`${channelType}.json`];
          if (!raw) return undefined;
          const parsed = JSON.parse(raw) as { sidecar?: import('./skills/orchestrator/channel-manifest-registry.js').SidecarSpec };
          return parsed.sidecar ?? undefined;
        } catch {
          return undefined;
        }
      },
      // Task 2: idempotent create-or-replace a K8s Service.
      createService: async (body: import('@kubernetes/client-node').V1Service) => {
        const name = body.metadata!.name!;
        try {
          await coreApi.createNamespacedService({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } catch (err: any) {
          if (err?.code === 409 || err?.statusCode === 409 || err?.body?.code === 409) {
            // Already exists — read resourceVersion, then replace
            const existing = await coreApi.readNamespacedService({
              name,
              namespace: KUBECLAW_NAMESPACE,
            });
            const resourceVersion = existing.metadata?.resourceVersion;
            try {
              await coreApi.replaceNamespacedService({
                name,
                namespace: KUBECLAW_NAMESPACE,
                body: {
                  ...body,
                  metadata: { ...body.metadata, resourceVersion },
                },
              });
            } catch (replaceErr: any) {
              if (replaceErr?.code === 404 || replaceErr?.statusCode === 404 || replaceErr?.body?.code === 404) {
                // Rare race: disappeared between read and replace — create again
                await coreApi.createNamespacedService({
                  namespace: KUBECLAW_NAMESPACE,
                  body,
                });
              } else {
                throw replaceErr;
              }
            }
          } else {
            throw err;
          }
        }
      },
      // Task 2: idempotent create-or-replace a K8s NetworkPolicy.
      createNetworkPolicy: async (body: import('@kubernetes/client-node').V1NetworkPolicy) => {
        const name = body.metadata!.name!;
        try {
          await networkingApi.createNamespacedNetworkPolicy({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } catch (err: any) {
          if (err?.code === 409 || err?.statusCode === 409 || err?.body?.code === 409) {
            // Already exists — read resourceVersion, then replace
            const existing = await networkingApi.readNamespacedNetworkPolicy({
              name,
              namespace: KUBECLAW_NAMESPACE,
            });
            const resourceVersion = existing.metadata?.resourceVersion;
            try {
              await networkingApi.replaceNamespacedNetworkPolicy({
                name,
                namespace: KUBECLAW_NAMESPACE,
                body: {
                  ...body,
                  metadata: { ...body.metadata, resourceVersion },
                },
              });
            } catch (replaceErr: any) {
              if (replaceErr?.code === 404 || replaceErr?.statusCode === 404 || replaceErr?.body?.code === 404) {
                // Rare race: disappeared between read and replace — create again
                await networkingApi.createNamespacedNetworkPolicy({
                  namespace: KUBECLAW_NAMESPACE,
                  body,
                });
              } else {
                throw replaceErr;
              }
            }
          } else {
            throw err;
          }
        }
      },
    },
    channelBaseImage,
    KUBECLAW_NAMESPACE,
  );

  // ── Specialist catalog reconcile ──────────────────────────────────────────
  // On orchestrator startup, merge the Helm baseline with any SQLite overrides
  // and write the result to the kubeclaw-specialists ConfigMap so channel pods
  // can mount and hot-reload it.
  if (KUBECLAW_MODE === 'orchestrator') {
    const specialistReconciler = new SpecialistReconciler({
      baselineLoader: loadBaselineFromDisk,
      configMapApply: async (rendered: string) => {
        const data: Record<string, string> = { 'specialists.json': rendered };
        // GET the existing ConfigMap to obtain its resourceVersion (needed for PUT).
        // Fall back to CREATE if the ConfigMap does not exist yet.
        // Note: patchNamespacedConfigMap sends application/json-patch+json which
        // expects an array of patch ops, not a full object — so we use GET+replace
        // (PUT) or create instead.
        let resourceVersion: string | undefined;
        try {
          const existing = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-specialists',
            namespace: KUBECLAW_NAMESPACE,
          });
          resourceVersion = existing.metadata?.resourceVersion;
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status !== 404) throw err;
        }

        const body = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'kubeclaw-specialists',
            namespace: KUBECLAW_NAMESPACE,
            ...(resourceVersion ? { resourceVersion } : {}),
          },
          data,
        };
        if (resourceVersion !== undefined) {
          // ConfigMap exists — replace it (PUT). No patch content-type ambiguity.
          await coreApi.replaceNamespacedConfigMap({
            name: 'kubeclaw-specialists',
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } else {
          // ConfigMap does not exist — create it.
          await coreApi.createNamespacedConfigMap({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
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

    // ── Tool catalog reconcile ────────────────────────────────────────────────
    const toolReconciler = new ToolReconciler({
      baselineLoader: loadToolBaselineFromDisk,
      configMapApply: async (rendered: string) => {
        const data: Record<string, string> = { 'tools.json': rendered };
        let resourceVersion: string | undefined;
        try {
          const existing = await coreApi.readNamespacedConfigMap({
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
          });
          resourceVersion = existing.metadata?.resourceVersion;
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status !== 404) throw err;
        }
        const body = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
            ...(resourceVersion ? { resourceVersion } : {}),
          },
          data,
        };
        if (resourceVersion !== undefined) {
          await coreApi.replaceNamespacedConfigMap({
            name: 'kubeclaw-tools',
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        } else {
          await coreApi.createNamespacedConfigMap({
            namespace: KUBECLAW_NAMESPACE,
            body,
          });
        }
      },
    });
    try {
      await toolReconciler.apply();
      logger.info('Tools ConfigMap reconciled');
    } catch (err) {
      logger.warn(
        { err },
        'Tool reconcile failed; channel pods will use stale or empty catalog',
      );
    }

    // Inject the in-process merged catalog into the orchestrator's DirectLLMRunner
    // so direct-mode scheduled tasks see catalog tools in their LLM tool list
    // (seam-1), matching the orchestrator's name-resolution at spawn (seam-2).
    getDirectLLMRunner().setToolCatalog({
      getForChannel: (channel: string) =>
        mergeCatalog(loadToolBaselineFromDisk(), listToolOverrides()).filter(
          (t) => !t.channels?.length || t.channels.includes(channel),
        ),
    });

    // ── Channel-manifest catalog reconcile ────────────────────────────────────
    // Helm renders kubeclaw-channel-manifests empty; bootstrap Jobs mount it to
    // read each channel type's package.json. Populate it from the Helm baseline +
    // SQLite overrides so bootstrap Jobs find their manifest instead of stalling.
    try {
      await reconcileChannelManifestsOnStartup();
      logger.info('Channel-manifests ConfigMap reconciled');
    } catch (err) {
      logger.warn(
        { err },
        'Channel-manifests reconcile failed; bootstrap Jobs will use stale or empty catalog',
      );
    }
  }

  // ── Orphaned tool-job reconciliation (Story 37) ───────────────────────────
  // Detect any tool jobs that were still `active` in the DB when the previous
  // orchestrator incarnation terminated. For each orphan: publish a user-
  // visible interruption notice via Redis, delete the K8s Job, and mark the
  // DB row as `interrupted`. Bounded to 30 s so a hung K8s API does not
  // block the rest of the boot sequence.
  // Failure 3 fix: await (not void) so IPC watcher starts AFTER reconciliation.
  await reconcileOrphanedJobsOnStartup({
    k8s: {
      deleteJob: async (jobName: string) => {
        await jobRunner.stopJob(jobName);
      },
    },
    publisher: {
      // Failure 1 fix: include `persist: true` and `noticeId` in the Redis
      // payload so the channel pod stores the notice in the messages table
      // (AC4: is_from_me=1, is_bot_message=1).
      publish: async (
        groupFolder: string,
        chatJid: string,
        text: string,
        noticeId: string,
      ) => {
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
    },
    timeoutMs: 30_000,
  }).catch((err) => {
    logger.warn({ err }, 'Orphan tool-job reconciliation failed');
  });

  // ── Orphaned bootstrap reconciliation (Story 175) ─────────────────────────
  // Detect bootstrap Jobs that expired (DeadlineExceeded) while the orchestrator
  // was down. For each orphan: delete the Job, PVC, and any partial Secret, then
  // publish a timeout SSE notice so admin clients learn the bootstrap was rolled
  // back. Bounded to 30 s. Idempotent — NotFound errors are swallowed.
  await reconcileOrphanedBootstrapsOnStartup({
    listFailedBootstrapJobs: async () => {
      try {
        const jobs = await batchApi.listNamespacedJob({
          namespace: KUBECLAW_NAMESPACE,
          labelSelector: 'kubeclaw.io/role=bootstrap',
        });
        const failed: import('./k8s/bootstrap-runner.js').FailedBootstrapJob[] =
          [];
        for (const job of jobs.items ?? []) {
          const conditions = job.status?.conditions ?? [];
          const failedCond = conditions.find(
            (c: { type: string; status: string }) =>
              c.type === 'Failed' && c.status === 'True',
          );
          if (!failedCond) continue;
          const instanceName = job.metadata?.labels?.['kubeclaw-channel'] ?? '';
          const bootstrapJobId =
            job.metadata?.labels?.['kubeclaw.io/bootstrap-job-id'] ?? '';
          const jobName = job.metadata?.name ?? '';
          if (!instanceName || !bootstrapJobId || !jobName) continue;
          failed.push({
            jobName,
            instanceName,
            bootstrapJobId,
            failureReason: failedCond.reason ?? 'Unknown',
          });
        }
        return failed;
      } catch (err) {
        logger.warn({ err }, 'listFailedBootstrapJobs: K8s query failed');
        return [];
      }
    },
    cleanup: {
      deleteJob: async (name: string) => {
        try {
          await batchApi.deleteNamespacedJob({
            name,
            namespace: KUBECLAW_NAMESPACE,
            gracePeriodSeconds: 0,
          });
          logger.debug({ name }, 'reconcileBootstraps: Job deleted');
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug({ name }, 'reconcileBootstraps: Job already absent');
            return;
          }
          throw err;
        }
      },
      deletePvc: async (name: string) => {
        try {
          await coreApi.deleteNamespacedPersistentVolumeClaim({
            name,
            namespace: KUBECLAW_NAMESPACE,
            gracePeriodSeconds: 0,
          });
          logger.debug({ name }, 'reconcileBootstraps: PVC deleted');
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug({ name }, 'reconcileBootstraps: PVC already absent');
            return;
          }
          throw err;
        }
      },
      deleteSecret: async (name: string) => {
        try {
          await coreApi.deleteNamespacedSecret({
            name,
            namespace: KUBECLAW_NAMESPACE,
          });
          logger.debug({ name }, 'reconcileBootstraps: Secret deleted');
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } })
            ?.response?.statusCode;
          if (status === 404) {
            logger.debug(
              { name },
              'reconcileBootstraps: Secret already absent',
            );
            return;
          }
          throw err;
        }
      },
      publishSse: async (topic, payload) => {
        try {
          await getRedisClient().publish(topic, JSON.stringify(payload));
        } catch (err) {
          logger.warn(
            { topic, err },
            'reconcileBootstraps: failed to publish SSE',
          );
        }
      },
      activeBootstraps,
    },
    timeoutMs: 30_000,
  }).catch((err) => {
    logger.warn({ err }, 'Orphan bootstrap reconciliation failed');
  });

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
  startAclCleanupSweep();
  startToolPodSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Tool pod spawn watcher crashed'),
  );
  startToolJobSpawnWatcher().catch((err) =>
    logger.error({ err }, 'Tool job spawn watcher crashed'),
  );
  startTaskRequestWatcher({ registerGroup }).catch((err) =>
    logger.error({ err }, 'Task request watcher crashed'),
  );
  startBootstrapTaskWatcher();
  startBootstrapHistoryGcInterval(); // Story 180: GC for bootstrap_history
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
