import { z } from 'zod';

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
    baseUrlEnvs: z.record(z.string(), z.string()).default({}),
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

export class Resolver {
  constructor(private readonly mappings: ReadonlyArray<Mapping>) {}

  find(q: ResolveQuery): Mapping | undefined {
    return this.mappings.find(
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
}
