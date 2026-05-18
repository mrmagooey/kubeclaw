/**
 * e2e tests for Story 4: credential broker /authz endpoint.
 *
 * Acceptance criteria:
 *   AC1 – Valid SA token + X-Forwarded-Authority: api.anthropic.com → 200 with
 *          Authorization: Bearer <value>
 *   AC2 – Valid SA token + X-Forwarded-Authority: unknown.example.com → 403,
 *          no Authorization header
 *   AC3 – No Authorization header (no SA token) → 401 regardless of authority
 *   AC4 – GET /metrics on port 9090 returns credential_broker_authz_total with
 *          labels reflecting 200/403/401 outcomes
 *   AC5 – Broker Deployment reaches readyReplicas=1 within 60 s and pod spec
 *          has runAsNonRoot: true
 *
 * Prerequisites:
 *   - kubectl context pointing at kind-kubeclaw-e2e-istio
 *   - kubeclaw-orchestrator:e2e-test image pre-loaded into the kind cluster
 *   - curlimages/curl:8.10.1 pre-loaded into the kind cluster
 *
 * The test installs its own Helm release into an isolated namespace so it can
 * run alongside other test suites without colliding on ClusterRoleBindings or
 * Secrets.
 *
 * Note on ClusterRoleBinding name:
 *   The helm chart generates a ClusterRoleBinding named
 *   `<release>-credential-broker-tokenreview`.  Using a unique RELEASE name
 *   here avoids collisions with other running suites that use the default
 *   "kubeclaw" release name.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-authz';
const RELEASE = 'ke2e-authz';
const BROKER_IMAGE = 'kubeclaw-orchestrator:e2e-test';

// Metrics port-forward uses a host port unlikely to conflict with other suites.
const METRICS_LOCAL_PORT = 19291;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Run a kubectl command scoped to NS and return stdout.
 * Throws on non-zero exit.
 */
