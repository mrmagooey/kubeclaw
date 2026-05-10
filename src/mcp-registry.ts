/**
 * @deprecated MCP-specific registry. Delegates to the unified capabilities
 * subsystem. Removed in phase 4 of the unified-capabilities migration.
 */
import {
  installCapability,
  removeCapability,
  listCapabilities,
  getEntriesForChannel,
  notifyAllChannels as capNotifyAll,
} from './capabilities/index.js';
import type { McpServerSpec, McpServerStatus } from './types.js';

export async function deployMcpServer(spec: McpServerSpec): Promise<void> {
  await installCapability({ ...spec, kind: 'mcp' });
}

export async function removeMcpServer(name: string): Promise<void> {
  await removeCapability(name);
}

export function listMcpServers(): McpServerSpec[] {
  return listCapabilities()
    .filter((c) => c.kind === 'mcp')
    .map((c) => c as unknown as McpServerSpec);
}

export function getServersForChannel(channelName: string): McpServerStatus[] {
  return getEntriesForChannel(channelName)
    .filter((e) => e.kind === 'mcp')
    .map((e) => ({
      name: e.name,
      url: `${e.endpoint}${(e as { kindMetadata: { path: string } }).kindMetadata.path}`,
      allowedTools: (e as { kindMetadata: { allowedTools?: string[] } })
        .kindMetadata.allowedTools,
    }));
}

export async function notifyAllChannels(): Promise<void> {
  await capNotifyAll();
}

export async function syncFromValues(specs: McpServerSpec[]): Promise<void> {
  for (const spec of specs) await deployMcpServer(spec);
}
