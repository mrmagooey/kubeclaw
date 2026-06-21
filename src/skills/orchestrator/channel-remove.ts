/**
 * Orchestrator skill: Channel removal.
 *
 * Idempotently removes ALL K8s resources a channel instance can own, across
 * BOTH install front-ends (declarative Helm `channels:` and the interactive
 * bootstrap flow). Resources share the predictable base name
 * `kubeclaw-channel-<instance>`, so removal is name-driven (the install paths
 * label resources inconsistently — bootstrap PVCs carry only
 * `kubeclaw/channel-pvc`, Helm PVCs none — so a label selector cannot be
 * relied on). Deleted (each idempotent, 404 → already-absent):
 *   - Deployment      kubeclaw-channel-<instance>
 *   - ServiceAccount  kubeclaw-channel-<instance>            (Helm)
 *   - Service         kubeclaw-channel-<instance>            (httpPort channels)
 *   - Service         kubeclaw-channel-<instance>-metrics    (Helm)
 *   - NetworkPolicy   kubeclaw-channel-<instance>-ingress    (httpPort channels)
 *   - Secret          kubeclaw-channel-<instance>            (Helm user secret)
 *   - Secret          kubeclaw-channel-<instance>-credentials (bootstrap)
 *   - Secret          kubeclaw-<instance>-secrets            (legacy setup_channel)
 *   - PVCs            kubeclaw-channel-<instance>-{groups,store,sessions,runtime}
 *                     plus versioned runtime PVCs (…-runtime-v<N>) from upgrades
 *   - Job             kubeclaw-bootstrap-<instance>          (in-progress bootstrap)
 */
import * as k8s from '@kubernetes/client-node';

// Lazy K8s client initialization — avoids loadFromCluster() at import time
// which throws outside a K8s cluster (e.g. during builds or tests).
let coreV1: k8s.CoreV1Api;
let appsV1: k8s.AppsV1Api;
let batchV1: k8s.BatchV1Api;
let networkingV1: k8s.NetworkingV1Api;
function getK8sClients() {
  if (!coreV1) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    batchV1 = kc.makeApiClient(k8s.BatchV1Api);
    networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
  }
  return { coreV1, appsV1, batchV1, networkingV1 };
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

/** Wrap a delete call: success → 'deleted', 404 → 'absent', else propagate. */
async function tryDelete(
  del: () => Promise<unknown>,
): Promise<'deleted' | 'absent'> {
  try {
    await del();
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

const tryDeleteDeployment = (name: string) =>
  tryDelete(() =>
    getK8sClients().appsV1.deleteNamespacedDeployment({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteServiceAccount = (name: string) =>
  tryDelete(() =>
    getK8sClients().coreV1.deleteNamespacedServiceAccount({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteService = (name: string) =>
  tryDelete(() =>
    getK8sClients().coreV1.deleteNamespacedService({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteNetworkPolicy = (name: string) =>
  tryDelete(() =>
    getK8sClients().networkingV1.deleteNamespacedNetworkPolicy({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteSecret = (name: string) =>
  tryDelete(() =>
    getK8sClients().coreV1.deleteNamespacedSecret({ name, namespace: NAMESPACE }),
  );
const tryDeletePvc = (name: string) =>
  tryDelete(() =>
    getK8sClients().coreV1.deleteNamespacedPersistentVolumeClaim({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteJob = (name: string) =>
  tryDelete(() =>
    getK8sClients().batchV1.deleteNamespacedJob({ name, namespace: NAMESPACE }),
  );

/** Escape regex metacharacters (instance names are validated [a-z0-9-], but be safe). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * List the instance's PVC names by precise name match (the install paths do not
 * label PVCs consistently). Matches `kubeclaw-channel-<instance>-<suffix>` where
 * suffix is groups/store/sessions/runtime, optionally with an upgrade version
 * (`-runtime-v<N>`). Anchored so `http` does NOT match `http-staging` resources.
 */
async function listInstancePvcNames(instanceName: string): Promise<string[]> {
  const { coreV1 } = getK8sClients();
  const result = await coreV1.listNamespacedPersistentVolumeClaim({
    namespace: NAMESPACE,
  });
  const re = new RegExp(
    `^kubeclaw-channel-${escapeRegex(instanceName)}-(groups|store|sessions|runtime)(-v\\d+)?$`,
  );
  return (result.items ?? [])
    .map((pvc) => pvc.metadata?.name)
    .filter((n): n is string => typeof n === 'string')
    .filter((n) => re.test(n));
}

/**
 * Remove all K8s resources associated with a channel instance.
 * Idempotent: treats 404 as success. Deletes the Deployment first (releases the
 * pod's hold on the PVCs/Secret) then the remaining resources.
 */
export async function removeChannel(
  instanceName: string,
): Promise<ChannelRemoveResult> {
  const base = `kubeclaw-channel-${instanceName}`;

  const deleted: string[] = [];
  const alreadyAbsent: string[] = [];
  function record(name: string, outcome: 'deleted' | 'absent'): void {
    if (outcome === 'deleted') deleted.push(name);
    else alreadyAbsent.push(name);
  }

  // 1. Deployment first — stops the pod so it releases its PVCs/Secret mounts.
  record(base, await tryDeleteDeployment(base));

  // 2. ServiceAccount (Helm-created).
  record(base, await tryDeleteServiceAccount(base));

  // 3. Services: the channel Service (httpPort) + the Helm metrics Service.
  for (const svc of [base, `${base}-metrics`]) {
    record(svc, await tryDeleteService(svc));
  }

  // 4. Ingress NetworkPolicy (httpPort channels).
  record(`${base}-ingress`, await tryDeleteNetworkPolicy(`${base}-ingress`));

  // 5. Secrets — cover all three naming conventions:
  //    Helm user secret, bootstrap credentials, legacy setup_channel.
  for (const sec of [
    base,
    `${base}-credentials`,
    `kubeclaw-${instanceName}-secrets`,
  ]) {
    record(sec, await tryDeleteSecret(sec));
  }

  // 6. PVCs — groups/store/sessions/runtime (+ versioned runtime), by precise name.
  const pvcNames = await listInstancePvcNames(instanceName);
  for (const pvcName of pvcNames) {
    record(pvcName, await tryDeletePvc(pvcName));
  }

  // 7. In-progress bootstrap Job.
  const bootstrapJob = `kubeclaw-bootstrap-${instanceName}`;
  record(bootstrapJob, await tryDeleteJob(bootstrapJob));

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
