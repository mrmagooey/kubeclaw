import {
  getRedisClient,
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

const RESPONSE_TTL_SECONDS = 30;

let watcherRunning = false;

interface DiscoveryRequest {
  requestId: string;
  capability?: string;
  channel?: string;
}

async function resolveStreamTip(stream: string): Promise<string> {
  const client = getRedisClient();
  const entries = (await client.xrevrange(stream, '+', '-', 'COUNT', '1')) as [
    string,
    string[],
  ][];
  return entries.length > 0 ? entries[0][0] : '0-0';
}

async function handleRequest(req: DiscoveryRequest): Promise<void> {
  let result: CapabilityDiscoveryEntry[];

  if (req.capability) {
    const spec = getCapabilityByName(req.capability);
    if (!spec) {
      result = [];
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
  const redis = getRedisClient();
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
