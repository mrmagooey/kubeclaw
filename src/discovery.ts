/**
 * Capability discovery service.
 *
 * Capability pods register themselves with the orchestrator on startup.
 * The orchestrator stores registrations in a Redis hash. Channel pods
 * query this hash to discover capabilities and communicate with them
 * directly after orchestrator-mediated discovery.
 *
 * Registration: capability pods write to the kubeclaw:capability:register
 * stream. The orchestrator watches this stream, validates the payload,
 * stores the registration in the kubeclaw:capabilities hash, and sets a
 * per-capability heartbeat key with a TTL.
 *
 * Discovery: channel pods write to the kubeclaw:discovery:request stream.
 * The orchestrator reads the request, resolves matching capabilities, and
 * writes the response to a short-lived key the channel is polling.
 *
 * Health: each capability has a heartbeat key with a TTL. Capabilities
 * must re-register (heartbeat) before the TTL expires. A periodic sweep
 * removes stale entries from the capabilities hash.
 */

import { getRedisClient } from './k8s/redis-client.js';
import {
  getCapabilityRegisterStream,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
} from './k8s/redis-client.js';
import { logger } from './logger.js';

const CAPABILITIES_KEY = 'kubeclaw:capabilities';
const HEARTBEAT_PREFIX = 'kubeclaw:capability:heartbeat:';

/** TTL for capability heartbeat keys, in seconds. */
const HEARTBEAT_TTL_SECONDS = 90;

/** Interval for the stale-entry sweep, in milliseconds. */
const SWEEP_INTERVAL_MS = 30_000;

/** TTL for discovery response keys, in seconds. */
const DISCOVERY_RESPONSE_TTL_SECONDS = 30;

export interface CapabilityRegistration {
  /** Capability name, e.g. "qdrant", "whisper", "browser" */
  name: string;
  /** HTTP endpoint for direct channel->capability communication */
  endpoint: string;
  /** List of capability identifiers, e.g. ["rag-query", "rag-index"] */
  capabilities: string[];
  /** Restrict access to specific channels (empty = all channels) */
  channels?: string[];
  /** Timestamp of registration */
  registeredAt: string;
}

// ── Registry CRUD (used internally by the watcher) ─────────────────────────

/**
 * Register a capability in the discovery registry.
 * Called by the orchestrator when a capability pod starts.
 */
export async function registerCapability(
  reg: CapabilityRegistration,
): Promise<void> {
  const client = getRedisClient();
  await client.hset(CAPABILITIES_KEY, reg.name, JSON.stringify(reg));
  await client.set(
    `${HEARTBEAT_PREFIX}${reg.name}`,
    '1',
    'EX',
    HEARTBEAT_TTL_SECONDS,
  );
  logger.info({ name: reg.name, endpoint: reg.endpoint }, 'Capability registered');
}

/**
 * Remove a capability from the registry.
 */
export async function deregisterCapability(name: string): Promise<void> {
  const client = getRedisClient();
  await client.hdel(CAPABILITIES_KEY, name);
  await client.del(`${HEARTBEAT_PREFIX}${name}`);
  logger.info({ name }, 'Capability deregistered');
}

/**
 * Get all registered capabilities.
 */
export async function getCapabilities(): Promise<CapabilityRegistration[]> {
  const client = getRedisClient();
  const all = await client.hgetall(CAPABILITIES_KEY);
  return Object.values(all).map((v) => JSON.parse(v) as CapabilityRegistration);
}

/**
 * Get a specific capability by name.
 */
export async function getCapability(
  name: string,
): Promise<CapabilityRegistration | null> {
  const client = getRedisClient();
  const data = await client.hget(CAPABILITIES_KEY, name);
  return data ? (JSON.parse(data) as CapabilityRegistration) : null;
}

/**
 * Get capabilities accessible to a specific channel.
 */
export async function getCapabilitiesForChannel(
  channelName: string,
): Promise<CapabilityRegistration[]> {
  const all = await getCapabilities();
  return all.filter(
    (cap) =>
      !cap.channels || cap.channels.length === 0 || cap.channels.includes(channelName),
  );
}

// ── Health tracking ─────────────────────────────────────────────────────────

/**
 * Remove capabilities whose heartbeat key has expired.
 * Called periodically by the sweep timer.
 */
async function sweepStaleCapabilities(): Promise<void> {
  const client = getRedisClient();
  let all: Record<string, string>;
  try {
    all = await client.hgetall(CAPABILITIES_KEY);
  } catch (err) {
    logger.error({ err }, 'Failed to read capabilities hash during sweep');
    return;
  }

  for (const name of Object.keys(all)) {
    const alive = await client.exists(`${HEARTBEAT_PREFIX}${name}`);
    if (!alive) {
      await client.hdel(CAPABILITIES_KEY, name);
      logger.info({ name }, 'Swept stale capability (heartbeat expired)');
    }
  }
}

// ── Stream watchers ─────────────────────────────────────────────────────────

