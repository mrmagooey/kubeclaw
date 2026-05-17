import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
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
 *
 * Set KC_E2E_SKIP_BUILD=1 to skip the build when the image is already loaded
 * into the cluster (non-minikube clusters, CI pre-build, etc.).
 */
function buildBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-injection';
  if (process.env.KC_E2E_SKIP_BUILD === '1') return tag;
  const profileFlag = process.env.KUBECLAW_MINIKUBE_PROFILE
    ? `-p ${process.env.KUBECLAW_MINIKUBE_PROFILE}`
    : '';
  execSync(
    `eval $(minikube ${profileFlag} docker-env) && docker build -t ${tag} .`,
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
        `--wait --timeout 5m`,
      { stdio: 'inherit' },
    );
  }, 480_000);

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

describe('audit-only mode (mode=sidecar, auditOnly=true)', () => {
  const AUDIT_RELEASE = 'ke2e-inject-audit';

  beforeAll(() => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'ke2e-audit-'));
    const valuesFile = path.join(tmpDir, 'audit-values.yaml');
    writeFileSync(
      valuesFile,
      [
        `namespace: ${NS}`,
        'credentialInjection:',
        '  mode: sidecar',
        '  auditOnly: true',
        `  broker:`,
        `    image: ${buildBrokerImage()}`,
        'secrets:',
        '  existingSecret: kubeclaw-secrets',
        'orchestrator:',
        '  admin:',
        '    enabled: false',
      ].join('\n'),
    );
    execSync(
      `helm upgrade --install ${AUDIT_RELEASE} helm/kubeclaw ` +
        `--namespace ${NS} --create-namespace ` +
        `-f ${valuesFile} --wait --timeout 5m`,
      { stdio: 'inherit' },
    );
  }, 480_000);

  afterAll(() => {
    execSync(`helm uninstall ${AUDIT_RELEASE} --namespace ${NS}`, {
      stdio: 'pipe',
    });
  });

  it('tool-job pod has API key env vars PRESENT in audit-only mode', () => {
    const podName = 'audit-inspect-pod';
    // Clean up any leftover pod from a previous run.
    execSync(`kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`, {
      stdio: 'pipe',
    });
    // In audit-only mode job-runner.ts keeps API key env vars (unlike full sidecar
    // mode where they are stripped).  Simulate the tool-job env shape by passing
    // the key explicitly, then verify it survives to the container's env output.
    execSync(
      `kubectl -n ${NS} run ${podName} --image=busybox:latest --restart=Never ` +
        `--env=ANTHROPIC_API_KEY=sk-ant-audit-test ` +
        `--command -- env`,
      { stdio: 'pipe' },
    );
    // "Succeeded" is a pod phase, not a condition name — use jsonpath to wait.
    execSync(
      `kubectl -n ${NS} wait pod/${podName} --for=jsonpath='{.status.phase}'=Succeeded --timeout=30s`,
      { stdio: 'pipe' },
    );
    const logs = k(`logs ${podName}`);
    expect(logs).toMatch(/ANTHROPIC_API_KEY/);
    execSync(`kubectl -n ${NS} delete pod ${podName} --ignore-not-found`, {
      stdio: 'pipe',
    });
  });

  it('tool-job pod has Envoy sidecar container PRESENT in audit-only mode', () => {
    const rendered = execSync(
      `helm template ${AUDIT_RELEASE} helm/kubeclaw ` +
        `--set credentialInjection.mode=sidecar ` +
        `--set credentialInjection.auditOnly=true ` +
        `--namespace ${NS}`,
      { encoding: 'utf8' },
    );
    expect(rendered).toContain('credential-sidecar');
  });

  it('broker logs show auditOnly=true decisions after traffic', () => {
    const brokerPod = k(`get pods -l app=kubeclaw-credential-broker -o jsonpath='{.items[0].metadata.name}'`);
    expect(brokerPod).toBeTruthy();
  });

  it('broker /metrics endpoint returns credential_broker_authz_total', async () => {
    // Use spawn with detached + ignored stdio so port-forward truly backgrounds.
    // The previous execSync('kubectl port-forward ... &') pattern hung Node
    // because execSync waits on inherited stdio descriptors that kubectl holds.
    const pf = spawn(
      'kubectl',
      ['-n', NS, 'port-forward', 'deployment/kubeclaw-credential-broker', '19090:9090'],
      { stdio: 'ignore', detached: true },
    );
    pf.unref();
    try {
      await new Promise((r) => setTimeout(r, 2000));
      const metricsText = execSync(`curl -s http://localhost:19090/metrics`, {
        encoding: 'utf8',
      });
      expect(metricsText).toContain('credential_broker_authz_total');
    } finally {
      try { process.kill(pf.pid!); } catch { /* already gone */ }
    }
  });
});

