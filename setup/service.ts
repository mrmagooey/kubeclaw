/**
 * Step: service — Service setup.
 * NanoClaw now runs exclusively on Kubernetes.
 */
import { execSync } from 'child_process';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function isKubernetesMode(): boolean {
  try {
    // Check if Kubernetes orchestrator is already deployed
    execSync('kubectl get deployment nanoclaw-orchestrator -n nanoclaw', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function run(_args: string[]): Promise<void> {
  // Check if Kubernetes mode is active
  if (isKubernetesMode()) {
    logger.info(
      'Kubernetes orchestrator detected — skipping local service setup',
    );
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'kubernetes',
      SERVICE_LOADED: true,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  // Non-Kubernetes mode is no longer supported
  logger.error(
    'Non-Kubernetes runtime detected. NanoClaw now runs exclusively on Kubernetes.',
  );
  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'unknown',
    SERVICE_LOADED: false,
    STATUS: 'failed',
    ERROR: 'non_kubernetes_runtime_not_supported',
    LOG: 'logs/setup.log',
  });
  throw new Error(
    'Non-Kubernetes runtime is not supported. NanoClaw now runs exclusively on Kubernetes.',
  );
}