let watcherRunning = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Resolve '$' to the actual current last-entry ID (same helper pattern as ipc-redis.ts). */
async function resolveStreamTip(stream: string): Promise<string> {
  const client = getRedisClient();
  const entries = (await client.xrevrange(stream, '+', '-', 'COUNT', '1')) as [
    string,
    string[],
  ][];
  return entries.length > 0 ? entries[0][0] : '0-0';
}

/**
 * Watch the capability registration stream.
 *
 * Capability pods write messages with fields:
 *   name, endpoint, capabilities (JSON array), channels? (JSON array)
 *
 * The orchestrator validates and stores the registration.
 */
async function watchCapabilityRegistrations(): Promise<void> {
  const redis = getRedisClient();
  const stream = getCapabilityRegisterStream();
  let lastId = await resolveStreamTip(stream);

  logger.info('Capability registration watcher started');

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

          const { name, endpoint } = obj;
          if (!name || !endpoint) {
            logger.warn(
              { fields: obj },
              'Capability registration missing required fields',
            );
            continue;
          }

          let capabilities: string[] = [];
          if (obj.capabilities) {
            try {
              capabilities = JSON.parse(obj.capabilities) as string[];
            } catch {
              logger.warn(
                { name, raw: obj.capabilities },
                'Failed to parse capabilities array, using empty',
              );
            }
          }

          let channels: string[] | undefined;
          if (obj.channels) {
            try {
              channels = JSON.parse(obj.channels) as string[];
            } catch {
              logger.warn(
                { name, raw: obj.channels },
                'Failed to parse channels array, ignoring',
              );
            }
          }

          const reg: CapabilityRegistration = {
            name,
            endpoint,
            capabilities,
            channels,
            registeredAt: new Date().toISOString(),
          };

          await registerCapability(reg);
        }
      }
    } catch (err) {
      if (watcherRunning) {
        logger.error({ err }, 'Capability registration watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * Discovery request/response handler.
 *
 * Channel pods write to the discovery request stream with fields:
 *   requestId  — unique ID; the orchestrator writes the response to
 *                kubeclaw:discovery:response:{requestId}
 *   capability — (optional) name of a specific capability to look up
 *   channel    — (optional) the requesting channel name, used to filter
 *                capabilities restricted to certain channels
 *
 * Response is written as a JSON string to the response key with a short TTL.
 */
async function watchDiscoveryRequests(): Promise<void> {
  const redis = getRedisClient();
  const stream = getDiscoveryRequestStream();
  let lastId = await resolveStreamTip(stream);

  logger.info('Discovery request watcher started');

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

          const { requestId } = obj;
          if (!requestId) {
            logger.warn(
              { fields: obj },
              'Discovery request missing requestId',
            );
            continue;
          }

          try {
            let result: CapabilityRegistration[];

            if (obj.capability) {
              // Lookup a specific capability by name
              const cap = await getCapability(obj.capability);
              result = cap ? [cap] : [];
            } else if (obj.channel) {
              // Get all capabilities accessible to this channel
              result = await getCapabilitiesForChannel(obj.channel);
            } else {
              // Return all capabilities
              result = await getCapabilities();
            }

            const responseKey = getDiscoveryResponseKey(requestId);
            await redis.set(
              responseKey,
              JSON.stringify(result),
              'EX',
              DISCOVERY_RESPONSE_TTL_SECONDS,
            );

            logger.debug(
              {
                requestId,
                capability: obj.capability,
                channel: obj.channel,
                resultCount: result.length,
              },
              'Discovery response written',
            );
          } catch (err) {
            logger.error(
              { requestId, err },
              'Failed to process discovery request',
            );
          }
        }
      }
    } catch (err) {
      if (watcherRunning) {
        logger.error({ err }, 'Discovery request watcher error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start all discovery watchers. Called once during orchestrator startup.
 *
 * Launches:
 *  - Capability registration stream watcher
 *  - Discovery request stream watcher
 *  - Periodic stale-capability sweep
 */
export function startDiscoveryWatcher(): void {
  if (watcherRunning) {
    logger.debug('Discovery watcher already running, skipping duplicate start');
    return;
  }
  watcherRunning = true;

  // Start stream watchers (fire-and-forget async loops)
  watchCapabilityRegistrations().catch((err) =>
    logger.error({ err }, 'Capability registration watcher crashed'),
  );
  watchDiscoveryRequests().catch((err) =>
    logger.error({ err }, 'Discovery request watcher crashed'),
  );

  // Periodic sweep for capabilities whose heartbeat has expired
  sweepTimer = setInterval(() => {
    sweepStaleCapabilities().catch((err) =>
      logger.error({ err }, 'Stale capability sweep error'),
    );
  }, SWEEP_INTERVAL_MS);

  logger.info('Discovery watchers started');
}

/**
 * Stop all discovery watchers and clean up resources.
 */
export function stopDiscoveryWatcher(): void {
  watcherRunning = false;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  logger.info('Discovery watchers stopped');
}
