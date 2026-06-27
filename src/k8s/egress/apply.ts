import type { EgressRule } from '../../tools/types.js';
import type { EgressSubstrate } from './substrate.js';
import { buildCiliumEgressPolicy } from './cilium-policy.js';
import { buildIstioEgressObjects } from './istio-policy.js';

export interface CustomObjectsClient {
  create(group: string, version: string, namespace: string, plural: string, body: object): Promise<void>;
  delete(group: string, version: string, namespace: string, plural: string, name: string): Promise<void>;
}

export interface EgressApplier {
  applyForJob(args: { jobName: string; jobLabel: string; namespace: string; allowedEgress: EgressRule[] }): Promise<void>;
  deleteForJob(args: { jobName: string; namespace: string }): Promise<void>;
}

const CILIUM = { group: 'cilium.io', version: 'v2', plural: 'ciliumnetworkpolicies' };
const ISTIO = { group: 'networking.istio.io', version: 'v1' };

export function makeEgressApplier(deps: {
  substrate: EgressSubstrate;
  customObjects: CustomObjectsClient;
  redisNamespace: string;
}): EgressApplier {
  return {
    async applyForJob({ jobName, jobLabel, namespace, allowedEgress }) {
      if (deps.substrate === 'cilium') {
        const policy = buildCiliumEgressPolicy({
          name: `egress-${jobName}`, namespace, jobLabel, allowedEgress, redisNamespace: deps.redisNamespace,
        });
        await deps.customObjects.create(CILIUM.group, CILIUM.version, namespace, CILIUM.plural, policy);
      } else if (deps.substrate === 'istio') {
        const objs = buildIstioEgressObjects({ name: `egress-${jobName}`, namespace, jobLabel, allowedEgress });
        for (const o of objs) {
          const plural = (o as { kind: string }).kind === 'Sidecar' ? 'sidecars' : 'serviceentries';
          await deps.customObjects.create(ISTIO.group, ISTIO.version, namespace, plural, o);
        }
      }
      // 'none': no hard egress substrate; nothing to create.
    },

    async deleteForJob({ jobName, namespace }) {
      const name = `egress-${jobName}`;
      try {
        if (deps.substrate === 'cilium') {
          await deps.customObjects.delete(CILIUM.group, CILIUM.version, namespace, CILIUM.plural, name);
        } else if (deps.substrate === 'istio') {
          // Delete the Sidecar; ServiceEntries are GC'd via ownerReference set at create time (Task 9).
          await deps.customObjects.delete(ISTIO.group, ISTIO.version, namespace, 'sidecars', name);
        }
      } catch {
        // best-effort teardown; lingering pod-scoped policies are harmless
      }
    },
  };
}