function k(args: string): string {
  return execSync(`kubectl --namespace ${NS} ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run a kubectl run --rm curl pod and return its stdout.
 *
 * Uses --rm so the pod is deleted after it exits. kubectl run --rm writes the
 * pod deletion message ("pod ... deleted") to stdout after the container
 * output, so callers should use toContain rather than toEqual.
 *
 * Timeout is per-call (ms); default 60 s.
 */
function curlPod(podName: string, curlArgs: string, timeoutMs = 60_000): string {
  return execSync(
    `kubectl --namespace ${NS} run ${podName} --rm -i --restart=Never ` +
      `--image=curlimages/curl:8.10.1 -- ${curlArgs}`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs },
  );
}

// ── Suite-wide setup / teardown ────────────────────────────────────────────────

describe('credential broker /authz endpoint (Story 4)', { timeout: 300_000 }, () => {
  beforeAll(() => {
    // ── 1. Clean namespace ───────────────────────────────────────────────────
    // If a previous run left the namespace in a Terminating state, wait for it
    // to disappear before creating it fresh.
    execSync(
      `kubectl wait --for=delete ns/${NS} --timeout=90s 2>/dev/null || true`,
    );
    execSync(`kubectl create ns ${NS} || true`);

    // ── 2. Seed kubeclaw-secrets ─────────────────────────────────────────────
    // The broker Role references kubeclaw-secrets (read access to the secret
    // that holds anthropic-api-key).  The value is a placeholder — the broker
    // reads and stamps it into the Authorization header, so AC1 will see
    // "Bearer sk-ant-e2e-test" in the response.
    execSync(
      `kubectl -n ${NS} create secret generic kubeclaw-secrets ` +
        `--from-literal=anthropic-api-key=sk-ant-e2e-test ` +
        `--from-literal=openai-api-key=sk-openai-e2e-test ` +
        `--from-literal=openrouter-api-key=sk-or-e2e-test ` +
        `--from-literal=voyage-api-key=sk-v-e2e-test ` +
        `--dry-run=client -o yaml | kubectl apply -f -`,
    );

    // ── 3. Helm install ──────────────────────────────────────────────────────
    // Install only the credential broker (orchestrator.replicas=0 avoids
    // Redis + orchestrator PVC provisioning).  No --wait so helm does not
    // block on the orchestrator Deployment; we wait for the broker explicitly.
    execSync(
      [
        `helm upgrade --install ${RELEASE} ./helm/kubeclaw`,
        `-n ${NS}`,
        `--set namespace=${NS}`,
        `--set image.tag=e2e-test`,
        `--set image.pullPolicy=IfNotPresent`,
        `--set credentialInjection.mode=sidecar`,
        `--set credentialInjection.internalCA.autoProvision=false`,
        `--set credentialInjection.broker.image=${BROKER_IMAGE}`,
        `--set secrets.existingSecret=kubeclaw-secrets`,
        `--set orchestrator.admin.enabled=false`,
        `--set orchestrator.replicas=0`,
        `--set networkPolicy.enabled=false`,
      ].join(' \\\n  '),
      { stdio: 'inherit' },
    );

    // ── 4. Wait for broker ───────────────────────────────────────────────────
    execSync(
      `kubectl rollout status deployment/kubeclaw-credential-broker -n ${NS} --timeout=120s`,
      { stdio: 'inherit' },
    );
  }, 240_000);

  afterAll(() => {
    execSync(`helm uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`);
    execSync(`kubectl delete ns ${NS} --wait=false 2>/dev/null || true`);
  }, 60_000);

  // ── AC5: readyReplicas and runAsNonRoot ────────────────────────────────────
  //
  // Placed first so that if the broker is not ready, the remaining ACs that
  // depend on in-cluster calls fail with a clear "not ready" message rather
  // than a confusing curl timeout.
  it(
    'AC5: broker Deployment reaches readyReplicas=1 and pod spec has runAsNonRoot',
    () => {
      // readyReplicas
      const readyReplicas = k(
        'get deployment kubeclaw-credential-broker ' +
          `-o jsonpath='{.status.readyReplicas}'`,
      );
      expect(readyReplicas.trim()).toBe('1');

      // runAsNonRoot — checked on the Deployment's pod template spec
      const runAsNonRoot = k(
        'get deployment kubeclaw-credential-broker ' +
          `-o jsonpath='{.spec.template.spec.securityContext.runAsNonRoot}'`,
      );
      expect(runAsNonRoot.trim()).toBe('true');
    },
  );

  // ── AC1: valid SA token + allowed authority → 200 + Authorization header ──
  //
  // Strategy:
  //   a) Mint a short-lived SA token for kubeclaw-tool-job with the broker
  //      audience using `kubectl create token`.
  //   b) Run a curl pod that POSTs to /authz with the token as Bearer and
  //      X-Forwarded-Authority: api.anthropic.com.
  //   c) Use curl -i to capture response headers; assert HTTP 200 and that the
  //      Authorization response header starts with "Bearer ".
  //
  // We use a projected SA token written to the pod's filesystem to avoid
  // passing the raw token through the kubectl run command line (which can be
  // truncated by the shell on some platforms).  However, since kubectl create
  // token + kubectl run is the simplest reliable approach here, we pass the
  // token via an environment variable in the pod manifest.
  it(
    'AC1: valid SA token + api.anthropic.com → 200 with Authorization: Bearer',
    () => {
      // Mint a short-lived token (10 min) for the kubeclaw-tool-job SA.
      const token = execSync(
        `kubectl create token kubeclaw-tool-job ` +
          `--audience kubeclaw-credential-broker -n ${NS}`,
        { encoding: 'utf8' },
      ).trim();

      const brokerUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/authz`;

      // Run a curl pod that:
      //   - POSTs to /authz with the SA Bearer token
      //   - Includes X-Forwarded-Authority: api.anthropic.com
      //   - Uses -i to include response headers in stdout
      //   - Uses -s -S for silent mode (no progress bar, but show errors)
      //
      // The curl output is: response-headers\r\n\r\nbody
      // We parse it to verify HTTP 200 and the Authorization header.
      const curlOutput = execSync(
        `kubectl --namespace ${NS} run authz-ac1 --rm -i --restart=Never ` +
          `--image=curlimages/curl:8.10.1 ` +
          `-- curl -sS -i -X POST ${brokerUrl} ` +
          `-H "Authorization: Bearer ${token}" ` +
          `-H "X-Forwarded-Authority: api.anthropic.com"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 },
      );

      // Assert HTTP 200
      expect(curlOutput).toContain('HTTP/1.1 200');
      // Assert Authorization response header starts with "Bearer "
      // (case-insensitive header match — broker returns lowercase "authorization")
      const lowerOutput = curlOutput.toLowerCase();
      const authHeaderIdx = lowerOutput.indexOf('\nauthorization:');
      expect(authHeaderIdx).toBeGreaterThan(-1);
      const authHeaderLine = curlOutput
        .slice(authHeaderIdx + 1)
        .split('\n')[0]
        .trim();
      // format: "authorization: Bearer sk-ant-..."
      expect(authHeaderLine.toLowerCase()).toMatch(/^authorization:\s+bearer\s+/);
    },
    90_000,
  );

  // ── AC2: valid SA token + unknown authority → 403, no Authorization header ─
  it(
    'AC2: valid SA token + unknown.example.com → 403 with no Authorization header',
    () => {
      const token = execSync(
        `kubectl create token kubeclaw-tool-job ` +
          `--audience kubeclaw-credential-broker -n ${NS}`,
        { encoding: 'utf8' },
      ).trim();

      const brokerUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/authz`;

      const curlOutput = execSync(
        `kubectl --namespace ${NS} run authz-ac2 --rm -i --restart=Never ` +
          `--image=curlimages/curl:8.10.1 ` +
          `-- curl -sS -i -X POST ${brokerUrl} ` +
          `-H "Authorization: Bearer ${token}" ` +
          `-H "X-Forwarded-Authority: unknown.example.com"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 },
      );

      // Must be 403
      expect(curlOutput).toContain('HTTP/1.1 403');
      // Must NOT contain an Authorization response header
      const lowerOutput = curlOutput.toLowerCase();
      // The response headers section ends at the first blank line.
      // Search only up to that boundary.
      const headerEnd = lowerOutput.indexOf('\r\n\r\n');
      const headersSection =
        headerEnd >= 0 ? lowerOutput.slice(0, headerEnd) : lowerOutput;
      // "authorization:" should not appear in the response headers
      // (exclude the first line which contains the Authorization request echo)
      const headerLines = headersSection.split('\n').slice(1); // skip status line
      const hasAuthHeader = headerLines.some((line) =>
        line.trimStart().startsWith('authorization:'),
      );
      expect(hasAuthHeader).toBe(false);
    },
    90_000,
  );

  // ── AC3: no Authorization header → 401 ────────────────────────────────────
  it(
    'AC3: request with no Authorization header → 401 regardless of authority',
    () => {
      const brokerUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/authz`;

      // No -H "Authorization: ..." — broker receives no Bearer token.
      const curlOutput = execSync(
        `kubectl --namespace ${NS} run authz-ac3 --rm -i --restart=Never ` +
          `--image=curlimages/curl:8.10.1 ` +
          `-- curl -sS -i -X POST ${brokerUrl} ` +
          `-H "X-Forwarded-Authority: api.anthropic.com"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 },
      );

      expect(curlOutput).toContain('HTTP/1.1 401');
    },
    90_000,
  );

  // ── AC4: GET /metrics returns credential_broker_authz_total ───────────────
  //
  // By the time this test runs, AC1–AC3 will have exercised 200, 403, and 401
  // outcomes so the counter should carry all three labels.
  //
  // We port-forward broker port 9090 to localhost and curl /metrics.
  it(
    'AC4: GET /metrics returns credential_broker_authz_total with 200/403/401 labels',
    async () => {
      // Kill any stale port-forward on our chosen local port (best-effort).
      spawnSync('pkill', ['-f', `port-forward.*${METRICS_LOCAL_PORT}`], {
        stdio: 'pipe',
      });

      // Start port-forward in the background.
      const pf = spawn(
        'kubectl',
        [
          '-n',
          NS,
          'port-forward',
          'deployment/kubeclaw-credential-broker',
          `${METRICS_LOCAL_PORT}:9090`,
        ],
        { stdio: 'ignore', detached: true },
      );
      pf.unref();

      try {
        // Poll until the port-forward is responsive or timeout.
        const deadline = Date.now() + 20_000;
        let metricsText = '';
        while (Date.now() < deadline) {
          try {
            metricsText = execSync(
              `curl -sf http://localhost:${METRICS_LOCAL_PORT}/metrics`,
              { encoding: 'utf8', timeout: 3_000 },
            );
            break; // success
          } catch {
            // not ready yet — wait briefly and retry
            await new Promise((r) => setTimeout(r, 1_000));
          }
        }

        // The metric family must be present.
        expect(metricsText).toContain('credential_broker_authz_total');

        // AC1 produced a 200; AC2 produced a 403; AC3 produced a 401.
        // Each must appear in the metrics output.
        expect(metricsText).toMatch(/credential_broker_authz_total.*status="200"/);
        expect(metricsText).toMatch(/credential_broker_authz_total.*status="403"/);
        expect(metricsText).toMatch(/credential_broker_authz_total.*status="401"/);
      } finally {
        try {
          process.kill(pf.pid!);
        } catch {
          // already gone
        }
      }
    },
    60_000,
  );
});
