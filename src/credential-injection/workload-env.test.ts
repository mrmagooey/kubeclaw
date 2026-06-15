import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import {
  workloadEnvForSidecar,
  ENV_HTTPS_PROXY,
  ENV_NO_PROXY,
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

  it('NO_PROXY includes kubeclaw-redis', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).toContain('kubeclaw-redis');
  });

  it('NO_PROXY includes kubeclaw-credential-broker', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).toContain('kubeclaw-credential-broker');
  });

  it('NO_PROXY includes ollama', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).toContain('ollama');
  });

  it('NO_PROXY includes kubeclaw-qdrant', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).toContain('kubeclaw-qdrant');
  });

  it('NO_PROXY includes .svc.cluster.local', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).toContain('.svc.cluster.local');
  });
});

describe('helm chart NO_PROXY parity', () => {
  it('helm template renders the same NO_PROXY value as workloadEnvForSidecar', () => {
    // Enable an HTTP channel so channel-pods.yaml renders and includes credentialSidecarEnv.
    const rendered = execSync(
      'helm template helm/kubeclaw --set channels.http.enabled=true',
      { cwd: '/home/peter/projects/kubeclaw/.claude/worktrees/feat-llm-credential-broker', encoding: 'utf8' },
    );
    const expectedNoProxy =
      'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,kubeclaw-qdrant,.svc,.svc.cluster.local,.cluster.local';
    expect(rendered).toContain(expectedNoProxy);

    // Verify the TS constant matches too
    const env = workloadEnvForSidecar({ port: 8443 });
    const tsNoProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value;
    expect(tsNoProxy).toBe(expectedNoProxy);
  });
});
