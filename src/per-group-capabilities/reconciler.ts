import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { getScope, validateScopeFields } from './types.js';
import { groupHash } from './hash.js';
import {
  renderDeployment,
  renderService,
  renderNetworkPolicy,
  instanceName,
} from './k8s-objects.js';
import { renderPersistentVolumeClaim } from './pvc.js';
import { upsertInstance } from './db.js';
import { logger } from '../logger.js';

export interface ReconcileArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupsPvcName: string;
  groups: string[];
  specs: CapabilitySpec[];
}

// v1 scope: reconciler is apply-only. The spec mentions periodic reconcile
// healing orphaned K8s objects whose group has been deleted (crash-mid-GC
// recovery); that's not implemented in v1. The group-delete GC cascade
// (`gcGroup`) is best-effort but doesn't have a periodic safety net beyond
// re-running it manually. Future v2 work could add an orphan sweeper that
// compares K8s objects' `kubeclaw.io/group-hash` against current SQLite groups.
export async function reconcileGroupCapabilities(
  args: ReconcileArgs,
): Promise<void> {
  const groupSpecs = args.specs.filter((s) => getScope(s) === 'group');
  for (const spec of groupSpecs) validateScopeFields(spec);

  const desired: {
    spec: CapabilitySpec;
    groupFolder: string;
    groupHash: string;
  }[] = [];
  for (const groupFolder of args.groups) {
    const hash = groupHash(groupFolder);
    for (const spec of groupSpecs) {
      desired.push({ spec, groupFolder, groupHash: hash });
    }
  }

  let errors = 0;
  for (const { spec, groupFolder, groupHash: hash } of desired) {
    try {
      const ctx = {
        groupFolder,
        groupHash: hash,
        namespace: args.namespace,
        groupsPvcName: args.groupsPvcName,
      };
      await args.client.applyNetworkPolicy(renderNetworkPolicy(spec, ctx));
      await args.client.applyService(renderService(spec, ctx));
      const pvc = renderPersistentVolumeClaim(spec, ctx);
      if (pvc) await args.client.applyPersistentVolumeClaim(args.namespace, pvc);
      await args.client.applyDeployment(renderDeployment(spec, ctx));
      const name = instanceName(spec.name, hash);
      upsertInstance({
        groupFolder,
        capabilityName: spec.name,
        groupHash: hash,
        deploymentName: name,
        serviceName: name,
      });
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, groupFolder, capability: spec.name },
        'per-group capability reconcile failed for pair',
      );
    }
  }

  logger.info(
    { desired_count: desired.length, errors },
    'per-group capability reconcile complete',
  );
}
