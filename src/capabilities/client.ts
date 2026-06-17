import { getEntriesForChannel, listCapabilities } from './registry.js';
import type { CapabilityDiscoveryEntry, GroupMcpEntry } from './types.js';
import { getCachedSchemas } from '../per-group-capabilities/schema-cache.js';
import { getScope } from '../per-group-capabilities/types.js';

export function getRagEntry(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'rag' }> =>
      e.kind === 'rag',
  );
}

export function getTranscriptionEntry(
  channelName: string,
): Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }> | undefined {
  return getEntriesForChannel(channelName).find(
    (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'transcription' }> =>
      e.kind === 'transcription',
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

/**
 * Returns MCP entries for a channel — both cluster-scoped (kind: 'mcp')
 * and group-scoped (kind: 'mcp-group'). Group entries carry cached tool
 * schemas if the orchestrator has scraped them; otherwise state: 'pending-schema'.
 *
 * Async because future scopes may require I/O. v1 reads SQLite synchronously
 * under the hood; the async signature reserves the right to change without
 * breaking callers.
 */
export async function getMcpEntriesAsync(
  channelName: string,
  _groupFolder: string | undefined,
): Promise<CapabilityDiscoveryEntry[]> {
  const out: CapabilityDiscoveryEntry[] = [];

  // Cluster-scoped: filter to only cluster-scoped mcp specs, then convert.
  // Build a set of group-scoped capability names so we can exclude them.
  const groupScopedNames = new Set(
    listCapabilities()
      .filter((s) => getScope(s) === 'group')
      .map((s) => s.name),
  );

  out.push(
    ...getEntriesForChannel(channelName).filter(
      (e): e is Extract<CapabilityDiscoveryEntry, { kind: 'mcp' }> =>
        e.kind === 'mcp' && !groupScopedNames.has(e.name),
    ),
  );

  // Group-scoped: read directly from the capability table.
  for (const spec of listCapabilities()) {
    if (getScope(spec) !== 'group') continue;
    if (spec.kind !== 'mcp') continue;
    if (
      spec.channels &&
      spec.channels.length > 0 &&
      !spec.channels.includes(channelName)
    ) {
      continue;
    }
    const schemas = getCachedSchemas(spec.name, spec.image);
    const entry: GroupMcpEntry = schemas
      ? {
          name: spec.name,
          kind: 'mcp-group',
          state: 'ready',
          toolSchemas: schemas,
          allowedTools: spec.allowedTools,
        }
      : {
          name: spec.name,
          kind: 'mcp-group',
          state: 'pending-schema',
        };
    out.push(entry);
  }

  return out;
}
