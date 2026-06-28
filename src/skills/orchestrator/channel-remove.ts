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
 *   - Ingress         kubeclaw-channel-<instance>            (Helm, ingress.enabled)
 *   - NetworkPolicy   kubeclaw-channel-<instance>-ingress    (httpPort channels)
 *   - Secret          kubeclaw-channel-<instance>            (Helm user secret)
 *   - Secret          kubeclaw-channel-<instance>-credentials (bootstrap)
 *   - Secret          kubeclaw-<instance>-secrets            (legacy setup_channel)
 *   - PVCs            kubeclaw-channel-<instance>-{groups,store,sessions,runtime}
 *                     plus versioned runtime PVCs (…-runtime-v<N>) from upgrades
 *   - Jobs            kubeclaw-bootstrap-<instance>[-upgrade] (bootstrap/upgrade)
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
  /** `<kind>/<name>: <reason>` for resources that could not be deleted. */
  failed: string[];
  summary: string;
}

type DeleteOutcome =
  | { status: 'deleted' }
  | { status: 'absent' }
  | { status: 'failed'; error: string };

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

/**
 * Wrap a delete call. Best-effort: success → 'deleted', 404 → 'absent', any
 * other error → 'failed' (captured, NOT thrown) so one resource's failure
 * (e.g. a 403 RBAC gap) does not abort the cleanup of the rest.
 */
async function tryDelete(del: () => Promise<unknown>): Promise<DeleteOutcome> {
  try {
    await del();
    return { status: 'deleted' };
  } catch (err) {
    if (isNotFound(err)) return { status: 'absent' };
    const raw = err instanceof Error ? err.message : String(err);
    // ApiException messages are multi-line; keep the first line + status code.
    const e = err as { code?: number; statusCode?: number };
    const code = e?.code ?? e?.statusCode;
    const first = raw.split('\n')[0];
    return { status: 'failed', error: code ? `${code} ${first}` : first };
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
const tryDeleteIngress = (name: string) =>
  tryDelete(() =>
    getK8sClients().networkingV1.deleteNamespacedIngress({
      name,
      namespace: NAMESPACE,
    }),
  );
const tryDeleteSecret = (name: string) =>
  tryDelete(() =>
    getK8sClients().coreV1.deleteNamespacedSecret({
      name,
      namespace: NAMESPACE,
    }),
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
    `^kubeclaw-channel-${escapeRegex(instanceName)}-(groups|store|sessions|runtime|auxsession)(-v\\d+)?$`,
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
  const failed: string[] = [];
  function record(name: string, outcome: DeleteOutcome): void {
    if (outcome.status === 'deleted') deleted.push(name);
    else if (outcome.status === 'absent') alreadyAbsent.push(name);
    else failed.push(`${name}: ${outcome.error}`);
  }

  // Resources are recorded as `<kind>/<name>` because several share the same
  // name (Deployment/ServiceAccount/Service/Secret/Ingress are all `<base>`).

  // 1. Deployment first — stops the pod so it releases its PVCs/Secret mounts.
  record(`deployment/${base}`, await tryDeleteDeployment(base));

  // 2. ServiceAccount (Helm-created).
  record(`serviceaccount/${base}`, await tryDeleteServiceAccount(base));

  // 3. Services: the channel Service (httpPort) + the Helm metrics Service.
  for (const svc of [base, `${base}-metrics`]) {
    record(`service/${svc}`, await tryDeleteService(svc));
  }

  // 4. Ingress + ingress NetworkPolicy (httpPort channels). The Helm Ingress is
  //    named `<base>` (channel-pods.yaml, gated on $cfg.ingress.enabled) — a
  //    stale one would keep routing external traffic, so it must go.
  record(`ingress/${base}`, await tryDeleteIngress(base));
  record(
    `networkpolicy/${base}-ingress`,
    await tryDeleteNetworkPolicy(`${base}-ingress`),
  );
  // Sidecar-egress NetworkPolicy (rendered by networkpolicies.yaml when the
  // channel manifest declares a sidecar with egressPorts). Not all channels have
  // this — tryDelete treats 404 as already-absent.
  record(
    `networkpolicy/${base}-sidecar-egress`,
    await tryDeleteNetworkPolicy(`${base}-sidecar-egress`),
  );

  // 5. Secrets — cover all three naming conventions:
  //    Helm user secret, bootstrap credentials, legacy setup_channel.
  for (const sec of [
    base,
    `${base}-credentials`,
    `kubeclaw-${instanceName}-secrets`,
  ]) {
    record(`secret/${sec}`, await tryDeleteSecret(sec));
  }

  // 6. PVCs — groups/store/sessions/runtime (+ versioned runtime), by precise name.
  try {
    const pvcNames = await listInstancePvcNames(instanceName);
    for (const pvcName of pvcNames) {
      record(`persistentvolumeclaim/${pvcName}`, await tryDeletePvc(pvcName));
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    failed.push(`persistentvolumeclaims (list): ${raw.split('\n')[0]}`);
  }

  // 7. Bootstrap Jobs — the initial bootstrap Job and the upgrade Job (both
  //    have a finished-TTL, but remove them deterministically rather than wait).
  for (const job of [
    `kubeclaw-bootstrap-${instanceName}`,
    `kubeclaw-bootstrap-${instanceName}-upgrade`,
  ]) {
    record(`job/${job}`, await tryDeleteJob(job));
  }

  const deletedLines =
    deleted.length > 0
      ? `Deleted:\n${deleted.map((n) => `  - ${n}`).join('\n')}`
      : 'Nothing deleted.';
  const absentLines =
    alreadyAbsent.length > 0
      ? `Already absent:\n${alreadyAbsent.map((n) => `  - ${n}`).join('\n')}`
      : '';
  const failedLines =
    failed.length > 0
      ? `FAILED (could not delete):\n${failed.map((n) => `  - ${n}`).join('\n')}`
      : '';

  const summary = [deletedLines, absentLines, failedLines]
    .filter(Boolean)
    .join('\n');

  return { deleted, alreadyAbsent, failed, summary };
}
