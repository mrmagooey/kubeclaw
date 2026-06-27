import type { EgressRule } from '../../tools/types.js';

export function buildIstioEgressObjects(args: {
  name: string;
  namespace: string;
  jobLabel: string;
  allowedEgress: EgressRule[];
  ownerRef?: { name: string; uid: string };
}): object[] {
  const hostsForSidecar = [
    './*',
    'istio-system/*',
    ...args.allowedEgress.map((r) => `${args.namespace}/${r.host}`),
  ];

  const ownerReferences = args.ownerRef
    ? [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: args.ownerRef.name,
          uid: args.ownerRef.uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ]
    : undefined;

  const sidecar = {
    apiVersion: 'networking.istio.io/v1',
    kind: 'Sidecar',
    metadata: {
      name: `${args.name}-egress`,
      namespace: args.namespace,
      ...(ownerReferences && { ownerReferences }),
    },
    spec: {
      workloadSelector: { labels: { 'kubeclaw/agent-job': args.jobLabel } },
      egress: [{ hosts: hostsForSidecar }],
    },
  };

  const serviceEntries = args.allowedEgress.map((r) => ({
    apiVersion: 'networking.istio.io/v1',
    kind: 'ServiceEntry',
    metadata: {
      name: `${args.name}-${r.host.replace(/\./g, '-')}`,
      namespace: args.namespace,
      ...(ownerReferences && { ownerReferences }),
    },
    spec: {
      hosts: [r.host],
      ports: (r.ports?.length ? r.ports : [443]).map((p) => ({
        number: p,
        name: `tls-${p}`,
        protocol: 'TLS',
      })),
      location: 'MESH_EXTERNAL',
      resolution: 'DNS',
    },
  }));

  return [sidecar, ...serviceEntries];
}
