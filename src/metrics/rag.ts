import { Counter, Histogram, Registry } from 'prom-client';

export interface RagMetrics {
  recordQuery(labels: {
    group: string;
    hit: boolean;
    durationMs: number;
  }): void;
  recordBackendError(labels: { backend: 'qdrant' | 'embedding' }): void;
  recordIndex(labels: {
    group: string;
    chunks: number;
    durationMs: number;
  }): void;
}

export function createRagMetrics(registry: Registry): RagMetrics {
  const queryDuration = new Histogram({
    name: 'kubeclaw_rag_query_duration_seconds',
    help: 'Qdrant + embedding round-trip latency for retrieval queries',
    labelNames: ['group', 'hit'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const queriesTotal = new Counter({
    name: 'kubeclaw_rag_queries_total',
    help: 'Total RAG retrieval queries, labelled by whether any results were returned',
    labelNames: ['group', 'hit'] as const,
    registers: [registry],
  });

  const backendErrors = new Counter({
    name: 'kubeclaw_rag_backend_errors_total',
    help: 'Total errors from Qdrant or embedding backends during RAG operations',
    labelNames: ['backend'] as const,
    registers: [registry],
  });

  const indexDuration = new Histogram({
    name: 'kubeclaw_rag_index_duration_seconds',
    help: 'End-to-end latency of a text indexing operation (chunk + embed + upsert)',
    labelNames: ['group'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const chunksIndexed = new Counter({
    name: 'kubeclaw_rag_chunks_indexed_total',
    help: 'Total text chunks upserted into Qdrant',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  return {
    recordQuery({ group, hit, durationMs }) {
      const hitStr = String(hit);
      queryDuration.observe({ group, hit: hitStr }, durationMs / 1000);
      queriesTotal.inc({ group, hit: hitStr });
    },
    recordBackendError({ backend }) {
      backendErrors.inc({ backend });
    },
    recordIndex({ group, chunks, durationMs }) {
      indexDuration.observe({ group }, durationMs / 1000);
      chunksIndexed.inc({ group }, chunks);
    },
  };
}
