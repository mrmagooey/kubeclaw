import type { EgressRule } from '../../tools/types.js';

export function buildIstioEgressObjects(args: {
  name: string;
  namespace: string;
  jobLabel: string;
  allowedEgress: EgressRule[];
}): object[] {
  const hostsForSidecar = ['./*', 'istio-system/*', ...args.allowedEgress.map((r) => `${args.namespace}/${r.host}`)];

  const sidecar = {
    apiVersion: 'networking.istio.io/v1',
    kind: 'Sidecar',
    metadata: { name: `${args.name}-egress`, namespace: args.namespace },
    spec: {
      workloadSelector: { labels: { 'kubeclaw/agent-job': args.jobLabel } },
      egress: [{ hosts: hostsForSidecar }],
    },
  };

  const serviceEntries = args.allowedEgress.map((r) => ({
    apiVersion: 'networking.istio.io/v1',
    kind: 'ServiceEntry',
    metadata: { name: `${args.name}-${r.host.replace(/\./g, '-')}`, namespace: args.namespace },
    spec: {
      hosts: [r.host],
      ports: (r.ports ?? [443]).map((p) => ({ number: p, name: `tls-${p}`, protocol: 'TLS' })),
      location: 'MESH_EXTERNAL',
      resolution: 'DNS',
    },
  }));

  return [sidecar, ...serviceEntries];
}
