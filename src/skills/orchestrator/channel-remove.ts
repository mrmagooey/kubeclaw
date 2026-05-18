/**
 * Orchestrator skill: Channel removal.
 *
 * Idempotently removes all K8s resources created by setup_channel:
 *   - Deployment kubeclaw-channel-<instance>
 *   - Secret     kubeclaw-<instance>-secrets
 *   - PVCs       kubeclaw-channel-<instance>-{groups,store,sessions}
 */
import * as k8s from '@kubernetes/client-node';

// Lazy K8s client initialization — avoids loadFromCluster() at import time
// which throws outside a K8s cluster (e.g. during builds or tests).
let coreV1: k8s.CoreV1Api;
let appsV1: k8s.AppsV1Api;
function getK8sClients() {
  if (!coreV1) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  }
  return { coreV1, appsV1 };
}

const NAMESPACE = process.env.KUBECLAW_NAMESPACE || 'kubeclaw';

export interface ChannelRemoveResult {
  deleted: string[];
  alreadyAbsent: string[];
  summary: string;
}

/**
 * Returns true if the error from the K8s client is a 404 (resource not found).
 *
 * @kubernetes/client-node v1.x throws ApiException with a `code` property
 * (NOT `statusCode`).  Older versions / watch path set `statusCode`.
 * We check all three locations for compatibility.
 */
function isNotFound(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // ApiException (k8s client v1.x): `code` field directly on the error
    if (e['code'] === 404) return true;
    // Legacy / watch path: `statusCode` directly on the error
    if (e['statusCode'] === 404) return true;
    // Some versions nest it under response
    const resp = e['response'] as Record<string, unknown> | undefined;
    if (resp && resp['statusCode'] === 404) return true;
  }
  return false;
}

async function tryDeleteDeployment(name: string): Promise<'deleted' | 'absent'> {
  const { appsV1 } = getK8sClients();
  try {
    await appsV1.deleteNamespacedDeployment({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

async function tryDeleteSecret(name: string): Promise<'deleted' | 'absent'> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.deleteNamespacedSecret({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

async function tryDeletePvc(name: string): Promise<'deleted' | 'absent'> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.deleteNamespacedPersistentVolumeClaim({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

/**
 * Remove all K8s resources associated with a channel instance.
 * Idempotent: treats 404 as success.
 */
export async function removeChannel(instanceName: string): Promise<ChannelRemoveResult> {
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  const secretName = `kubeclaw-${instanceName}-secrets`;
  const pvcNames = [
    `kubeclaw-channel-${instanceName}-groups`,
    `kubeclaw-channel-${instanceName}-store`,
    `kubeclaw-channel-${instanceName}-sessions`,
  ];

  const deleted: string[] = [];
  const alreadyAbsent: string[] = [];

  function record(name: string, outcome: 'deleted' | 'absent'): void {
    if (outcome === 'deleted') deleted.push(name);
    else alreadyAbsent.push(name);
  }

  record(deploymentName, await tryDeleteDeployment(deploymentName));
  record(secretName, await tryDeleteSecret(secretName));
  for (const pvc of pvcNames) {
    record(pvc, await tryDeletePvc(pvc));
  }

  const deletedLines =
    deleted.length > 0
      ? `Deleted:\n${deleted.map((n) => `  - ${n}`).join('\n')}`
      : 'Nothing deleted.';
  const absentLines =
    alreadyAbsent.length > 0
      ? `Already absent:\n${alreadyAbsent.map((n) => `  - ${n}`).join('\n')}`
      : '';

  const summary = [deletedLines, absentLines].filter(Boolean).join('\n');

  return { deleted, alreadyAbsent, summary };
}
