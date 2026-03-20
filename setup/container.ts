/**
 * Step: container — DEPRECATED. Container runtime removed.
 * NanoClaw now runs exclusively on Kubernetes.
 */
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  emitStatus('SETUP_CONTAINER', {
    STATUS: 'failed',
    ERROR:
      'Docker runtime removed — NanoClaw now runs exclusively on Kubernetes',
  });
  throw new Error(
    'Docker runtime removed — NanoClaw now runs exclusively on Kubernetes',
  );
}
