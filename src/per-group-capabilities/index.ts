import type { PerGroupK8sClient } from './k8s-client.js';
import type { CapabilitySpec } from '../capabilities/types.js';
import { reconcileGroupCapabilities } from './reconciler.js';
import {
  sweepIdleInstances,
  type SweeperLoopHandle,
} from './scale-down-sweeper.js';
import { gcGroup } from './gc.js';
import { setDiscoveryDeps } from '../capabilities/discovery.js';
import { logger } from '../logger.js';
import {
  scrapeMissingSchemas,
  type CallToolsListFn,
} from './schema-scraper.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolSchema } from './schema-cache.js';

// Re-exports (used by tests and the orchestrator) -----------------------

export {
  reconcileGroupCapabilities,
  type ReconcileArgs,
} from './reconciler.js';
export {
  scaleUpInstance,
  type ScaleUpResult,
  type ScaleUpArgs,
} from './scale-up.js';
export {
  sweepIdleInstances,
  startSweeperLoop,
  type SweepArgs,
  type SweeperLoopHandle,
} from './scale-down-sweeper.js';
export { gcGroup, type GcArgs } from './gc.js';
export {
  setGroupCredential,
  unsetGroupCredential,
  type SetCredentialArgs,
  type UnsetCredentialArgs,
} from './credentials.js';
export {
  RealPerGroupK8sClient,
  FakePerGroupK8sClient,
  type PerGroupK8sClient,
} from './k8s-client.js';
export { groupHash } from './hash.js';
export {
  type CapabilityScope,
  type ResolvedGroupCapability,
  getScope,
  validateScopeFields,
  resolveGroupCapability,
  PerGroupCapabilityError,
} from './types.js';
export {
  scrapeMissingSchemas,
  startSchemaScraperLoop,
  type ScrapeArgs,
  type CallToolsListFn,
} from './schema-scraper.js';
export {
  cacheSchemas,
  getCachedSchemas,
  clearCachedSchemas,
  listAllCachedSchemas,
  type McpToolSchema,
} from './schema-cache.js';
export {
  provisionCapability,
  listGroupCapabilities,
  removeCapabilityInstance,
  type ProvisionDeps,
  type ProvisionResult,
  type CapabilityListEntry,
} from './provision.js';

// Lifecycle (orchestrator-only, module-level state) ---------------------

interface LifecycleDeps {
  client: PerGroupK8sClient;
  namespace: string;
  groupsPvcName: string;
  /** Callable returning current set of group folders (lets us avoid stale snapshots). */
  listGroupFolders: () => string[];
  /** Callable returning current capability specs (Helm + admin overrides merged). */
  listSpecs: () => CapabilitySpec[];
  /** Discovery cold-start timeout in ms (default 30000). */
  discoveryTimeoutMs?: number;
  /** Sweeper interval in ms (default 60000). */
  sweepIntervalMs?: number;
  /** Periodic full reconcile interval in ms (default 300000 = 5 minutes). */
  periodicReconcileMs?: number;
  /** Schema-scraper tick interval in ms (default 60000). */
  schemaScrapeIntervalMs?: number;
}

let deps: LifecycleDeps | null = null;
let sweeperHandle: SweeperLoopHandle | null = null;
let periodicHandle: NodeJS.Timeout | null = null;
let scraperHandle: { stop(): void } | null = null;

export interface LifecycleHandle {
  stop(): void;
}

