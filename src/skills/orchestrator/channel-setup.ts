/**
 * Orchestrator skill: Channel setup utilities.
 *
 * Contains helpers for the bootstrap upgrade path (patchRuntimePvc,
 * waitForDeploymentRollout). The old setup_channel / createOrReplaceDeployment
 * / createOrPatchSecret / createPvcIfNotExists / validateChannelCredentials /
 * buildSecretData functions have been removed — channels are installed via the
 * bootstrap skill path or declarative Helm.
 */

import * as k8s from '@kubernetes/client-node';

import { logger } from '../../logger.js';

// ─── Story 181: Deployment runtime PVC patch + rollout wait ──────────────────

export interface PatchRuntimePvcDeps {
  appsV1: k8s.AppsV1Api;
  namespace: string;
}

/**
 * Strategic-merge-patch the named Deployment to mount `newPvcName` as the
 * `runtime` volume.
 *
 * Uses the `name` field as the strategic-merge-patch key for the volumes array,
 * so only the `runtime` volume entry is replaced; other volumes are preserved.
 */
export async function patchRuntimePvc(
  instanceName: string,
  newPvcName: string,
  deps: PatchRuntimePvcDeps,
): Promise<void> {
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  await deps.appsV1.patchNamespacedDeployment({
    name: deploymentName,
    namespace: deps.namespace,
    body: {
      spec: {
        template: {
          spec: {
            volumes: [
              {
                name: 'runtime',
                persistentVolumeClaim: { claimName: newPvcName },
              },
            ],
          },
        },
      },
    },
  });
  logger.info(
    { deploymentName, newPvcName },
    'patchRuntimePvc: Deployment volume patched to new PVC',
  );
}

export interface WaitForDeploymentRolloutOpts {
  appsV1: k8s.AppsV1Api;
  namespace: string;
  /** Poll interval (ms). Default: 3000. */
  pollIntervalMs?: number;
  /** Total timeout (ms). Default: UPGRADE_ROLLOUT_TIMEOUT_SECONDS * 1000 || 300_000. */
  timeoutMs?: number;
}

/**
 * Poll a Deployment until all replicas are updated and available.
 *
 * Resolves when `status.updatedReplicas >= spec.replicas &&
 * status.availableReplicas >= spec.replicas`.
 *
 * Rejects with an error whose message includes 'rollout timeout' after
 * `timeoutMs` milliseconds.
 */
export async function waitForDeploymentRollout(
  deploymentName: string,
  opts: WaitForDeploymentRolloutOpts,
): Promise<void> {
  const {
    appsV1,
    namespace,
    pollIntervalMs = 3_000,
    timeoutMs = parseInt(
      process.env.UPGRADE_ROLLOUT_TIMEOUT_SECONDS || '300',
      10,
    ) * 1_000,
  } = opts;

  const deadline = Date.now() + timeoutMs;

  while (true) {
    const deployment = await appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace,
    });
    const desired = deployment.spec?.replicas ?? 1;
    const updated = deployment.status?.updatedReplicas ?? 0;
    const available = deployment.status?.availableReplicas ?? 0;

    if (updated >= desired && available >= desired) {
      logger.info(
        { deploymentName, updated, available, desired },
        'waitForDeploymentRollout: rollout complete',
      );
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `rollout timeout: Deployment ${deploymentName} not fully available after ${timeoutMs}ms (updated=${updated}, available=${available}, desired=${desired})`,
      );
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
