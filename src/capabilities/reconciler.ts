import { KUBECLAW_NAMESPACE } from '../config.js';
import { jobRunner } from '../k8s/job-runner.js';
import { logger } from '../logger.js';
import { buildYaml } from './builders/index.js';
import { deploymentName } from './builders/common.js';
import type { CapabilitySpec } from './types.js';

/**
 * Apply (create or replace) a capability's K8s resources.
 */
export async function applySpec(spec: CapabilitySpec): Promise<void> {
  const yaml = buildYaml(spec);
  await jobRunner.applyYamlToK8s(yaml);
  logger.info(
    { name: spec.name, kind: spec.kind },
    'Capability resources applied',
  );
}

/**
 * Delete a capability's K8s resources. Idempotent.
 */
export async function deleteSpec(spec: CapabilitySpec): Promise<void> {
  const dep = deploymentName(spec.name);
  // All capability resources live in KUBECLAW_NAMESPACE. If a future kind
  // ever supports cross-namespace deployment, derive `ns` from the spec.
  const ns = KUBECLAW_NAMESPACE;
  try {
    await jobRunner.deleteDeployment(dep, ns);
  } catch (err) {
    logger.warn({ err, dep, ns }, 'Failed to delete Deployment');
  }
  try {
    await jobRunner.deleteService(dep, ns);
  } catch (err) {
    logger.warn({ err, dep, ns }, 'Failed to delete Service');
  }
  // RAG kinds always render a PVC (the builders default storage when the spec
  // doesn't declare it); HTTP/MCP only when the spec explicitly declares it.
  const hasPvc = spec.kind === 'rag' || !!spec.storage;
  if (hasPvc) {
    try {
      await jobRunner.deletePersistentVolumeClaim(`${dep}-data`, ns);
    } catch (err) {
      logger.warn({ err, dep, ns }, 'Failed to delete PVC');
    }
  }
  logger.info({ name: spec.name, kind: spec.kind }, 'Capability removed');
}

/**
 * Reconcile DB-declared capabilities against Kubernetes on startup.
 */
export async function reconcileAllOnStartup(
  specs: CapabilitySpec[],
): Promise<void> {
  for (const spec of specs) {
    try {
      await applySpec(spec);
    } catch (err) {
      logger.error(
        { err, name: spec.name, kind: spec.kind },
        'Failed to reconcile capability on startup',
      );
    }
  }
}
