import { logger } from '../logger.js';
import { getAllCapabilities, updateCapabilityStatus } from './db.js';
import { deploymentName } from './builders/common.js';
import type { CapabilitySpec } from './types.js';

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_PORTS: Record<CapabilitySpec['kind'], number> = {
  mcp: 3000,
  rag: 6333, // qdrant default; lightrag overrides via spec.port
  http: 8080,
  transcription: 9000,
};

function probeUrl(spec: CapabilitySpec): string {
  const port = spec.port ?? DEFAULT_PORTS[spec.kind];
  const path = spec.healthPath ?? '/health';
  return `http://${deploymentName(spec.name)}:${port}${path}`;
}

export async function probeOnce(): Promise<void> {
  const specs = getAllCapabilities();
  for (const spec of specs) {
    const url = probeUrl(spec);
    const now = new Date().toISOString();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        updateCapabilityStatus(spec.name, {
          lifecycle: 'ready',
          lastProbeAt: now,
          lastError: null,
        });
      } else {
        updateCapabilityStatus(spec.name, {
          lifecycle: 'unhealthy',
          lastProbeAt: now,
          lastError: `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      updateCapabilityStatus(spec.name, {
        lifecycle: 'unhealthy',
        lastProbeAt: now,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

let probeTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthProbes(): void {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    probeOnce().catch((err) =>
      logger.error({ err }, 'Health probe loop error'),
    );
  }, PROBE_INTERVAL_MS);
  logger.info('Capability health probes started');
}

export function stopHealthProbes(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  logger.info('Capability health probes stopped');
}
