import type { V1PersistentVolumeClaim } from '@kubernetes/client-node';
import type { CapabilitySpec } from '../capabilities/types.js';
import { instanceName, commonLabels, type RenderContext } from './k8s-objects.js';

export function pvcName(capabilityName: string, groupHash: string): string {
  return `${instanceName(capabilityName, groupHash)}-data`;
}

/**
 * Dedicated per-group PVC for a stateful capability (e.g. Postgres). Returns
 * null when the spec declares no storage. RWO + retain annotation so group GC
 * does not destroy the data (see gc.ts; manual cleanup is intentional).
 */
export function renderPersistentVolumeClaim(
  spec: CapabilitySpec,
  ctx: RenderContext,
): V1PersistentVolumeClaim | null {
  if (!spec.storage) return null;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName(spec.name, ctx.groupHash),
      namespace: ctx.namespace,
      labels: commonLabels(spec, ctx),
      annotations: { 'kubeclaw.io/retain': 'true' },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: `${spec.storage.sizeGi}Gi` } },
    },
  };
}