export async function initPerGroupCapabilityLifecycle(
  d: LifecycleDeps,
): Promise<LifecycleHandle> {
  deps = d;
  const discoveryTimeoutMs = d.discoveryTimeoutMs ?? 30_000;
  const sweepIntervalMs = d.sweepIntervalMs ?? 60_000;
  const periodicReconcileMs = d.periodicReconcileMs ?? 5 * 60_000;

  // Wire discovery so the Redis-stream discovery handler can scale instances up.
  setDiscoveryDeps({
    perGroupK8sClient: d.client,
    namespace: d.namespace,
    discoveryTimeoutMs,
  });

  // Initial full reconcile.
  await reconcileGroupCapabilities({
    client: d.client,
    namespace: d.namespace,
    groupsPvcName: d.groupsPvcName,
    groups: d.listGroupFolders(),
    specs: d.listSpecs(),
  });

  // Background sweeper — re-reads specs on each tick so admin-shell-added
  // capabilities respond to threshold changes without an orchestrator restart.
  let sweeperStopped = false;
  const sweepTick = (): void => {
    if (sweeperStopped) return;
    void (async () => {
      try {
        await sweepIdleInstances({
          client: d.client,
          namespace: d.namespace,
          specs: d.listSpecs(),
        });
      } catch (err) {
        logger.warn({ err }, 'sweepIdleInstances threw');
      }
      if (!sweeperStopped) setTimeout(sweepTick, sweepIntervalMs);
    })();
  };
  setTimeout(sweepTick, sweepIntervalMs);
  sweeperHandle = {
    stop() {
      sweeperStopped = true;
    },
  };

  // Schema scraper — re-reads specs on each tick so admin-shell-added
  // capabilities pick up schemas without an orchestrator restart.
  const scrapeIntervalMs = d.schemaScrapeIntervalMs ?? 60_000;
  let scraperStopped = false;
  const scraperFailureState = { failures: new Map<string, number>() };
  const realCallToolsList: CallToolsListFn = async (endpointUrl) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(endpointUrl + '/mcp'),
    );
    const mcp = new McpClient(
      { name: 'kubeclaw-schema-scraper', version: '0.0.1' },
      { capabilities: {} },
    );
    await mcp.connect(transport);
    try {
      const res = await mcp.listTools();
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })) as McpToolSchema[];
    } finally {
      await transport.close();
    }
  };
  const scrapeTick = (): void => {
    if (scraperStopped) return;
    void (async () => {
      try {
        await scrapeMissingSchemas({
          client: d.client,
          namespace: d.namespace,
          specs: d.listSpecs(),
          callToolsList: realCallToolsList,
          failureState: scraperFailureState,
        });
      } catch (err) {
        logger.warn({ err }, 'scrapeMissingSchemas threw');
      }
      if (!scraperStopped) setTimeout(scrapeTick, scrapeIntervalMs);
    })();
  };
  setTimeout(scrapeTick, scrapeIntervalMs);
  scraperHandle = {
    stop() {
      scraperStopped = true;
    },
  };

  // 5-minute periodic safety reconcile.
  periodicHandle = setInterval(() => {
    void (async () => {
      try {
        await reconcileGroupCapabilities({
          client: d.client,
          namespace: d.namespace,
          groupsPvcName: d.groupsPvcName,
          groups: d.listGroupFolders(),
          specs: d.listSpecs(),
        });
      } catch (err) {
        logger.warn({ err }, 'per-group periodic reconcile failed');
      }
    })();
  }, periodicReconcileMs);

  logger.info(
    {
      groups: d.listGroupFolders().length,
      sweepIntervalMs,
      periodicReconcileMs,
    },
    'per_group_capability_lifecycle_started',
  );

  return {
    stop() {
      sweeperHandle?.stop();
      scraperHandle?.stop();
      if (periodicHandle) clearInterval(periodicHandle);
      sweeperHandle = null;
      scraperHandle = null;
      periodicHandle = null;
      deps = null;
    },
  };
}

/**
 * Narrow reconcile for a single group. No-op if lifecycle hasn't been initialised
 * (so safe to call from code paths that run before orchestrator startup completes).
 */
export async function onGroupAdded(groupFolder: string): Promise<void> {
  if (!deps) return;
  try {
    await reconcileGroupCapabilities({
      client: deps.client,
      namespace: deps.namespace,
      groupsPvcName: deps.groupsPvcName,
      groups: [groupFolder],
      specs: deps.listSpecs(),
    });
  } catch (err) {
    logger.warn({ err, groupFolder }, 'onGroupAdded reconcile failed');
  }
}

/**
 * GC cascade on group deletion. No-op if lifecycle hasn't been initialised.
 */
export async function onGroupRemoved(groupFolder: string): Promise<void> {
  if (!deps) return;
  try {
    await gcGroup({
      client: deps.client,
      namespace: deps.namespace,
      groupFolder,
    });
  } catch (err) {
    logger.warn({ err, groupFolder }, 'onGroupRemoved gc failed');
  }
}

/** Test-only reset. */
export function _resetLifecycleForTest(): void {
  if (sweeperHandle) sweeperHandle.stop();
  if (scraperHandle) scraperHandle.stop();
  if (periodicHandle) clearInterval(periodicHandle);
  sweeperHandle = null;
  scraperHandle = null;
  periodicHandle = null;
  deps = null;
}
