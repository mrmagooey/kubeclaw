import type { CapabilitySpec } from '../types.js';
import { buildMcpYaml } from './mcp.js';
import { buildHttpYaml } from './http.js';
import { buildRagQdrantYaml } from './rag-qdrant.js';
import { buildRagLightRagYaml } from './rag-lightrag.js';

export function buildYaml(spec: CapabilitySpec): string {
  switch (spec.kind) {
    case 'mcp':
      return buildMcpYaml(spec);
    case 'http':
      return buildHttpYaml(spec);
    case 'rag':
      if (spec.backend === 'qdrant') return buildRagQdrantYaml(spec);
      if (spec.backend === 'lightrag') return buildRagLightRagYaml(spec);
      throw new Error(`Unknown RAG backend: ${(spec as { backend: string }).backend}`);
    default: {
      // Exhaustiveness check
      const _exhaustive: never = spec;
      void _exhaustive;
      throw new Error('Unknown capability kind');
    }
  }
}
