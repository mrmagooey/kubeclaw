import { getRedisClient, getControlChannel } from '../k8s/redis-client.js';
import { logger } from '../logger.js';
import {
  setCapability,
  getCapability,
  getAllCapabilities,
  deleteCapability as dbDelete,
} from './db.js';
import { applySpec, deleteSpec, reconcileAllOnStartup } from './reconciler.js';
import type {
  CapabilitySpec,
  CapabilityKind,
  CapabilityDiscoveryEntry,
} from './types.js';
import { deploymentName } from './builders/common.js';

const KNOWN_CHANNELS = [
  'http',
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'irc',
  'signal',
  'gmail',
  'oauth-webchat',
];

const MCP_DEFAULT_PORT = 3000;
const HTTP_DEFAULT_PORT = 8080;
const RAG_QDRANT_DEFAULT_PORT = 6333;
const RAG_LIGHTRAG_DEFAULT_PORT = 9621;

function defaultPort(spec: CapabilitySpec): number {
  switch (spec.kind) {
    case 'mcp':
      return spec.port ?? MCP_DEFAULT_PORT;
    case 'http':
      return spec.port ?? HTTP_DEFAULT_PORT;
    case 'rag':
      return (
        spec.port ??
        (spec.backend === 'qdrant'
          ? RAG_QDRANT_DEFAULT_PORT
          : RAG_LIGHTRAG_DEFAULT_PORT)
      );
  }
}

function endpointFor(spec: CapabilitySpec): string {
  return `http://${deploymentName(spec.name)}:${defaultPort(spec)}`;
}

export function specToDiscoveryEntry(spec: CapabilitySpec): CapabilityDiscoveryEntry {
  const endpoint = endpointFor(spec);
  switch (spec.kind) {
    case 'mcp':
      return {
        name: spec.name,
        kind: 'mcp',
        endpoint,
        kindMetadata: {
          path: spec.path ?? '/mcp',
          allowedTools: spec.allowedTools,
        },
      };
    case 'rag':
      return {
        name: spec.name,
        kind: 'rag',
        endpoint,
        kindMetadata: { backend: spec.backend },
      };
    case 'http':
      return {
        name: spec.name,
        kind: 'http',
        endpoint,
        kindMetadata: {},
      };
  }
}

export function listCapabilities(): CapabilitySpec[] {
  return getAllCapabilities();
}

export function getCapabilityByName(name: string): CapabilitySpec | undefined {
  return getCapability(name);
}

export function listCapabilitiesByKind(kind: CapabilityKind): CapabilitySpec[] {
  return getAllCapabilities().filter((c) => c.kind === kind);
}

export function getEntriesForChannel(
  channelName: string,
): CapabilityDiscoveryEntry[] {
  return getAllCapabilities()
    .filter((c) => !c.channels?.length || c.channels.includes(channelName))
    .map(specToDiscoveryEntry);
}

export async function installCapability(spec: CapabilitySpec): Promise<void> {
  setCapability(spec);
  await applySpec(spec);
  logger.info(
    { name: spec.name, kind: spec.kind, image: spec.image },
    'Capability installed',
  );
  await notifyAllChannels();
}

export async function removeCapability(name: string): Promise<void> {
  const spec = getCapability(name);
  if (!spec) {
    logger.warn({ name }, 'removeCapability: no such capability');
    return;
  }
  await deleteSpec(spec);
  dbDelete(name);
  logger.info({ name }, 'Capability removed');
  await notifyAllChannels(spec.channels ?? []);
}

/**
 * Publish the per-channel capability set to each known channel pod's
 * control channel. Phase 4 retires the legacy `mcp_update` alias.
 */
export async function notifyAllChannels(
  extraChannels: string[] = [],
): Promise<void> {
  const redis = getRedisClient();
  const all = getAllCapabilities();

  // Determine the union of channel names referenced by ACL'd specs;
  // also broadcast to known channels for unrestricted entries.
  // Always include KNOWN_CHANNELS so that removals (leaving an empty list)
  // still reach all channel pods.
  // extraChannels covers non-standard names whose spec was just removed.
  const targeted = new Set<string>([...KNOWN_CHANNELS, ...extraChannels]);
  for (const spec of all) {
    if (spec.channels?.length) {
      for (const c of spec.channels) targeted.add(c);
    }
  }

  for (const channelName of targeted) {
    const entries = getEntriesForChannel(channelName);
    const payload = JSON.stringify({
      command: 'capabilities_update',
      capabilities: JSON.stringify(entries),
    });
    await redis.publish(getControlChannel(channelName), payload);

    // The casts below are required because Array.filter doesn't narrow a
    // discriminated union without a type predicate. This block is deleted
    // in Phase 4 (Task 4.4), so we accept the cast rather than introduce a
    // helper that will be removed.
    // Phase 4 deletes this MCP-only alias.
    const mcpEntries = entries.filter((e) => e.kind === 'mcp');
    if (mcpEntries.length > 0) {
      const legacy = JSON.stringify({
        command: 'mcp_update',
        servers: JSON.stringify(
          mcpEntries.map((e) => ({
            name: e.name,
            url: `${e.endpoint}${(e as { kindMetadata: { path: string } }).kindMetadata.path}`,
            allowedTools: (e as { kindMetadata: { allowedTools?: string[] } })
              .kindMetadata.allowedTools,
          })),
        ),
      });
      await redis.publish(getControlChannel(channelName), legacy);
    }

    logger.debug(
      { channel: channelName, count: entries.length },
      'Published capabilities_update',
    );
  }
}

export async function startCapabilitySubsystem(): Promise<void> {
  await reconcileAllOnStartup(getAllCapabilities());
  await notifyAllChannels();
}
