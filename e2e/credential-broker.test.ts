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
  // Re-tag the kubeclaw-orchestrator:latest image that global-setup built
  // into the minikube docker daemon. Avoids racing parallel `docker build`s
  // (cred-broker + cred-injection beforeAll run concurrently), which can
  // corrupt BuildKit's COPY layer and surface as spurious TS module-not-found
  // errors against files that actually exist on disk.
  execSync(
    `eval $(minikube ${profileFlag} docker-env) && ` +
      `docker tag kubeclaw-orchestrator:latest ${tag}`,
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

    // Install without --wait so helm does not block on the orchestrator
    // Deployment and Redis StatefulSet (which need PVC provisioning and
    // can take > 3 min on a shared minikube cluster). The broker itself
    // has no PVC dependencies and starts in seconds; we wait for it
    // explicitly below. orchestrator.replicas=0 prevents the orchestrator
    // pod from being scheduled at all, keeping the test namespace lean.
    execSync(
      `helm upgrade --install ${RELEASE} ./helm/kubeclaw -n ${NS} ` +
        `--set namespace=${NS} ` +
        `--set credentialInjection.mode=sidecar ` +
        `--set credentialInjection.internalCA.autoProvision=false ` +
        `--set credentialInjection.broker.image=${image} ` +
        `--set secrets.existingSecret=kubeclaw-secrets ` +
        `--set orchestrator.admin.enabled=false ` +
        `--set orchestrator.replicas=0`,
      { stdio: 'inherit' },
    );

    // Wait only for the credential broker — it is the sole subject of this
    // test suite. The orchestrator and Redis are not exercised here.
    execSync(
      `kubectl rollout status deployment/kubeclaw-credential-broker -n ${NS} --timeout=120s`,
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
