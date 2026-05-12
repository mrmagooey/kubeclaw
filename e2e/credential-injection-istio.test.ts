/**
 * e2e tests for credentialInjection.mode=istio on a kind cluster with Istio.
 *
 * Prerequisites (handled by the GitHub Actions workflow / local setup script):
 *   - kind cluster running with Istio 1.24.x installed (profile=minimal)
 *   - kubectl context pointing at the kind cluster
 *   - helm 3.x on PATH
 *
 * Run time: ~8 minutes (after cluster + Istio are up).
 *
 * Triggered via: .github/workflows/e2e-istio.yml (label e2e:istio or nightly).
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { execSync } from 'child_process';

const NS = 'kubeclaw';
const TIMEOUT_MS = 8 * 60 * 1000;

function k(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(`kubectl -n ${NS} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.allowFail) return e.stdout?.trim() ?? '';
    throw e;
  }
}

function helm(args: string): string {
  return execSync(`helm ${args}`, { encoding: 'utf8' }).trim();
}

describe('credential-injection mode=istio e2e', { timeout: TIMEOUT_MS }, () => {
  beforeAll(() => {
    helm(
      [
        'upgrade --install kubeclaw helm/kubeclaw',
        '--namespace kubeclaw --create-namespace',
        '--set credentialInjection.mode=istio',
        '--set credentialInjection.istio.gateway.replicas=1',
        '--set image.tag=e2e-test',
        '--wait --timeout 5m',
      ].join(' '),
    );
  });

  afterAll(() => {
    execSync('helm uninstall kubeclaw --namespace kubeclaw', {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    execSync('kubectl delete namespace kubeclaw --wait=false', {
      encoding: 'utf8',
      stdio: 'inherit',
    });
  });

  it('egress gateway deployment is running', () => {
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-istio-egressgateway --timeout=120s`,
      { stdio: 'inherit' },
    );
    const ready = k(
      `get deployment kubeclaw-istio-egressgateway -o jsonpath='{.status.readyReplicas}'`,
    );
    expect(parseInt(ready, 10)).toBeGreaterThanOrEqual(1);
  });

  it('credential broker deployment is running', () => {
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-credential-broker --timeout=120s`,
      { stdio: 'inherit' },
    );
  });

  it('kubeclaw namespace has istio-injection=enabled label', () => {
    const label = execSync(
      `kubectl get namespace ${NS} -o jsonpath='{.metadata.labels.istio-injection}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(label).toBe('enabled');
  });

  it('orchestrator pod has sidecar.istio.io/inject=false annotation', () => {
    const annotation = k(
      `get pod -l app=kubeclaw-orchestrator -o jsonpath='{.items[0].metadata.annotations.sidecar\\.istio\\.io/inject}'`,
    );
    expect(annotation).toBe('false');
  });

  it('orchestrator pod does NOT have an istio-proxy container', () => {
    const containers = k(
      `get pod -l app=kubeclaw-orchestrator -o jsonpath='{.items[0].spec.containers[*].name}'`,
    );
    expect(containers).not.toContain('istio-proxy');
  });

  it('Sidecar resource is applied', () => {
    const sidecars = execSync(
      `kubectl -n ${NS} get sidecar -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(sidecars).toContain('kubeclaw-egress-restriction');
  });

  it('ServiceEntry resources exist for all built-in destinations', () => {
    const entries = execSync(
      `kubectl -n ${NS} get serviceentry -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf8' },
    ).trim();
    expect(entries).toContain('kubeclaw-egress-api-anthropic-com');
    expect(entries).toContain('kubeclaw-egress-api-openai-com');
    expect(entries).toContain('kubeclaw-egress-openrouter-ai');
    expect(entries).toContain('kubeclaw-egress-api-voyageai-com');
  });
});
