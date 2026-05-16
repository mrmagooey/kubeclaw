import { z } from 'zod';
import type { K8sSecretSource } from './k8s-secret-source.js';

export const MappingSchema = z.object({
  id: z.string().min(1),
  destinations: z.array(z.string().min(1)).min(1),
  identities: z.array(z.string().min(1)).min(1),
  credentialRef: z.object({
    kind: z.literal('Secret'),
    name: z.string().min(1),
    key: z.string().min(1),
  }),
  headerScheme: z.enum(['bearer']),
});
export type Mapping = z.infer<typeof MappingSchema>;

export const CredentialFieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
  envVar: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE'),
});
export type CredentialField = z.infer<typeof CredentialFieldSchema>;

export const CatalogEntrySchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'lowercase, digits, hyphens'),
    host: z.string().min(1),
    upstreamPort: z.number().int().positive().default(443),
    credentialFields: z.array(CredentialFieldSchema).min(1),
    // Defensive: chart may render `baseUrlEnvs:` with no body when empty,
    // which YAML parses as null. Coerce null → {} before validation.
    baseUrlEnvs: z.preprocess(
      (v) => (v == null ? {} : v),
      z.record(z.string(), z.string()),
    ),
    allowOperatorFallback: z.boolean().default(false),
    allowedPositions: z.array(z.enum(['header', 'body'])).default(['header', 'body']),
    apiKeyShape: z
      .object({
        prefix: z.string(),
        minLength: z.number().int().positive(),
      })
      .optional(),
  })
  .refine(
    (e) => !e.allowOperatorFallback || e.credentialFields.length === 1,
    { message: 'allowOperatorFallback requires exactly one credentialField' },
  );
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export interface ResolveQuery {
  destination: string;
  identity: string;
}

export interface ResolveSubMapQuery {
  identity: string;
  ownerGroup: string | null;
  host: string;
}

export type ResolveResult =
  | {
      status: 'ok';
      substitutions: Array<{ placeholder: string; value: string }>;
      keySource: 'groupSecret' | 'operatorFallback';
      catalogId: string;
      allowedPositions: Array<'header' | 'body'>;
    }
  | { status: 'no_credential'; catalogId: string }
  | { status: 'unknown_destination' }
  | { status: 'no_owner_group' };

export interface ResolverOpts {
  mappings: ReadonlyArray<Mapping>;
  catalog: ReadonlyArray<CatalogEntry>;
  groupSource: K8sSecretSource;
  operatorSecretReader: (key: string) => Promise<string | null>;
}

export class Resolver {
  constructor(private readonly opts: ResolverOpts) {}

  // Legacy bearer path — unchanged callers (ext-authz bearer flow).
  find(q: ResolveQuery): Mapping | undefined {
    return this.opts.mappings.find(
      (m) =>
        m.destinations.includes(q.destination) &&
        (m.identities.includes('*') || m.identities.includes(q.identity)),
    );
  }

  formatHeader(scheme: Mapping['headerScheme'], value: string): string {
    switch (scheme) {
      case 'bearer':
        return `Bearer ${value}`;
      default: {
        const _exhaustive: never = scheme;
        throw new Error(`unsupported header scheme: ${_exhaustive as string}`);
      }
    }
  }

  /** Synchronous: covers per-group hit, no-group miss, and no-fallback miss. */
  resolveSubstitutionMap(q: ResolveSubMapQuery): ResolveResult {
    const entry = this.opts.catalog.find((e) => e.host === q.host);
    if (!entry) return { status: 'unknown_destination' };
    if (!q.ownerGroup) return { status: 'no_owner_group' };
    const blob = this.opts.groupSource.getGroupCredential(q.ownerGroup, entry.id);
    if (blob) {
      const subs: Array<{ placeholder: string; value: string }> = [];
      for (const field of entry.credentialFields) {
        const f = blob.fields[field.name];
        if (!f) continue; // schema mismatch — fail-closed at request time
        subs.push({ placeholder: f.placeholder, value: f.value });
      }
      return {
        status: 'ok',
        substitutions: subs,
        keySource: 'groupSecret',
        catalogId: entry.id,
        allowedPositions: entry.allowedPositions,
      };
    }
    return { status: 'no_credential', catalogId: entry.id };
  }

  /** Async variant: also tries operator fallback if catalog entry permits. */
  async resolveSubstitutionMapAsync(q: ResolveSubMapQuery): Promise<ResolveResult> {
    const sync = this.resolveSubstitutionMap(q);
    if (sync.status !== 'no_credential') return sync;
    const entry = this.opts.catalog.find((e) => e.host === q.host)!;
    if (!entry.allowOperatorFallback) return sync;
    const opVal = await this.opts.operatorSecretReader(entry.id);
    if (!opVal) return sync;
    return {
      status: 'ok',
      substitutions: [{ placeholder: `KC_PH_FALLBACK_${entry.id}`, value: opVal }],
      keySource: 'operatorFallback',
      catalogId: entry.id,
      allowedPositions: entry.allowedPositions,
    };
  }
}
