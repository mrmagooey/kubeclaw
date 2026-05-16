import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const NS = 'kubeclaw-e2e-broker';
const RELEASE = 'ke2e-broker';

function k(args: string): string {
  return execSync(`kubectl --namespace ${NS} ${args}`, { encoding: 'utf8' });
}

/**
 * Build the credential-broker image from the current worktree so that it
 * includes Task 0.9's KUBECLAW_MODE=credential-broker dispatcher, which may
 * not be present in the cluster's existing kubeclaw-orchestrator:latest image
 * (built before the feature branch code was merged).
 *
 * Uses a non-latest tag so Kubernetes defaults to imagePullPolicy IfNotPresent
 * rather than Always (which would fail for a local-only image with no registry).
 *
 * Returns the image reference, e.g. "kubeclaw-orchestrator:e2e-broker"
 */
function buildBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-broker';
  const profileFlag = process.env.KUBECLAW_MINIKUBE_PROFILE
    ? `-p ${process.env.KUBECLAW_MINIKUBE_PROFILE}`
    : '';
  execSync(
    `eval $(minikube ${profileFlag} docker-env) && docker build -t ${tag} .`,
    { encoding: 'utf8', shell: '/bin/bash', stdio: 'inherit' },
  );
  return tag;
}

describe('credential-broker e2e', () => {
  beforeAll(() => {
    // Wait for the namespace to be fully gone if it's still terminating from a
    // previous run, then create it fresh.
    execSync(
      `kubectl wait --for=delete ns/${NS} --timeout=60s 2>/dev/null || true`,
    );
    execSync(`kubectl create ns ${NS} || true`);

    // Create kubeclaw-secrets so the Role's resourceName grant has something to find.
    // Values are placeholders — broker doesn't validate them.
    execSync(
      `kubectl -n ${NS} create secret generic kubeclaw-secrets ` +
        `--from-literal=anthropic-api-key=sk-ant-test ` +
        `--from-literal=openai-api-key=sk-test ` +
        `--from-literal=openrouter-api-key=or-test ` +
        `--from-literal=voyage-api-key=v-test ` +
        `--dry-run=client -o yaml | kubectl apply -f -`,
    );

    const image = buildBrokerImage();

    execSync(
      `helm upgrade --install ${RELEASE} ./helm/kubeclaw -n ${NS} ` +
        `--set namespace=${NS} ` +
        `--set credentialInjection.mode=sidecar ` +
        `--set credentialInjection.internalCA.autoProvision=false ` +
        `--set credentialInjection.broker.image=${image} ` +
        `--set secrets.existingSecret=kubeclaw-secrets ` +
        `--set orchestrator.admin.enabled=false ` +
        `--wait --timeout 3m`,
      { stdio: 'inherit' },
    );
  }, 240_000);

  afterAll(() => {
    execSync(`helm uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`);
    execSync(`kubectl delete ns ${NS} --wait=false 2>/dev/null || true`);
  }, 60_000);

  it('broker pod is Ready', () => {
    const out = k(
      'get deploy kubeclaw-credential-broker -o jsonpath={.status.readyReplicas}',
    );
    expect(out.trim()).toBe('1');
  });

  it('/authz returns 401 without Bearer token', () => {
    const out = k(
      `run probe-no-auth --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- ` +
        `curl -sS -o /dev/null -w "%{http_code}" -X POST ` +
        `http://credential-broker.${NS}.svc:8080/authz ` +
        `-H "X-Forwarded-Authority: api.anthropic.com"`,
    );
    // kubectl run --rm outputs the pod deletion message on stdout after the
    // curl output (e.g. "401pod 'probe-no-auth' deleted ..."), so we check
    // that '401' appears in the output rather than endsWith.
    expect(out).toContain('401');
  }, 60_000);
});
