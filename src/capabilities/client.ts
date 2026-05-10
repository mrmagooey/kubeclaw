import { getEntriesForChannel } from './registry.js';
import type { CapabilityDiscoveryEntry } from './types.js';

export function getRagEntry(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> =>
      e.kind === 'rag',
  );
}

export function getMcpEntries(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }>[] {
  return getEntriesForChannel(channelName).filter(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }> =>
      e.kind === 'mcp',
  );
}

export function getHttpEntry(
  channelName: string,
  name: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'http' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'http' }> =>
      e.kind === 'http' && e.name === name,
  );
}
