import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const NS = 'kubeclaw-e2e-injection';
const RELEASE = 'ke2e-inject';

function k(args: string): string {
  return execSync(`kubectl --namespace ${NS} ${args}`, { encoding: 'utf8' });
}

/**
 * Build the orchestrator image from the current worktree so that the
 * credential-broker entrypoint (KUBECLAW_MODE=credential-broker) is present.
 * Uses a distinct non-latest tag so kubelet uses IfNotPresent rather than Always.
 */
function buildBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-injection';
  execSync(
    `eval $(minikube -p kubeclaw docker-env) && docker build -t ${tag} .`,
    { encoding: 'utf8', shell: '/bin/bash', stdio: 'inherit' },
  );
  return tag;
}

/**
 * Create a self-signed CA certificate and store it as a TLS Secret named
 * kubeclaw-egress-ca-tls. Also patches in a ca.crt key so that the Envoy
 * egress-ca volume's items mapping (key: ca.crt) finds something to project.
 *
 * The cert is not actually used for TLS termination in this test — we skip
 * the Envoy sidecar container entirely — but kubelet refuses to start pods
 * that reference missing Secrets, so the Secret must exist.
 */
function createDummyCASecret() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-ca-'));
  try {
    execSync(
      `openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 ` +
        `-keyout ${tmp}/tls.key -out ${tmp}/tls.crt -days 1 ` +
        `-subj "/CN=kubeclaw-egress-ca-test"`,
      { stdio: 'pipe' },
    );
    // Create the TLS secret with standard tls.crt / tls.key keys.
    execSync(
      `kubectl -n ${NS} create secret tls kubeclaw-egress-ca-tls ` +
        `--cert=${tmp}/tls.crt --key=${tmp}/tls.key ` +
        `--dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'pipe' },
    );
    // Patch in the ca.crt key that the Envoy sidecar volume's items mapping
    // expects. cert-manager would populate this automatically; we do it manually.
    const crtB64 = execSync(`base64 -w0 ${tmp}/tls.crt`, {
      encoding: 'utf8',
    }).trim();
    const patchJson = JSON.stringify({ data: { 'ca.crt': crtB64 } });
    execSync(
      `kubectl -n ${NS} patch secret kubeclaw-egress-ca-tls --type=merge --patch '${patchJson}'`,
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('credential-injection sidecar mode (e2e)', () => {
  beforeAll(() => {
    // Wait for the namespace to be fully gone if it's still terminating from a
    // previous run, then create it fresh.
    execSync(
      `kubectl wait --for=delete ns/${NS} --timeout=60s 2>/dev/null || true`,
    );
    execSync(`kubectl create ns ${NS} || true`);

    // Create kubeclaw-secrets so the Role's resourceName grant has something to
    // find. Values are placeholders — the broker doesn't validate them.
    execSync(
      `kubectl -n ${NS} create secret generic kubeclaw-secrets ` +
        `--from-literal=anthropic-api-key=sk-ant-test ` +
        `--from-literal=openai-api-key=sk-test ` +
        `--from-literal=openrouter-api-key=or-test ` +
        `--from-literal=voyage-api-key=v-test ` +
        `--dry-run=client -o yaml | kubectl apply -f -`,
    );

    createDummyCASecret();

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
  }, 300_000);

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

  it('kubeclaw-tool-job ServiceAccount exists (created by Helm)', () => {
    // The per-tier SA is what job-runner.ts assigns to tool-job pods.
    // Its absence would cause pods to fail with "serviceaccount not found".
    const out = k('get serviceaccount kubeclaw-tool-job -o jsonpath={.metadata.name}');
    expect(out.trim()).toBe('kubeclaw-tool-job');
  });

  it('a tool-job-shape pod has NO API key env vars and HTTPS_PROXY is set', () => {
    // This synthetic pod mirrors the structure that job-runner.ts produces in
    // sidecar mode: serviceAccountName=kubeclaw-tool-job, HTTPS_PROXY set,
    // NODE_EXTRA_CA_CERTS set, and NO API key environment variables.
    //
    // We intentionally omit the Envoy sidecar container from this pod —
    // the env contract test does not depend on Envoy being up. The unit tests
    // in src/k8s/job-runner.test.ts verify the sidecar container is included
    // in the generated manifest; the e2e here validates that the env shape
    // actually works in a real cluster with the Helm-created SA.
    const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: probe-env
  labels:
    app: kubeclaw-tool-pod
spec:
  serviceAccountName: kubeclaw-tool-job
  restartPolicy: Never
  containers:
    - name: probe
      image: alpine:3.20
      command: ["sh", "-c"]
      args:
        - |
          set -e
          echo "=== ENV CHECK ==="
          if env | grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|VOYAGE_API_KEY)='; then
            echo "FAIL_LEAKED_API_KEYS"
            exit 1
          fi
          echo "PASS_NO_KEYS"
          if [ -n "$HTTPS_PROXY" ]; then
            echo "PASS_HTTPS_PROXY"
          else
            echo "FAIL_NO_HTTPS_PROXY"
            exit 1
          fi
          sleep 3
      env:
        - { name: HTTPS_PROXY, value: "http://127.0.0.1:8443" }
        - { name: NODE_EXTRA_CA_CERTS, value: "/etc/ssl/certs/kubeclaw-egress-ca.crt" }
`;
    // Write the pod YAML to a temp file to avoid shell-escaping hazards.
    const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-pod-'));
    const podFile = path.join(tmp, 'pod.yaml');
    try {
      writeFileSync(podFile, podYaml);
      execSync(`kubectl -n ${NS} apply -f ${podFile}`, { stdio: 'pipe' });
      execSync(
        `kubectl -n ${NS} wait --for=condition=Ready pod/probe-env --timeout=60s`,
        { stdio: 'pipe' },
      );
      const logs = k('logs probe-env -c probe');
      expect(logs).toContain('PASS_NO_KEYS');
      expect(logs).toContain('PASS_HTTPS_PROXY');
      expect(logs).not.toContain('FAIL');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      k('delete pod probe-env --wait=false 2>/dev/null || true');
    }
  }, 120_000);

  it('/authz returns 401 on unauthenticated call (broker reachable from namespace)', () => {
    // Confirms the broker Service is reachable from within the namespace and
    // correctly rejects requests that carry no Bearer token.
    const out = k(
      `run probe-broker --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- ` +
        `curl -sS -o /dev/null -w "%{http_code}" -X POST ` +
        `http://credential-broker.${NS}.svc:8080/authz ` +
        `-H "X-Forwarded-Authority: api.anthropic.com"`,
    );
    // kubectl run --rm appends the pod-deletion message after the curl output,
    // so we check that '401' appears somewhere in the output.
    expect(out).toContain('401');
  }, 60_000);
});
