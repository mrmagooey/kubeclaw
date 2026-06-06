/**
 * Orchestrator skill: Channel removal.
 *
 * Idempotently removes all K8s resources associated with a channel instance:
 *   - Deployment kubeclaw-channel-<instance>
 *   - Secret     kubeclaw-<instance>-secrets
 *   - All PVCs   labelled kubeclaw-channel=<instance>  (AC1 — label-driven)
 *   - All Jobs   labelled kubeclaw-channel=<instance>  (AC5 — in-progress bootstrap)
 *
 * PVC and Job deletion switches from hardcoded name suffixes to a label selector
 * so that both steady-state PVCs (groups/store/sessions) and bootstrap-era runtime
 * PVCs are cleaned up without needing to enumerate names.
 */
import * as k8s from '@kubernetes/client-node';

// Lazy K8s client initialization — avoids loadFromCluster() at import time
// which throws outside a K8s cluster (e.g. during builds or tests).
let coreV1: k8s.CoreV1Api;
let appsV1: k8s.AppsV1Api;
let batchV1: k8s.BatchV1Api;
function getK8sClients() {
  if (!coreV1) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    batchV1 = kc.makeApiClient(k8s.BatchV1Api);
  }
  return { coreV1, appsV1, batchV1 };
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

async function tryDeleteDeployment(
  name: string,
): Promise<'deleted' | 'absent'> {
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

/**
 * Delete a single PVC by name. NotFound → 'absent'; others propagate.
 */
async function tryDeletePvc(name: string): Promise<'deleted' | 'absent'> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.deleteNamespacedPersistentVolumeClaim({
      name,
      namespace: NAMESPACE,
    });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

/**
 * Delete a single Job by name. NotFound → 'absent'; others propagate.
 */
async function tryDeleteJob(name: string): Promise<'deleted' | 'absent'> {
  const { batchV1 } = getK8sClients();
  try {
    await batchV1.deleteNamespacedJob({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

/**
 * List PVC names carrying the label kubeclaw-channel=<instanceName>.
 * Returns an empty array when none are found (AC4 — backwards-compatible).
 */
async function listPvcNamesByLabel(instanceName: string): Promise<string[]> {
  const { coreV1 } = getK8sClients();
  const result = await coreV1.listNamespacedPersistentVolumeClaim({
    namespace: NAMESPACE,
    labelSelector: `kubeclaw-channel=${instanceName}`,
  });
  return (result.items ?? [])
    .map((pvc) => pvc.metadata?.name)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * List Job names carrying the label kubeclaw-channel=<instanceName>.
 * Returns an empty array when none are found (AC5 — in-progress bootstrap).
 */
async function listJobNamesByLabel(instanceName: string): Promise<string[]> {
  const { batchV1 } = getK8sClients();
  const result = await batchV1.listNamespacedJob({
    namespace: NAMESPACE,
    labelSelector: `kubeclaw-channel=${instanceName}`,
  });
  return (result.items ?? [])
    .map((job) => job.metadata?.name)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Remove all K8s resources associated with a channel instance.
 * Idempotent: treats 404 as success.
 *
 * Deletion order:
 *   1. Deployment (steady-state channel pod, if present)
 *   2. Secret (channel credentials)
 *   3. All PVCs labelled kubeclaw-channel=<instanceName>
 *      — covers groups/store/sessions (setup_channel) and runtime (bootstrap)
 *   4. All Jobs labelled kubeclaw-channel=<instanceName>
 *      — covers in-progress bootstrap Jobs (AC5)
 */
export async function removeChannel(
  instanceName: string,
): Promise<ChannelRemoveResult> {
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  const secretName = `kubeclaw-${instanceName}-secrets`;

  const deleted: string[] = [];
  const alreadyAbsent: string[] = [];

  function record(name: string, outcome: 'deleted' | 'absent'): void {
    if (outcome === 'deleted') deleted.push(name);
    else alreadyAbsent.push(name);
  }

  // 1. Delete the steady-state Deployment (may not exist if bootstrap-era only)
  record(deploymentName, await tryDeleteDeployment(deploymentName));

  // 2. Delete the credentials Secret
  record(secretName, await tryDeleteSecret(secretName));

  // 3. Delete all PVCs by label (groups, store, sessions, runtime — whatever is present)
  const pvcNames = await listPvcNamesByLabel(instanceName);
  if (pvcNames.length === 0) {
    // No labelled PVCs found — legacy channel or already fully absent
    alreadyAbsent.push(`<no PVCs labelled kubeclaw-channel=${instanceName}>`);
  } else {
    for (const pvcName of pvcNames) {
      record(pvcName, await tryDeletePvc(pvcName));
    }
  }

  // 4. Delete all Jobs by label (covers in-progress bootstrap, AC5)
  const jobNames = await listJobNamesByLabel(instanceName);
  for (const jobName of jobNames) {
    record(jobName, await tryDeleteJob(jobName));
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
