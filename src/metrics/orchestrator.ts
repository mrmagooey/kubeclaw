import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface OrchestratorMetrics {
  recordToolJobSpawn(labels: { image: string }): void;
  recordToolJobDuration(labels: {
    image: string;
    success: boolean;
    durationMs: number;
  }): void;
  recordToolJobFailure(labels: { image: string; reason: string }): void;
  recordRedisMessage(labels: { stream: string }): void;
  setGroupQueueDepth(labels: { group: string }, depth: number): void;
  recordSpecialistResolution(labels: { specialist: string }): void;
  recordDbQuery(labels: { operation: string; durationMs: number }): void;
  /** Story 176: increment when commit_channel_config is hard-rejected due to PVC hash divergence */
  recordBootstrapManifestMismatch(labels: { channel_type: string }): void;
}

/**
 * Register all orchestrator-tier Prometheus metrics on `registry`.
 *
 * Tool-job pods are short-lived (seconds to minutes); scraping them individually
 * would race against pod termination. The orchestrator instead emits their
 * lifecycle metrics directly — it is the authoritative source for spawn,
 * completion, and failure events regardless of pod lifespan.
 */
export function createOrchestratorMetrics(
  registry: Registry,
): OrchestratorMetrics {
  const toolJobSpawned = new Counter({
    name: 'kubeclaw_tool_job_spawned_total',
    help: 'Total tool-job Kubernetes Jobs created by the orchestrator',
    labelNames: ['image'] as const,
    registers: [registry],
  });

  const toolJobDuration = new Histogram({
    name: 'kubeclaw_tool_job_duration_seconds',
    help: 'Wall-clock duration of tool-job pods from spawn to completion',
    labelNames: ['image', 'success'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  const toolJobFailures = new Counter({
    name: 'kubeclaw_tool_job_failures_total',
    help: 'Tool-job failures broken down by failure reason',
    labelNames: ['image', 'reason'] as const,
    registers: [registry],
  });

  const redisIpcMessages = new Counter({
    name: 'kubeclaw_redis_ipc_messages_total',
    help: 'Total Redis IPC stream messages consumed by the orchestrator',
    labelNames: ['stream'] as const,
    registers: [registry],
  });

  const groupQueueDepth = new Gauge({
    name: 'kubeclaw_group_queue_depth',
    help: 'Current number of pending messages in each group queue',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const specialistResolutions = new Counter({
    name: 'kubeclaw_specialist_resolutions_total',
    help: 'Total @mention resolutions against the global specialist catalog',
    labelNames: ['specialist'] as const,
    registers: [registry],
  });

  const dbQueryDuration = new Histogram({
    name: 'kubeclaw_db_query_duration_seconds',
    help: 'SQLite query duration in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    registers: [registry],
  });

  const bootstrapManifestMismatch = new Counter({
    name: 'kubeclaw_bootstrap_manifest_mismatch_total',
    help: 'Total bootstrap commits hard-rejected due to runtime PVC hash diverging from the channel manifest (Story 176)',
    labelNames: ['channel_type'] as const,
    registers: [registry],
  });

  return {
    recordToolJobSpawn({ image }) {
      toolJobSpawned.inc({ image });
    },
    recordToolJobDuration({ image, success, durationMs }) {
      toolJobDuration.observe(
        { image, success: String(success) },
        durationMs / 1000,
      );
    },
    recordToolJobFailure({ image, reason }) {
      toolJobFailures.inc({ image, reason });
    },
    recordRedisMessage({ stream }) {
      redisIpcMessages.inc({ stream });
    },
    setGroupQueueDepth({ group }, depth) {
      groupQueueDepth.set({ group }, depth);
    },
    recordSpecialistResolution({ specialist }) {
      specialistResolutions.inc({ specialist });
    },
    recordDbQuery({ operation, durationMs }) {
      dbQueryDuration.observe({ operation }, durationMs / 1000);
    },
    recordBootstrapManifestMismatch({ channel_type }) {
      bootstrapManifestMismatch.inc({ channel_type });
    },
  };
}
