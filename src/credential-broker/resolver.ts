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
