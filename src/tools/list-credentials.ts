/**
 * list_credentials tool — channel-resident, LLM-callable.
 *
 * Merges the operator catalog with the per-group registered credentials.
 * Returns metadata only; values are NEVER present in the return shape.
 *
 * Tool spec for LLM registration:
 *   name: list_credentials
 *   description: "Use when user asks what's available, when a tool call
 *     fails with no_credential, or when you're unsure whether a destination
 *     is configured."
 *   parameters: {} (no input arguments)
 */

import type { IpcResponse } from '../channel-runner.js';

/** The shape of one entry returned by the tool. */
export interface CredentialEntry {
  catalogId: string;
  host: string;
  fields: string[];
  hasCredential: boolean;
  registeredAt: string | null;
}

/** Minimal catalog entry as returned by catalog.list IPC. */
interface CatalogEntryLite {
  id: string;
  host: string;
  credentialFields: Array<{ name: string; envVar: string }>;
}

/** Minimal secret entry as returned by secret.list IPC. */
interface SecretEntryLite {
  catalogId: string;
  registeredAt: string;
}

/** IPC client type — matches the channel-runner's SecretCommandDeps.ipc shape. */
export type IpcClient = (
  type: 'secret.add' | 'secret.remove' | 'secret.list' | 'catalog.list',
  fields: Record<string, string>,
) => Promise<IpcResponse>;

/** Context bag injected by the channel-runner. */
export interface ListCredentialsCtx {
  ipc: IpcClient;
}

/** Input type (no arguments required by spec; group comes from ctx). */
export interface ListCredentialsInput {
  group: string;
}

/**
 * Fetch catalog + per-group secret list in parallel and merge into the
 * `CredentialEntry[]` shape described in the spec.
 *
 * Throws on any IPC failure (callers should surface the error to the LLM).
 */
export async function listCredentialsTool(
  input: ListCredentialsInput,
  ctx: ListCredentialsCtx,
): Promise<CredentialEntry[]> {
  const { group } = input;
  const { ipc } = ctx;

  // Fire both IPC calls in parallel
  const [secretRes, catalogRes] = await Promise.all([
    ipc('secret.list', { group }),
    ipc('catalog.list', {}),
  ]);

  if (!secretRes.ok) {
    throw new Error(
      `secret.list IPC failed: ${(secretRes as { ok: false; error: string }).error}`,
    );
  }
  if (!catalogRes.ok) {
    throw new Error(
      `catalog.list IPC failed: ${(catalogRes as { ok: false; error: string }).error}`,
    );
  }

  const catalog = (catalogRes.result ?? []) as CatalogEntryLite[];
  const registered = (secretRes.result ?? []) as SecretEntryLite[];

  // Build a lookup from catalogId → registeredAt for O(1) merge
  const registeredMap = new Map<string, string>();
  for (const entry of registered) {
    registeredMap.set(entry.catalogId, entry.registeredAt);
  }

  return catalog.map((entry) => {
    const registeredAt = registeredMap.get(entry.id) ?? null;
    return {
      catalogId: entry.id,
      host: entry.host,
      fields: entry.credentialFields.map((f) => f.name),
      hasCredential: registeredMap.has(entry.id),
      registeredAt,
    };
  });
}

/**
 * OpenAI-compatible tool definition for registering list_credentials
 * in the LLM's tool list.
 */
export const LIST_CREDENTIALS_TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'list_credentials',
    description:
      "Use when user asks what's available, when a tool call fails with no_credential, or when you're unsure whether a destination is configured.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

/**
 * Build a per-turn system prompt block summarising available APIs and
 * which ones have credentials registered for the given group.
 *
 * Returns an empty string if the catalog is empty (callers may omit the block).
 */
export function buildCredentialSystemBlock(
  entries: CredentialEntry[],
  group: string,
): string {
  if (entries.length === 0) return '';

  const lines = entries.map((e) => {
    const status = e.hasCredential
      ? 'credential registered'
      : `no credential — user can register with /secret add ${e.catalogId} ...`;
    return `  - ${e.catalogId} (${e.host}): ${status}`;
  });

  return [
    `[SYSTEM] Available external APIs for group "${group}":`,
    ...lines,
  ].join('\n');
}
