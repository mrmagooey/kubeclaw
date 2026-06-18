export const ENV_HTTPS_PROXY = 'HTTPS_PROXY';
export const ENV_HTTP_PROXY = 'HTTP_PROXY';
export const ENV_NO_PROXY = 'NO_PROXY';
export const ENV_NODE_EXTRA_CA = 'NODE_EXTRA_CA_CERTS';
export const ENV_SSL_CERT_FILE = 'SSL_CERT_FILE';

export interface SidecarEnvOpts {
  port: number;
}

export function workloadEnvForSidecar(
  opts: SidecarEnvOpts,
): Array<{ name: string; value: string }> {
  const proxy = `http://127.0.0.1:${opts.port}`;
  return [
    { name: ENV_HTTPS_PROXY, value: proxy },
    { name: ENV_HTTP_PROXY, value: proxy },
    {
      // keep in sync with helm/kubeclaw/templates/_helpers.tpl kubeclaw.credentialSidecarEnv
      name: ENV_NO_PROXY,
      value:
        'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,.svc,.svc.cluster.local,.cluster.local',
    },
    { name: ENV_NODE_EXTRA_CA, value: '/etc/ssl/certs/kubeclaw-egress-ca.crt' },
    { name: ENV_SSL_CERT_FILE, value: '/etc/ssl/certs/kubeclaw-egress-ca.crt' },
  ];
}
