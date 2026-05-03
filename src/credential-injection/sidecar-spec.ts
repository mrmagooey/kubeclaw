/**
 * Pod-spec helpers for the credential-injection sidecar.
 *
 * The string constants below are CROSS-COMPONENT CONTRACTS — changing them
 * here without updating the corresponding Helm templates will silently break
 * the sidecar at runtime (mount fails / token rejected / cert not trusted):
 *
 *   - `kubeclaw-envoy-sidecar`  → must match ConfigMap in templates/envoy-sidecar-config.yaml
 *   - `kubeclaw-egress-ca-tls`  → must match Secret produced by templates/internal-ca.yaml
 *   - `kubeclaw-credential-broker` → must match BROKER_AUDIENCE in templates/credential-broker.yaml
 *   - `ca.crt` → cert-manager always emits this key in the Secret
 */

import type { V1Container, V1Volume, V1VolumeMount } from '@kubernetes/client-node';

export interface SidecarOpts {
  image: string;
  port: number;
}

export function sidecarContainerSpec(opts: SidecarOpts): V1Container {
  return {
    name: 'credential-sidecar',
    image: opts.image,
    args: ['-c', '/etc/envoy/envoy.yaml'],
    ports: [{ name: 'proxy', containerPort: opts.port }],
    volumeMounts: sidecarVolumeMounts(),
    resources: {
      requests: { cpu: '25m', memory: '32Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    },
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1337,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
  };
}

export function sidecarVolumes(): V1Volume[] {
  return [
    {
      name: 'envoy-config',
      configMap: { name: 'kubeclaw-envoy-sidecar' },
    },
    {
      name: 'broker-token',
      projected: {
        sources: [
          {
            serviceAccountToken: {
              audience: 'kubeclaw-credential-broker',
              expirationSeconds: 600,
              path: 'broker-token',
            },
          },
        ],
      },
    },
    {
      name: 'egress-ca',
      secret: {
        secretName: 'kubeclaw-egress-ca-tls',
        items: [{ key: 'ca.crt', path: 'kubeclaw-egress-ca.crt' }],
      },
    },
  ];
}

export function sidecarVolumeMounts(): V1VolumeMount[] {
  return [
    { name: 'envoy-config', mountPath: '/etc/envoy', readOnly: true },
    {
      name: 'broker-token',
      mountPath: '/var/run/secrets/tokens',
      readOnly: true,
    },
    { name: 'egress-ca', mountPath: '/etc/ssl/certs', readOnly: true },
  ];
}
