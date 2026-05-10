import type { CapabilitySpec } from '../types.js';
import { buildMcpYaml } from './mcp.js';
import { buildHttpYaml } from './http.js';
// rag-qdrant and rag-lightrag added in Phase 3

export function buildYaml(spec: CapabilitySpec): string {
  switch (spec.kind) {
    case 'mcp':
      return buildMcpYaml(spec);
    case 'http':
      return buildHttpYaml(spec);
    case 'rag':
      throw new Error(
        `RAG builder not yet implemented (added in Phase 3): ${spec.name}`,
      );
    default: {
      // Exhaustiveness check
      const _exhaustive: never = spec;
      void _exhaustive;
      throw new Error('Unknown capability kind');
    }
  }
}
