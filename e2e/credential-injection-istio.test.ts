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
        '--set credentialInjection.istio.testFixture.enabled=true',
        '--set image.tag=e2e-test',
        '--wait --timeout 5m',
      ].join(' '),
    );
    execSync(
      `kubectl -n ${NS} rollout status deployment/kubeclaw-mock-upstream --timeout=120s`,
      { stdio: 'inherit' },
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

  it('tool-job egress is broker-stamped end-to-end', () => {
    const probeName = 'kubeclaw-egress-probe';
    // Clean any stale probe from a previous test run.
    execSync(`kubectl -n ${NS} delete pod ${probeName} --ignore-not-found --wait=true`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const overrides = JSON.stringify({
      spec: { serviceAccountName: 'kubeclaw-tool-job' },
    });
    // NB: each line is joined with "; " and embedded inside an outer
    // sh -c '...' single-quoted string in kubectl run. Do NOT use
    // single-quotes inside these lines — they will terminate the outer
    // quoting and break the spawned shell.
    const script = [
      'set -e',
      'resp=$(curl -sS -H "Authorization: Bearer placeholder" http://mock-upstream.kubeclaw-test/echo)',
      'echo RESPONSE_BEGIN',
      'echo "$resp"',
      'echo RESPONSE_END',
      // Tell the istio-proxy sidecar to exit so the pod can reach Succeeded.
      'curl -sS -X POST http://localhost:15020/quitquitquit || true',
    ].join('; ');

    execSync(
      `kubectl run ${probeName} -n ${NS} \
        --image=curlimages/curl:8.10.1 \
        --restart=Never \
        --overrides='${overrides}' \
        --command -- sh -c '${script}'`,
      { stdio: 'inherit' },
    );

    // Poll for the pod to reach Succeeded or Failed; cap at 60s.
    let phase = '';
    for (let i = 0; i < 60; i++) {
      phase = execSync(
        `kubectl -n ${NS} get pod ${probeName} -o jsonpath='{.status.phase}'`,
        { encoding: 'utf8' },
      ).trim();
      if (phase === 'Succeeded' || phase === 'Failed') break;
      execSync('sleep 1');
    }
    expect(phase, 'probe pod reached terminal phase').toMatch(/^(Succeeded|Failed)$/);

    const logs = execSync(`kubectl -n ${NS} logs ${probeName}`, {
      encoding: 'utf8',
    });
    const begin = logs.indexOf('RESPONSE_BEGIN');
    const end = logs.indexOf('RESPONSE_END');
    expect(begin, 'probe response begin marker present').toBeGreaterThanOrEqual(0);
    expect(end, 'probe response end marker present').toBeGreaterThan(begin);
    const body = logs.slice(begin + 'RESPONSE_BEGIN'.length, end).trim();
    const parsed = JSON.parse(body);

    // Primary assertion: gateway overwrote the placeholder with the broker's value.
    const auth = parsed.headers?.authorization ?? parsed.headers?.Authorization;
    expect(auth, 'broker-stamped Authorization header arrived at mock').toBe(
      'Bearer test-token-12345',
    );

    // Secondary assertion: broker audit log records the expected fields.
    const brokerLogs = execSync(
      `kubectl -n ${NS} logs deployment/kubeclaw-credential-broker --since=120s`,
      { encoding: 'utf8' },
    );
    const auditLine = brokerLogs
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find(
        (j) =>
          j &&
          j.identity === 'sa/kubeclaw-tool-job' &&
          j.destination === 'mock-upstream.kubeclaw-test' &&
          j.mappingId === 'test-mock' &&
          j.status === 200,
      );
    expect(auditLine, 'broker audit line matches expected identity + destination + mapping').toBeDefined();

    // Cleanup.
    execSync(`kubectl -n ${NS} delete pod ${probeName} --wait=false`, {
      stdio: 'inherit',
    });
  });
});
