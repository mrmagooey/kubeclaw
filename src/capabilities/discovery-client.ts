import { randomUUID } from 'crypto';
import {
  getRedisClient,
  getDiscoveryRequestStream,
  getDiscoveryResponseKey,
} from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import type { CapabilityDiscoveryEntry } from './types.js';

const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 35_000;

export type GroupCapabilityResolveResult =
  | { endpoint: string; token?: string }
  | { error: string };

export async function requestGroupCapability(
  capability: string,
  groupFolder: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GroupCapabilityResolveResult> {
  const requestId = randomUUID();
  const client = getRedisClient();
  const stream = getDiscoveryRequestStream();
  const responseKey = getDiscoveryResponseKey(requestId);

  logger.info(
    { capability, group: groupFolder, requestId },
    'discovery_client_request',
  );
  await client.xadd(
    stream,
    '*',
    'requestId',
    requestId,
    'capability',
    capability,
    'group',
    groupFolder,
  );

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await client.get(responseKey);
    if (raw) {
      const entries = JSON.parse(raw) as CapabilityDiscoveryEntry[];
      if (entries.length === 0) {
        return { error: 'empty discovery response' };
      }
      const entry = entries[0];
      const duration_ms = Date.now() - start;
      logger.info(
        { capability, group: groupFolder, state: entry.state, duration_ms },
        'discovery_client_response',
      );
      if (entry.state === 'failed') {
        return { error: entry.error ?? 'failed' };
      }
      if (entry.kind !== 'mcp-group' && 'endpoint' in entry && entry.endpoint) {
        return { endpoint: entry.endpoint, token: entry.token };
      }
      return { error: 'response missing endpoint' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { error: `discovery timeout after ${timeoutMs}ms` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
