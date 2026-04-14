/**
 * Capability discovery service.
 *
 * Capability pods register themselves with the orchestrator on startup.
 * The orchestrator stores registrations in a Redis hash. Channel pods
 * query this hash to discover capabilities and communicate with them
 * directly after orchestrator-mediated discovery.
 */

import { getRedisClient } from './k8s/redis-client.js';
import { logger } from './logger.js';

const CAPABILITIES_KEY = 'kubeclaw:capabilities';

export interface CapabilityRegistration {
  /** Capability name, e.g. "qdrant", "whisper", "browser" */
  name: string;
  /** HTTP endpoint for direct channel→capability communication */
  endpoint: string;
  /** List of capability identifiers, e.g. ["rag-query", "rag-index"] */
  capabilities: string[];
  /** Restrict access to specific channels (empty = all channels) */
  channels?: string[];
  /** Timestamp of registration */
  registeredAt: string;
}

/**
 * Register a capability in the discovery registry.
 * Called by the orchestrator when a capability pod starts.
 */
export async function registerCapability(
  reg: CapabilityRegistration,
): Promise<void> {
  const client = getRedisClient();
  await client.hset(CAPABILITIES_KEY, reg.name, JSON.stringify(reg));
  logger.info({ name: reg.name, endpoint: reg.endpoint }, 'Capability registered');
}

/**
 * Remove a capability from the registry.
 */
export async function deregisterCapability(name: string): Promise<void> {
  const client = getRedisClient();
  await client.hdel(CAPABILITIES_KEY, name);
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
