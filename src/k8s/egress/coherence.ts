import type { ToolSpec } from '../../tools/types.js';

export interface CoherenceResult {
  ok: boolean;
  error?: string;
}

export function checkEgressCredentialCoherence(
  spec: ToolSpec,
  catalogHostLookup: (id: string) => string | undefined,
): CoherenceResult {
  const creds = spec.credentials ?? [];
  if (creds.length === 0) return { ok: true };

  const allowedHosts = new Set<string>();
  for (const id of creds) {
    const host = catalogHostLookup(id);
    if (!host)
      return { ok: false, error: `unknown credential catalog id: ${id}` };
    allowedHosts.add(host);
  }

  const egress = spec.allowedEgress ?? [];
  if (egress.length === 0) {
    return {
      ok: false,
      error:
        'a credentialed tool must declare allowedEgress (no implicit open egress)',
    };
  }
  for (const rule of egress) {
    if (!allowedHosts.has(rule.host)) {
      return {
        ok: false,
        error: `egress host ${rule.host} is not among credential hosts [${[...allowedHosts].join(', ')}]`,
      };
    }
  }
  return { ok: true };
}