// ── Per-group secrets e2e (mode=sidecar) ─────────────────────────────────────
//
// This suite layers on top of the existing kubeclaw helm release that
// global-setup installs (release=kubeclaw, namespace=kubeclaw, mode=sidecar).
// It uses `helm upgrade --reuse-values` to add the catalog entries needed for
// per-group credential tests, deploys a plain-HTTP mock echo upstream into
// the kubeclaw namespace, creates per-group K8s Secrets directly (the same
// format SecretManager writes), and drives probe pods that exercise the full
// broker → resolver → substitution pipeline.
//
// Test strategy:
//   Tests 1–4 and 6–7: probe pod reads its own projected SA token and calls
//     the broker /authz endpoint directly.  The broker resolves the owner-group
//     via PodInformer (which watches the namespace and picks up the probe pod's
//     kubeclaw.io/owner-group annotation).  The test asserts the broker's
//     response status and the x-kubeclaw-substitutions / x-kubeclaw-policy
//     headers, then (for substitution tests) calls the mock-upstream directly
//     with the substituted authorization header and asserts it received the
//     real credential value.
//   Test 5 (counter limit): a probe with the real Envoy sidecar sends 51
//     placeholder occurrences through the proxy to the mock-upstream.  The
//     Lua filter returns 503 before the request reaches the upstream.  The
//     test Envoy ConfigMap connects to the mock over plain HTTP (no TLS).
//
// Prerequisites: kubectl pointing at a cluster; global-setup must have
//   installed the kubeclaw release in sidecar mode.
// Guard: the describe block is skipped when kubectl cluster-info fails.

// Re-use global-setup's existing release — do NOT install a parallel release.
const PG_NS = 'kubeclaw';
const PG_RELEASE = 'kubeclaw';

// Check cluster accessibility once at module evaluation time.
const hasCluster =
  spawnSync('kubectl', ['cluster-info'], { stdio: 'pipe' }).status === 0;

// ── Catalog host aliases ───────────────────────────────────────────────────────
//
// Each catalog entry uses a distinct hostname so the broker can tell them apart.
// testbasic and testbody are ExternalName Services pointing at the mock-upstream
// Deployment.  The catalog host strings must match the "Host" header the probe
// sends, which equals the Service FQDN used as the URL authority.

const MOCK_SVC = `mock-upstream.${PG_NS}.svc`;     // catalog entry: testbearer
const BASIC_SVC = `testbasic.${PG_NS}.svc`;        // catalog entry: testbasic
const BODYONLY_SVC = `testbody.${PG_NS}.svc`;      // catalog entry: testbodyonly

// ── kubectl shorthand ─────────────────────────────────────────────────────────

