import type { EgressRule } from '../../tools/types.js';

export function buildCiliumEgressPolicy(args: {
  name: string;
  namespace: string;
  jobLabel: string;
  allowedEgress: EgressRule[];
  redisNamespace: string;
  ownerRef?: { name: string; uid: string };
}): object {
  const egress: object[] = [
    {
      toEndpoints: [
        {
          matchLabels: {
            'k8s:io.kubernetes.pod.namespace': 'kube-system',
            'k8s-app': 'kube-dns',
          },
        },
      ],
      toPorts: [
        {
          ports: [
            { port: '53', protocol: 'UDP' },
            { port: '53', protocol: 'TCP' },
          ],
        },
      ],
    },
    {
      toEndpoints: [
        {
          matchLabels: {
            'k8s:io.kubernetes.pod.namespace': args.redisNamespace,
            app: 'kubeclaw-redis',
          },
        },
      ],
      toPorts: [{ ports: [{ port: '6379', protocol: 'TCP' }] }],
    },
  ];

  if (args.allowedEgress.length > 0) {
    const ports = new Set<number>();
    for (const r of args.allowedEgress)
      for (const p of (r.ports?.length ? r.ports : [443])) ports.add(p);
    egress.push({
      toFQDNs: args.allowedEgress.map((r) => ({ matchName: r.host })),
      toPorts: [
        {
          ports: [...ports].map((p) => ({ port: String(p), protocol: 'TCP' })),
        },
      ],
    });
  }

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

  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      ...(ownerReferences && { ownerReferences }),
    },
    spec: {
      endpointSelector: {
        matchLabels: { 'kubeclaw/agent-job': args.jobLabel },
      },
      egress,
    },
  };
}
