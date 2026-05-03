import { describe, it, expect } from 'vitest';
import {
  workloadEnvForSidecar,
  ENV_HTTPS_PROXY,
  ENV_NODE_EXTRA_CA,
} from './workload-env.js';

describe('workloadEnvForSidecar', () => {
  it('produces HTTPS_PROXY pointing at localhost', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const proxy = env.find((e) => e.name === ENV_HTTPS_PROXY);
    expect(proxy?.value).toBe('http://127.0.0.1:8443');
  });

  it('produces NODE_EXTRA_CA_CERTS pointing at mount', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const ca = env.find((e) => e.name === ENV_NODE_EXTRA_CA);
    expect(ca?.value).toBe('/etc/ssl/certs/kubeclaw-egress-ca.crt');
  });

  it('emits exactly 5 env entries with both CA vars pointing at the same path', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    expect(env).toHaveLength(5);
    const ca = env.find((e) => e.name === 'NODE_EXTRA_CA_CERTS')?.value;
    const ssl = env.find((e) => e.name === 'SSL_CERT_FILE')?.value;
    expect(ca).toBe(ssl);
  });
});
