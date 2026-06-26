import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { getScope, validateScopeFields, resolveGroupCapability } from './types.js';
import { groupHash } from './hash.js';
import {
  renderDeployment,
  renderService,
  renderNetworkPolicy,
  instanceName,
  credsSecretName,
} from './k8s-objects.js';
import { renderPersistentVolumeClaim } from './pvc.js';
import { upsertInstance } from './db.js';
import { ensureGroupDbCredentials } from './provision-credentials.js';
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
      if (pvc)
        await args.client.applyPersistentVolumeClaim(args.namespace, pvc);

      // For capabilities that read credentials from a Secret, ensure the Secret
      // exists (empty placeholder) and then populate all required credential keys
      // BEFORE the Deployment is applied — a pinned pod must start with creds present.
      const resolved = resolveGroupCapability(spec);
      if (resolved.credentialsFrom === 'secret') {
        // Ensure the empty placeholder Secret exists first so the envFrom reference
        // is satisfied even if credential generation fails mid-flight.
        const secretName = credsSecretName(spec.name, hash);
        const existingSecret = await args.client.readSecret(args.namespace, secretName);
        if (!existingSecret) {
          await args.client.applySecret({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: secretName,
              namespace: args.namespace,
              labels: {
                'kubeclaw.io/scope': 'group',
                'kubeclaw.io/capability': spec.name,
                'kubeclaw.io/group-hash': hash,
                'kubeclaw.io/managed-by': 'kubeclaw-orchestrator',
              },
            },
            type: 'Opaque',
            data: {},
          });
        }
        // Provision all required credentials (idempotent).
        await ensureGroupDbCredentials({
          client: args.client,
          namespace: args.namespace,
          groupFolder,
          capabilityName: spec.name,
        });
      }

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
