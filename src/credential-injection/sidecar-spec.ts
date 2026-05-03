export interface SidecarOpts {
  image: string;
  port: number;
}

export function sidecarContainerSpec(opts: SidecarOpts) {
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

export function sidecarVolumes() {
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

export function sidecarVolumeMounts() {
  return [
    { name: 'envoy-config', mountPath: '/etc/envoy', readOnly: true },
    { name: 'broker-token', mountPath: '/var/run/secrets/tokens', readOnly: true },
    { name: 'egress-ca', mountPath: '/etc/ssl/certs', readOnly: true },
  ];
}
