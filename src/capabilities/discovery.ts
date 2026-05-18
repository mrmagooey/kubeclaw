import {
  getRedisClient,
  createStreamWatcherClient,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
} from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import {
  getCapabilityByName,
  getEntriesForChannel,
  listCapabilities,
  specToDiscoveryEntry,
} from './registry.js';
import type { CapabilityDiscoveryEntry } from './types.js';
import type { PerGroupK8sClient } from '../per-group-capabilities/k8s-client.js';
import { getScope } from '../per-group-capabilities/types.js';
import { scaleUpInstance } from '../per-group-capabilities/scale-up.js';

const RESPONSE_TTL_SECONDS = 30;

let watcherRunning = false;

export interface DiscoveryDeps {
  perGroupK8sClient: PerGroupK8sClient;
  namespace: string;
  discoveryTimeoutMs: number;
}

let deps: DiscoveryDeps | null = null;

export function setDiscoveryDeps(d: DiscoveryDeps): void {
  deps = d;
}

export function _resetDiscoveryDepsForTest(): void {
  deps = null;
}

interface DiscoveryRequest {
  requestId: string;
  capability?: string;
  channel?: string;
  group?: string;
}

async function resolveStreamTip(stream: string): Promise<string> {
  const client = getRedisClient();
  const entries = (await client.xrevrange(stream, '+', '-', 'COUNT', '1')) as [
    string,
    string[],
  ][];
  return entries.length > 0 ? entries[0][0] : '0-0';
}

function withState(
  entry: CapabilityDiscoveryEntry,
  patch: { state: 'ready' | 'warming' | 'failed'; error?: string },
): CapabilityDiscoveryEntry {
  return { ...entry, ...patch } as CapabilityDiscoveryEntry;
}

/**
 * Assert that entry is a cluster-scoped discovery entry (has an endpoint).
 * Group-scoped entries are created separately and never flow through specToDiscoveryEntry.
 */
function asClusterEntry(
  entry: CapabilityDiscoveryEntry,
): Exclude<CapabilityDiscoveryEntry, { kind: 'mcp-group' }> {
  if (entry.kind === 'mcp-group') {
    throw new Error(
      `Internal: mcp-group entry should not be created by specToDiscoveryEntry`,
    );
  }
  return entry;
}

async function handleRequest(req: DiscoveryRequest): Promise<void> {
  let result: CapabilityDiscoveryEntry[];

  if (req.capability) {
    const spec = getCapabilityByName(req.capability);
    if (!spec) {
      result = [];
    } else if (getScope(spec) === 'group') {
      // Group-scoped capability: scale up on demand and return the per-group endpoint.
      if (!req.group || !deps) {
        const baseEntry = specToDiscoveryEntry(spec);
        result = [
          withState(baseEntry, {
            state: 'failed',
            error: 'group context required for group-scoped capability',
          }),
        ];
      } else {
        const up = await scaleUpInstance({
          client: deps.perGroupK8sClient,
          namespace: deps.namespace,
          groupFolder: req.group,
          capabilityName: spec.name,
          timeoutMs: deps.discoveryTimeoutMs,
        });
        const baseEntry = asClusterEntry(specToDiscoveryEntry(spec));
        if (up.state === 'ready') {
          result = [{ ...baseEntry, endpoint: up.endpoint, state: 'ready' }];
        } else {
          result = [withState(baseEntry, { state: 'failed', error: up.error })];
        }
      }
    } else if (spec.channels?.length) {
      // Spec has an ACL. Allow only when the requester identifies as a permitted channel.
      result =
        req.channel && spec.channels.includes(req.channel)
          ? [specToDiscoveryEntry(spec)]
          : [];
    } else {
      // Unrestricted spec — anyone who knows the name can fetch it.
      result = [specToDiscoveryEntry(spec)];
    }
  } else if (req.channel) {
    result = getEntriesForChannel(req.channel);
  } else {
    // No filter — admin/orchestrator use; return everything.
    result = listCapabilities().map(specToDiscoveryEntry);
  }

  const client = getRedisClient();
  await client.set(
    getDiscoveryResponseKey(req.requestId),
    JSON.stringify(result),
    'EX',
    RESPONSE_TTL_SECONDS,
  );
  logger.debug(
    { requestId: req.requestId, count: result.length },
    'Discovery response written',
  );
}

export async function __handleRequestForTest(
  req: DiscoveryRequest,
): Promise<void> {
  await handleRequest(req);
}

async function watchRequests(): Promise<void> {
  // Each blocking-XREAD watcher needs its own dedicated connection.
  // Multiple watchers sharing one connection serialize behind each other's
  // BLOCK timeout; a fresh connection per watcher lets them run concurrently.
  const redis = createStreamWatcherClient();
  const stream = getDiscoveryRequestStream();
  let lastId = await resolveStreamTip(stream);

  logger.info('Capability discovery request watcher started');

  while (watcherRunning) {
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
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            obj[fields[i]] = fields[i + 1];
          if (!obj.requestId) {
            logger.warn({ fields: obj }, 'Discovery request missing requestId');
            continue;
          }
          // Note: on handler failure the response key is never written.
          // Callers detect this as a poll timeout. We don't write an error
          // sentinel because clients already treat absence as a transient
          // failure (retried via the outer ipc loop).
          try {
            await handleRequest({
              requestId: obj.requestId,
              capability: obj.capability,
              channel: obj.channel,
              group: obj.group,
            });
          } catch (err) {
            logger.error(
              { err, requestId: obj.requestId },
              'Discovery handler failed',
            );
          }
        }
      }
    } catch (err) {
      if (watcherRunning) {
        logger.error({ err }, 'Discovery watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

export function startDiscoveryWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  watchRequests().catch((err) =>
    logger.error({ err }, 'Discovery watcher crashed'),
  );
  logger.info('Capability discovery watcher started');
}

export function stopDiscoveryWatcher(): void {
  watcherRunning = false;
  logger.info('Capability discovery watcher stopped');
}