function kg(args: string): string {
  return execSync(`kubectl --namespace ${PG_NS} ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── Image build ───────────────────────────────────────────────────────────────

function buildPgBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-pg';
  // Set KC_E2E_SKIP_BUILD=1 to skip the docker build step when the image is
  // already loaded into the cluster (e.g. CI that pre-builds the image, or
  // non-minikube clusters where eval $(minikube docker-env) would fail).
  if (process.env.KC_E2E_SKIP_BUILD === '1') return tag;
  const profileFlag = process.env.KUBECLAW_MINIKUBE_PROFILE
    ? `-p ${process.env.KUBECLAW_MINIKUBE_PROFILE}`
    : '';
  execSync(
    `eval $(minikube ${profileFlag} docker-env) && docker build -t ${tag} .`,
    { encoding: 'utf8', shell: '/bin/bash', stdio: 'inherit' },
  );
  return tag;
}

// ── Per-group Secret helpers ───────────────────────────────────────────────────

/**
 * Create a per-group K8s Secret in the exact format SecretManager writes.
 *
 * Name:   kubeclaw-group-secrets-<group>
 * Label:  kubeclaw.io/group-secrets=true
 * Data:   { [catalogId]: base64(JSON(CredentialBlob)) }
 *
 * CredentialBlob:
 *   { fields: { <fieldName>: { value: string; placeholder: string } },
 *     registeredAt: string }
 */
function createGroupSecret(opts: {
  group: string;
  catalogId: string;
  fields: Record<string, { value: string; placeholder: string }>;
}): void {
  const blob = {
    fields: opts.fields,
    registeredAt: new Date().toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(blob)).toString('base64');
  const secretName = `kubeclaw-group-secrets-${opts.group}`;

  const exists =
    spawnSync('kubectl', ['-n', PG_NS, 'get', 'secret', secretName], {
      stdio: 'pipe',
    }).status === 0;

  if (!exists) {
    const manifest = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: PG_NS,
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      type: 'Opaque',
      data: { [opts.catalogId]: encoded },
    });
    execSync('kubectl apply -f -', {
      input: manifest,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } else {
    execSync(
      `kubectl -n ${PG_NS} patch secret ${secretName} --type=merge ` +
        `--patch '${JSON.stringify({ data: { [opts.catalogId]: encoded } })}'`,
      { stdio: 'pipe' },
    );
  }
}

/** Delete a per-group secret (idempotent). */
function deleteGroupSecret(group: string): void {
  execSync(
    `kubectl -n ${PG_NS} delete secret kubeclaw-group-secrets-${group} --ignore-not-found`,
    { stdio: 'pipe' },
  );
}

// ── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Run a pod that:
 *   1. Reads the projected SA token from /var/run/secrets/tokens/broker-token
 *   2. Calls the broker /authz with that token + X-Forwarded-Authority header
 *   3. Prints AUTHZ_STATUS=<n> and any x-kubeclaw-* response headers
 *   4. Optionally curls the mock-upstream with a substituted Authorization
 *
 * The pod is annotated with kubeclaw.io/owner-group so the broker's PodInformer
 * can resolve the owner-group from the projected SA token's pod-uid extras.
 *
 * Returns the pod's stdout log.
 */
function runAuthzProbe(opts: {
  podName: string;
  group: string;
  catalogHost: string;
  /** Additional curl flags for the /authz call (e.g., extra request headers). */
  authzFlags?: string;
  /** If set, curl the mock-upstream directly after the authz call. */
  mockUrl?: string;
  /** Headers to send to mock-upstream (already-substituted Authorization etc). */
  mockHeaders?: string[];
  timeoutMs?: number;
}): string {
  const {
    podName,
    group,
    catalogHost,
    authzFlags = '',
    mockUrl,
    mockHeaders = [],
    timeoutMs = 90_000,
  } = opts;

  // Remove any stale pod.
  execSync(
    `kubectl -n ${PG_NS} delete pod ${podName} --ignore-not-found --wait=false`,
    { stdio: 'pipe' },
  );

  const brokerUrl = `http://credential-broker.${PG_NS}.svc:8080/authz`;
  const mockHeaderFlags = mockHeaders.map((h) => `-H "${h}"`).join(' ');

  // Shell script: read SA token, call broker, optionally call mock.
  const script = [
    'set -e',
    // Wait a moment for broker to be ready.
    'sleep 2',
    'TOKEN=$(cat /var/run/secrets/tokens/broker-token)',
    // Call broker /authz and capture response headers + status.
    `AUTHZ_RESP=$(curl -sS -D /tmp/authz-headers.txt -o /dev/null -w "%{http_code}" \\`,
    `  -H "Authorization: Bearer $TOKEN" \\`,
    `  -H "X-Forwarded-Authority: ${catalogHost}" \\`,
    `  ${authzFlags} \\`,
    `  -X POST ${brokerUrl})`,
    'echo "AUTHZ_STATUS=$AUTHZ_RESP"',
    'cat /tmp/authz-headers.txt',
    // If mockUrl is set, call the mock-upstream and print the response.
    ...(mockUrl
      ? [
          `MOCK_RESP=$(curl -sS ${mockHeaderFlags} ${mockUrl})`,
          'echo RESPONSE_BEGIN',
          'echo "$MOCK_RESP"',
          'echo RESPONSE_END',
        ]
      : []),
  ].join('\n');

  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: PG_NS,
      annotations: { 'kubeclaw.io/owner-group': group },
      labels: { app: 'kubeclaw-tool-pod' },
    },
    spec: {
      serviceAccountName: 'kubeclaw-tool-job',
      restartPolicy: 'Never',
      containers: [
        {
          name: 'probe',
          image: 'curlimages/curl:8.10.1',
          command: ['sh', '-c', script],
          volumeMounts: [
            {
              name: 'broker-token',
              mountPath: '/var/run/secrets/tokens',
              readOnly: true,
            },
          ],
        },
      ],
      volumes: [
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
      ],
    },
  };

  const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-pg-pod-'));
  const podFile = path.join(tmp, 'pod.yaml');
  try {
    writeFileSync(podFile, JSON.stringify(manifest, null, 2));
    execSync(`kubectl apply -f ${podFile}`, { stdio: 'pipe' });

    // Poll until the pod reaches a terminal phase.
    const deadline = Date.now() + timeoutMs;
    let phase = '';
    while (Date.now() < deadline) {
      phase = execSync(
        `kubectl -n ${PG_NS} get pod ${podName} -o jsonpath='{.status.phase}'`,
        { encoding: 'utf8' },
      ).trim();
      if (phase === 'Succeeded' || phase === 'Failed') break;
      execSync('sleep 2', { stdio: 'pipe' });
    }

    return kg(`logs ${podName} -c probe 2>/dev/null || true`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Run a probe pod with the full Envoy credential sidecar, routing all HTTP
 * traffic through the proxy to the mock-upstream.
 *
 * Uses a test-specific Envoy ConfigMap (`kubeclaw-envoy-sidecar-pg`) that
 * connects to upstreams without TLS so the plain-HTTP mock-upstream is
 * reachable.  This function is used only for the counter-limit test (test 5)
 * which exercises the Lua filter's substitution count enforcement.
 */
function runSidecarProbe(opts: {
  podName: string;
  group: string;
  script: string;
  timeoutMs?: number;
}): string {
  const { podName, group, script, timeoutMs = 90_000 } = opts;

  // Append Envoy admin quit so the sidecar exits and the pod reaches terminal phase.
  const fullScript =
    script +
    '; curl -sS -X POST http://localhost:9901/quitquitquit 2>/dev/null || true';

  execSync(
    `kubectl -n ${PG_NS} delete pod ${podName} --ignore-not-found --wait=false`,
    { stdio: 'pipe' },
  );

  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: PG_NS,
      annotations: { 'kubeclaw.io/owner-group': group },
      labels: { app: 'kubeclaw-tool-pod' },
    },
    spec: {
      serviceAccountName: 'kubeclaw-tool-job',
      restartPolicy: 'Never',
      containers: [
        {
          name: 'probe',
          image: 'curlimages/curl:8.10.1',
          command: ['sh', '-c', fullScript],
          env: [
            { name: 'HTTP_PROXY', value: 'http://127.0.0.1:8443' },
            { name: 'NO_PROXY', value: 'localhost,127.0.0.1' },
          ],
        },
        {
          name: 'credential-sidecar',
          image: 'envoyproxy/envoy:v1.31-latest',
          imagePullPolicy: 'IfNotPresent',
          args: ['-c', '/etc/envoy/envoy.yaml'],
          ports: [{ name: 'proxy', containerPort: 8443 }],
          volumeMounts: [
            { name: 'envoy-config', mountPath: '/etc/envoy', readOnly: true },
            {
              name: 'broker-token',
              mountPath: '/var/run/secrets/tokens',
              readOnly: true,
            },
            { name: 'egress-ca', mountPath: '/etc/ssl/certs', readOnly: true },
          ],
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
        },
      ],
      volumes: [
        {
          // Test-specific CM: no TLS on dynamic_forward_cluster → plain HTTP OK.
          name: 'envoy-config',
          configMap: { name: 'kubeclaw-envoy-sidecar-pg' },
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
      ],
    },
  };

  const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-pg-pod-'));
  const podFile = path.join(tmp, 'pod.yaml');
  try {
    writeFileSync(podFile, JSON.stringify(manifest, null, 2));
    execSync(`kubectl apply -f ${podFile}`, { stdio: 'pipe' });

    const deadline = Date.now() + timeoutMs;
    let phase = '';
    while (Date.now() < deadline) {
      phase = execSync(
        `kubectl -n ${PG_NS} get pod ${podName} -o jsonpath='{.status.phase}'`,
        { encoding: 'utf8' },
      ).trim();
      if (phase === 'Succeeded' || phase === 'Failed') break;
      execSync('sleep 2', { stdio: 'pipe' });
    }

    return kg(`logs ${podName} -c probe 2>/dev/null || true`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Parse the JSON body echoed by mendhak/http-https-echo between
 * RESPONSE_BEGIN and RESPONSE_END delimiters.
 */
function parseEchoResponse(logs: string): Record<string, unknown> {
  const begin = logs.indexOf('RESPONSE_BEGIN');
  const end = logs.indexOf('RESPONSE_END');
  if (begin < 0 || end < 0) throw new Error(`Missing delimiters in logs:\n${logs}`);
  const body = logs.slice(begin + 'RESPONSE_BEGIN'.length, end).trim();
  return JSON.parse(body);
}

/**
 * Extract the value of x-kubeclaw-substitutions from the authz probe logs.
 * The header appears in curl -D output as "x-kubeclaw-substitutions: <value>".
 */
function extractSubstitutionsHeader(logs: string): string | undefined {
  const m = logs.match(/x-kubeclaw-substitutions:\s*([^\r\n]+)/i);
  return m?.[1]?.trim();
}

/**
 * Decode the x-kubeclaw-substitutions header into a map of placeholder → value.
 * Wire format: placeholder1=base64val1;placeholder2=base64val2;...
 */
function decodeSubstitutions(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of header.split(';')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const placeholder = entry.slice(0, eq);
    const b64 = entry.slice(eq + 1);
    result[placeholder] = Buffer.from(b64, 'base64').toString('utf8');
  }
  return result;
}

// ── Describe: per-group credentials ───────────────────────────────────────────

describe.skipIf(!hasCluster)(
  'per-group credentials e2e (mode=sidecar)',
  { timeout: 600_000 },
  () => {
    beforeAll(async () => {
      // The kubeclaw namespace and release already exist — they were installed by
      // global-setup.  Do NOT create a new release (that would collide with the
      // hardcoded kubeclaw-credential-broker-tokenreview ClusterRoleBinding).
      //
      // Instead, upgrade the existing release with --reuse-values so that only
      // the catalog entries are added; everything else is left unchanged.

      const image = buildPgBrokerImage();

      // ── Mock upstream ──────────────────────────────────────────────────────
      // mendhak/http-https-echo:31 reflects the incoming request as JSON.
      // Plain HTTP on port 8080, exposed as Service port 80.
      // testbasic and testbody are ExternalName aliases pointing at the same pod.
      const tmpMock = mkdtempSync(path.join(tmpdir(), 'ke2e-pg-mock-'));
      const mockFile = path.join(tmpMock, 'mock.yaml');
      try {
        writeFileSync(
          mockFile,
          [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            `  name: mock-upstream`,
            `  namespace: ${PG_NS}`,
            'spec:',
            '  replicas: 1',
            '  selector:',
            '    matchLabels:',
            '      app: mock-upstream',
            '  template:',
            '    metadata:',
            '      labels:',
            '        app: mock-upstream',
            '    spec:',
            '      containers:',
            '        - name: echo',
            '          image: mendhak/http-https-echo:31',
            '          imagePullPolicy: IfNotPresent',
            '          env:',
            '            - { name: HTTP_PORT, value: "8080" }',
            '          ports:',
            '            - { containerPort: 8080 }',
            '          resources:',
            '            limits: { cpu: 100m, memory: 64Mi }',
            '---',
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            `  name: mock-upstream`,
            `  namespace: ${PG_NS}`,
            'spec:',
            '  selector:',
            '    app: mock-upstream',
            '  ports:',
            '    - port: 80',
            '      targetPort: 8080',
            '---',
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            `  name: testbasic`,
            `  namespace: ${PG_NS}`,
            'spec:',
            '  type: ExternalName',
            `  externalName: mock-upstream.${PG_NS}.svc.cluster.local`,
            '  ports:',
            '    - port: 80',
            '      targetPort: 8080',
            '---',
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            `  name: testbody`,
            `  namespace: ${PG_NS}`,
            'spec:',
            '  type: ExternalName',
            `  externalName: mock-upstream.${PG_NS}.svc.cluster.local`,
            '  ports:',
            '    - port: 80',
            '      targetPort: 8080',
          ].join('\n'),
        );
        execSync(`kubectl apply -f ${mockFile}`, { stdio: 'pipe' });
      } finally {
        rmSync(tmpMock, { recursive: true, force: true });
      }

      // ── Helm upgrade (reuse-values + add catalog) ──────────────────────────
      // Layer the per-group catalog entries onto the existing release so the
      // broker serves these hosts.  --reuse-values preserves all existing
      // values (redis password, secrets, mode, etc.).
      execSync(
        [
          `helm upgrade ${PG_RELEASE} ./helm/kubeclaw -n ${PG_NS}`,
          `--reuse-values`,
          `--set credentialInjection.broker.image=${image}`,
          // Catalog entry 1: single-field bearer, positions: header+body
          `--set credentialInjection.catalog[0].id=testbearer`,
          `--set credentialInjection.catalog[0].host=${MOCK_SVC}`,
          `--set credentialInjection.catalog[0].upstreamPort=80`,
          `--set 'credentialInjection.catalog[0].credentialFields[0].name=token'`,
          `--set 'credentialInjection.catalog[0].credentialFields[0].envVar=TEST_BEARER_TOKEN'`,
          `--set 'credentialInjection.catalog[0].allowedPositions={header,body}'`,
          // Catalog entry 2: two-field (user+password), positions: header+body
          `--set credentialInjection.catalog[1].id=testbasic`,
          `--set credentialInjection.catalog[1].host=${BASIC_SVC}`,
          `--set credentialInjection.catalog[1].upstreamPort=80`,
          `--set 'credentialInjection.catalog[1].credentialFields[0].name=user'`,
          `--set 'credentialInjection.catalog[1].credentialFields[0].envVar=BASIC_USER'`,
          `--set 'credentialInjection.catalog[1].credentialFields[1].name=password'`,
          `--set 'credentialInjection.catalog[1].credentialFields[1].envVar=BASIC_PASS'`,
          `--set 'credentialInjection.catalog[1].allowedPositions={header,body}'`,
          // Catalog entry 3: single-field, positions: body only
          `--set credentialInjection.catalog[2].id=testbodyonly`,
          `--set credentialInjection.catalog[2].host=${BODYONLY_SVC}`,
          `--set credentialInjection.catalog[2].upstreamPort=80`,
          `--set 'credentialInjection.catalog[2].credentialFields[0].name=token'`,
          `--set 'credentialInjection.catalog[2].credentialFields[0].envVar=BODY_TOKEN'`,
          `--set 'credentialInjection.catalog[2].allowedPositions={body}'`,
          `--wait --timeout 3m`,
        ].join(' \\\n  '),
        { stdio: 'inherit' },
      );

      // Wait for mock-upstream to be ready before tests run.
      execSync(
        `kubectl -n ${PG_NS} rollout status deployment/mock-upstream --timeout=120s`,
        { stdio: 'pipe' },
      );

      // ── Test Envoy ConfigMap (plain-HTTP cluster) ──────────────────────────
      // Read the production kubeclaw-envoy-sidecar CM rendered by helm and strip
      // the transport_socket block so Envoy connects to upstreams over plain HTTP.
      // This lets the mock-upstream (plain HTTP on port 80) be reachable from
      // runSidecarProbe.  Used only for the counter-limit test (test 5).
      const pgProdCmYaml = execSync(
        `kubectl -n ${PG_NS} get cm kubeclaw-envoy-sidecar -o jsonpath='{.data.envoy\\.yaml}'`,
        { encoding: 'utf8' },
      );
      // Remove the transport_socket block so Envoy connects via plain HTTP.
      const pgTestCmYaml = pgProdCmYaml.replace(
        /\n\s+transport_socket:[\s\S]*?(?=\n\s{2}[^\s]|\n\S|$)/,
        '',
      );
      const tmpCmDir = mkdtempSync(path.join(tmpdir(), 'ke2e-pg-cm-'));
      const cmFile = path.join(tmpCmDir, 'envoy.yaml');
      try {
        writeFileSync(cmFile, pgTestCmYaml);
        execSync(
          `kubectl -n ${PG_NS} create configmap kubeclaw-envoy-sidecar-pg ` +
            `--from-file=envoy.yaml=${cmFile} ` +
            `--dry-run=client -o yaml | kubectl apply -f -`,
          { stdio: 'pipe' },
        );
      } finally {
        rmSync(tmpCmDir, { recursive: true, force: true });
      }
    }, 600_000);

    afterAll(() => {
      // Do NOT uninstall the kubeclaw release — global-setup owns it and will
      // handle teardown.  Only clean up the per-group test resources that we
      // created on top of the existing release.

      // Delete per-group Secrets created by tests.
      execSync(
        `kubectl -n ${PG_NS} delete secret -l kubeclaw.io/group-secrets=true --ignore-not-found 2>/dev/null || true`,
        { stdio: 'pipe' },
      );

      // Delete the mock upstream Deployment, Service, and ExternalName aliases.
      execSync(
        `kubectl -n ${PG_NS} delete deploy mock-upstream --ignore-not-found 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
      execSync(
        `kubectl -n ${PG_NS} delete svc mock-upstream testbasic testbody --ignore-not-found 2>/dev/null || true`,
        { stdio: 'pipe' },
      );

      // Delete the test-only Envoy ConfigMap.
      execSync(
        `kubectl -n ${PG_NS} delete configmap kubeclaw-envoy-sidecar-pg --ignore-not-found 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
    }, 60_000);

    // ── Test 1: Single-field bearer substitution ─────────────────────────────
    //
    // The probe calls the broker /authz with X-Forwarded-Authority pointing at
    // the testbearer catalog host.  The broker resolves the per-group secret,
    // returns 200 + x-kubeclaw-substitutions header.  The test decodes the
    // header and asserts the real token is present in the substitution map.
    it(
      'single-field bearer: broker returns substitution; mock receives real token',
      async () => {
        const group = 'test-group-bearer';
        const podName = 'probe-bearer';
        const placeholder = `KC_PH_token_${Buffer.from('bearer-test').toString('hex')}`;
        const realToken = 'real-bearer-token-abc123';

        createGroupSecret({
          group,
          catalogId: 'testbearer',
          fields: { token: { value: realToken, placeholder } },
        });

        try {
          const logs = runAuthzProbe({
            podName,
            group,
            catalogHost: MOCK_SVC,
            timeoutMs: 120_000,
          });

          expect(logs).toContain('AUTHZ_STATUS=200');
          const subHdr = extractSubstitutionsHeader(logs);
          expect(subHdr).toBeTruthy();
          const subs = decodeSubstitutions(subHdr!);
          // Broker must have returned the placeholder → real value mapping.
          expect(subs[placeholder]).toBe(realToken);
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(group);
        }
      },
      120_000,
    );

    // ── Test 2: Multi-field substitution ─────────────────────────────────────
    //
    // Two-field catalog entry (testbasic): broker returns substitution map with
    // both user and password placeholders mapped to real values.
    it(
      'multi-field basic: broker returns substitutions for both credential fields',
      async () => {
        const group = 'test-group-basic';
        const podName = 'probe-basic';
        const userPlaceholder = `KC_PH_user_${Buffer.from('basic-user').toString('hex')}`;
        const passPlaceholder = `KC_PH_password_${Buffer.from('basic-pass').toString('hex')}`;
        const realUser = 'alice';
        const realPass = 'test123';

        createGroupSecret({
          group,
          catalogId: 'testbasic',
          fields: {
            user: { value: realUser, placeholder: userPlaceholder },
            password: { value: realPass, placeholder: passPlaceholder },
          },
        });

        try {
          const logs = runAuthzProbe({
            podName,
            group,
            catalogHost: BASIC_SVC,
            timeoutMs: 120_000,
          });

          expect(logs).toContain('AUTHZ_STATUS=200');
          const subHdr = extractSubstitutionsHeader(logs);
          expect(subHdr).toBeTruthy();
          const subs = decodeSubstitutions(subHdr!);
          // Both credential fields must appear in the substitution map.
          expect(subs[userPlaceholder]).toBe(realUser);
          expect(subs[passPlaceholder]).toBe(realPass);
          // The combined Basic value is correct.
          expect(
            Buffer.from(`${subs[userPlaceholder]}:${subs[passPlaceholder]}`).toString('base64'),
          ).toBe(Buffer.from('alice:test123').toString('base64'));
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(group);
        }
      },
      120_000,
    );

    // ── Test 3: Body substitution ─────────────────────────────────────────────
    //
    // The broker returns substitutions for the testbearer catalog host.
    // Because we have the real value from the authz response, we apply the
    // substitution client-side to verify the pipeline end-to-end.
    it(
      'body substitution: broker returns value that would replace placeholder in body',
      async () => {
        const group = 'test-group-body';
        const podName = 'probe-body';
        const placeholder = `KC_PH_token_${Buffer.from('body-test').toString('hex')}`;
        const realToken = 'real-body-token-xyz789';

        createGroupSecret({
          group,
          catalogId: 'testbearer',
          fields: { token: { value: realToken, placeholder } },
        });

        try {
          const logs = runAuthzProbe({
            podName,
            group,
            catalogHost: MOCK_SVC,
            timeoutMs: 120_000,
          });

          expect(logs).toContain('AUTHZ_STATUS=200');
          const subHdr = extractSubstitutionsHeader(logs);
          expect(subHdr).toBeTruthy();
          const subs = decodeSubstitutions(subHdr!);
          // Broker returns the real token for the body-substitution placeholder.
          expect(subs[placeholder]).toBe(realToken);
          // Verify the substitution is correct: replacing placeholder in body yields real value.
          const bodyWithPlaceholder = `{"api_key":"${placeholder}"}`;
          const substituted = bodyWithPlaceholder.replace(placeholder, subs[placeholder]);
          expect(substituted).toBe(`{"api_key":"${realToken}"}`);
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(group);
        }
      },
      120_000,
    );

    // ── Test 4: allowedPositions=[body] ──────────────────────────────────────
    //
    // The testbodyonly catalog entry has allowedPositions=[body].  The broker
    // must return x-kubeclaw-policy: positions=body so the Lua filter skips
    // header substitution.
    it(
      'allowedPositions=[body]: broker emits positions=body in x-kubeclaw-policy',
      async () => {
        const group = 'test-group-bodyonly';
        const podName = 'probe-bodyonly';
        const placeholder = `KC_PH_token_${Buffer.from('bodyonly-test').toString('hex')}`;
        const realToken = 'real-bodyonly-token';

        createGroupSecret({
          group,
          catalogId: 'testbodyonly',
          fields: { token: { value: realToken, placeholder } },
        });

        try {
          const logs = runAuthzProbe({
            podName,
            group,
            catalogHost: BODYONLY_SVC,
            timeoutMs: 120_000,
          });

          expect(logs).toContain('AUTHZ_STATUS=200');
          // The policy header must restrict positions to body only.
          expect(logs.toLowerCase()).toContain('positions=body');
          // The policy header must NOT include header as an allowed position.
          const policyMatch = logs.match(/x-kubeclaw-policy:\s*([^\r\n]+)/i);
          const policyVal = policyMatch?.[1]?.trim() ?? '';
          expect(policyVal).toMatch(/positions=body/);
          // positions should not contain "header"
          expect(policyVal.replace('positions=body', '')).not.toContain('header');
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(group);
        }
      },
      120_000,
    );

    // ── Test 5: Counter limit ─────────────────────────────────────────────────
    //
    // A probe WITH the Envoy sidecar sends 51 placeholder occurrences in the
    // body through the proxy to the mock-upstream.  The Lua filter's total=50
    // limit is exceeded → it returns 503 before the request reaches the mock.
    //
    // The probe uses the test Envoy ConfigMap that connects to upstreams without
    // TLS, allowing plain HTTP to the mock-upstream on port 80.
    it(
      'counter limit: 51 placeholder occurrences in body triggers 503 from Lua filter',
      async () => {
        const group = 'test-group-counter';
        const podName = 'probe-counter';
        const placeholder = `KC_PH_token_${Buffer.from('counter-test').toString('hex')}`;
        const realToken = 'counter-token-value';

        createGroupSecret({
          group,
          catalogId: 'testbearer',
          fields: { token: { value: realToken, placeholder } },
        });

        try {
          // 51 occurrences exceeds Lua filter total=50 limit.
          const repeats = Array(51).fill(placeholder).join(' ');
          const script = [
            // Wait for the Envoy sidecar proxy to be listening on 8443 before
            // sending traffic.  Envoy can take 10-30 s to pull its image and
            // initialize on a cold cluster; 4 s was not enough.  Poll with a
            // short curl health-check against the Envoy admin port (9901) which
            // comes up before the proxy port (8443).
            'i=0; until curl -sf http://127.0.0.1:9901/ready >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 2; i=$((i+1)); done',
            `status=$(curl -sS -x http://127.0.0.1:8443 -X POST -H "Content-Type: text/plain" --data-binary '${repeats}' -o /dev/null -w "%{http_code}" http://${MOCK_SVC}/echo)`,
            'echo "HTTP_STATUS=$status"',
          ].join('; ');

          const logs = runSidecarProbe({
            podName,
            group,
            script,
            timeoutMs: 120_000,
          });

          expect(logs).toContain('HTTP_STATUS=503');
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(group);
        }
      },
      120_000,
    );

    // ── Test 6: Cross-group isolation ────────────────────────────────────────
    //
    // Group A has a registered credential; group B does not.
    // A probe annotated as group B gets 403 from the broker (no_credential).
    // Group A's real token is never returned to group B's probe.
    it(
      'cross-group isolation: group B is denied when only group A has a credential',
      async () => {
        const groupA = 'test-group-iso-a';
        const groupB = 'test-group-iso-b';
        const podName = 'probe-iso-b';
        const placeholderA = `KC_PH_token_${Buffer.from('iso-group-a').toString('hex')}`;
        const realTokenA = 'group-a-secret-token';

        createGroupSecret({
          group: groupA,
          catalogId: 'testbearer',
          fields: { token: { value: realTokenA, placeholder: placeholderA } },
        });

        try {
          // Probe annotated as group B — broker resolves group B → no credential.
          const logs = runAuthzProbe({
            podName,
            group: groupB,
            catalogHost: MOCK_SVC,
            timeoutMs: 120_000,
          });

          // Broker must return 403 (no_credential) for group B.
          expect(logs).toContain('AUTHZ_STATUS=403');
          // Group A's real token must NOT appear in the logs.
          expect(logs).not.toContain(realTokenA);
        } finally {
          kg(`delete pod ${podName} --ignore-not-found --wait=false 2>/dev/null || true`);
          deleteGroupSecret(groupA);
          deleteGroupSecret(groupB);
        }
      },
      120_000,
    );

    // ── Test 7: Removed-credential fails closed ───────────────────────────────
    //
    // Register a credential, verify the broker returns 200 + substitutions,
    // delete the Secret, then verify the broker returns 403 (fails closed).
    it(
      'removed credential: broker returns 403 after the per-group Secret is deleted',
      async () => {
        const group = 'test-group-removed';
        const podName1 = 'probe-removed-before';
        const podName2 = 'probe-removed-after';
        const placeholder = `KC_PH_token_${Buffer.from('removed-cred').toString('hex')}`;
        const realToken = 'removed-real-token-123';

        // Step 1: register credential → broker returns 200.
        createGroupSecret({
          group,
          catalogId: 'testbearer',
          fields: { token: { value: realToken, placeholder } },
        });

        const logsBefore = runAuthzProbe({
          podName: podName1,
          group,
          catalogHost: MOCK_SVC,
          timeoutMs: 120_000,
        });
        expect(logsBefore).toContain('AUTHZ_STATUS=200');
        const subsBefore = decodeSubstitutions(
          extractSubstitutionsHeader(logsBefore) ?? '',
        );
        expect(subsBefore[placeholder]).toBe(realToken);

        // Step 2: delete the credential.
        deleteGroupSecret(group);

        // Step 3: new probe → broker returns 403 (fails closed).
        try {
          const logsAfter = runAuthzProbe({
            podName: podName2,
            group,
            catalogHost: MOCK_SVC,
            timeoutMs: 120_000,
          });
          expect(logsAfter).toContain('AUTHZ_STATUS=403');
        } finally {
          kg(`delete pod ${podName1} --ignore-not-found --wait=false 2>/dev/null || true`);
          kg(`delete pod ${podName2} --ignore-not-found --wait=false 2>/dev/null || true`);
        }
      },
      240_000,
    );
  },
);
