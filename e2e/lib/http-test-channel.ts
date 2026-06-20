/**
 * Test affordance: build the http channel (now a runtime adapter) in-process,
 * with a real SDK whose data-facade is wired to the live (test) db — so the
 * existing in-process http endpoint tests work against the adapter unchanged.
 */
import { HttpChannel, getAttachmentUsage, detectMediaType, buildVersionPayload } from '../../helm/kubeclaw/files/channel-src/http/channel-entry.js';
import { buildChannelSdk } from '../../src/channel-sdk/index.js';

// Loose opts type: the base ChannelOpts + the http-specific injectable overrides
// the tests provide (onMessage/onChatMetadata/registeredGroups + optional
// checkDb/killJobFn/listSecretsFn/addSecretFn/removeSecretFn/listCatalogFn/getCapabilities/…).
export type HttpChannelOpts = Record<string, any>;

// Re-export types that test files import from the old http.ts
export interface CapabilityEntry {
  type: string;
  state: 'running' | 'scaled_down';
  provisioned_at: string;
  scale: number;
}

export type CheckResult = 'ok' | 'failed' | 'unreachable';

export interface SecretListEntry {
  type: string;
  fields_present: string[];
}

export interface CatalogListEntry {
  type: string;
  required_fields: string[];
  optional_fields: string[];
  description: string;
}

export type ListSecretsFn = (group: string) => Promise<SecretListEntry[]>;

export type RemoveSecretFn = (
  group: string,
  type: string,
) => Promise<'ok' | 'not_found'>;

export type ListCatalogFn = () => Promise<CatalogListEntry[]>;

export type AddSecretFn = (
  group: string,
  type: string,
  fields: Record<string, string>,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export function makeHttpChannel(config: any, opts: HttpChannelOpts): any {
  return new HttpChannel(config, opts, buildChannelSdk());
}

export { getAttachmentUsage, detectMediaType, buildVersionPayload };
