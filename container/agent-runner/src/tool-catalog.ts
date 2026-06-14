/**
 * Agent-runner-local tool catalog reader.
 *
 * The agent-runner is a separate package and cannot import the main app's
 * ToolCatalogLoader. This is a deliberately lenient reader over the same
 * tools.json the channel pod mounts (the `kubeclaw-tools` ConfigMap): it reads
 * only the fields the agent needs and never throws. Validation, credential
 * resolution, and the authoritative channel ACL all happen orchestrator-side at
 * spawn time, so this reader does no schema validation.
 */
import { existsSync, readFileSync } from 'fs';

export interface CatalogTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  channels?: string[];
  timeout?: number;
}

export interface Catalog {
  /** Tools visible to `channelName`: those with empty/absent `channels` or that list it. */
  getForChannel(channelName: string): CatalogTool[];
}

export function loadCatalog(path: string): Catalog {
  let tools: CatalogTool[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        tools?: unknown[];
      };
      if (Array.isArray(parsed.tools)) {
        tools = parsed.tools
          .filter(
            (t): t is Record<string, unknown> =>
              typeof t === 'object' && t !== null,
          )
          .filter(
            (t) =>
              typeof t.name === 'string' &&
              typeof t.description === 'string' &&
              typeof t.parameters === 'object' &&
              t.parameters !== null,
          )
          .map((t) => ({
            name: t.name as string,
            description: t.description as string,
            parameters: t.parameters as Record<string, unknown>,
            channels: Array.isArray(t.channels)
              ? (t.channels as string[])
              : undefined,
            timeout:
              typeof t.timeout === 'number' ? (t.timeout as number) : undefined,
          }));
      }
    } catch {
      tools = [];
    }
  }
  return {
    getForChannel(channelName: string): CatalogTool[] {
      return tools.filter(
        (t) => !t.channels?.length || t.channels.includes(channelName),
      );
    },
  };
}
