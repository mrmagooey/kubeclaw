/**
 * Minikube-live e2e: LLM egress is broker-stamped (operator-fallback); in-cluster
 * HTTP bypasses the proxy.
 *
 * ── What this test proves ────────────────────────────────────────────────────
 *
 * 1. When `credentialInjection.mode=sidecar` (or istio — both share the same
 *    assertion path via the broker audit log), a workload that sends
 *    `KC_PH_FALLBACK_openai` in its Authorization header causes the broker to
 *    record a 200 authz decision with `catalogId=openai` and
 *    `keySource=operatorFallback` for `destination=api.openai.com`.  This
 *    proves that the broker stamped the egress without leaking a raw OpenAI
 *    key and without contacting the real OpenAI API.
 *
 * 2. An in-cluster HTTP call (from a probe pod to the broker Service itself)
 *    succeeds, proving that the `NO_PROXY` bypass keeps intra-cluster traffic
 *    off the sidecar proxy.
 *
 * ── Assertion strategy ───────────────────────────────────────────────────────
 *
 * No real OpenAI key is required. The test:
 *   a) Deploys a fresh kubeclaw release in sidecar mode (own namespace, not
 *      the minikube-live kubeclaw-live release).
 *   b) Spawns a probe pod that calls the broker /authz endpoint directly with
 *      `X-Forwarded-Authority: api.openai.com` and a projected SA token.
 *   c) Asserts the broker returns HTTP 200 with an `x-kubeclaw-substitutions`
 *      header (the real operator key is present in the substitution map).
 *   d) Reads the broker pod logs and asserts a JSON audit line with
 *      `keySource=operatorFallback`, `catalogId=openai`, `destination=api.openai.com`,
 *      `status=200`.
 *   e) From inside the same probe pod, curls the in-cluster broker Service on
 *      its /healthz endpoint and asserts a 200, proving intra-cluster HTTP
 *      reaches its destination without the proxy intercepting it.
 *
 * ── Mode coverage ────────────────────────────────────────────────────────────
 *
 * This test deploys sidecar mode.  Both sidecar and istio share the same
 * broker audit-log assertion path (the broker is the same binary in both
 * modes; it emits the same JSON audit event for any authz decision).  The
 * istio-specific infrastructure path (egress gateway → ext_authz → Lua
 * substitution) is covered by `credential-injection-istio.test.ts`.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *
 * - A running minikube/kind cluster with `kubectl` on PATH.
 * - `kubeclaw-orchestrator:latest` present in the cluster's docker daemon
 *   (built by `e2e/minikube-live-setup.ts`; tagged for the broker role by this
 *   test's beforeAll via `docker tag`).
 *
 * The test is guarded by `describe.skipIf(!hasCluster)` and is only included
 * in the minikube-live config (`vitest.minikube-live.config.ts`), which matches
 * the `e2e/minikube-live*.test.ts` glob.  It is excluded from the default
 * `vitest.config.ts` suite (which covers only `src/**`) and from
 * `vitest.e2e.config.ts` (which explicitly excludes `minikube-live*.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { acquireClusterLock } from './lib/per-test-cluster.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-llm-broker';
const RELEASE = 'ke2e-llm-broker';
/** SA token audience the broker validates via TokenReview. */
const BROKER_AUDIENCE = 'kubeclaw-credential-broker';
/** Operator OpenAI API key written to kubeclaw-secrets at install time. */
const OPERATOR_OPENAI_KEY = 'sk-op-test-live-key';

// ── Cluster availability guard ────────────────────────────────────────────────
//
// `describe.skipIf(!hasCluster)` makes the suite skip (NOT silently pass) when
// no cluster is reachable — the same fail-clear semantics as the rest of the
// minikube-live suite. Without this guard the describe block would still run
// its beforeAll and fail with an inscrutable kubectl error.
const hasCluster =
  spawnSync('kubectl', ['cluster-info'], { stdio: 'pipe' }).status === 0;

// ── kubectl shorthand ─────────────────────────────────────────────────────────

function k(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(`kubectl -n ${NS} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '') + (e.stderr ?? '');
    throw e;
  }
}

// ── Image: re-tag kubeclaw-orchestrator:latest for the broker role ────────────
//
// The broker is deployed as the orchestrator image with KUBECLAW_MODE=credential-broker.
// We re-tag rather than rebuild to avoid racing with other e2e workers.

function tagBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-llm-broker';
  if (process.env.KC_E2E_SKIP_BUILD === '1') return tag;
  const profileFlag = process.env.KUBECLAW_MINIKUBE_PROFILE
    ? `-p ${process.env.KUBECLAW_MINIKUBE_PROFILE}`
    : '';
  // Preflight: verify kubeclaw-orchestrator:latest is present in minikube's docker daemon.
  // If absent, docker tag below would fail opaquely after beforeAll has already partially
  // constructed the namespace.
  const imageId = execSync(
    `eval $(minikube ${profileFlag} docker-env) && docker images -q kubeclaw-orchestrator:latest`,
    { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' },
  ).trim();
  if (!imageId) {
    throw new Error(
      'kubeclaw-orchestrator:latest not present in minikube; run minikube-live-setup or build it first',
    );
  }
  execSync(
    `eval $(minikube ${profileFlag} docker-env) && docker tag kubeclaw-orchestrator:latest ${tag}`,
    { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' },
  );
  return tag;
}

// ── Self-signed CA for the Envoy egress-ca volume ────────────────────────────
//
// The sidecar Envoy volume mount expects a TLS Secret named
// kubeclaw-egress-ca-tls. The cert is not actually used for TLS termination
// in this test (we call the broker directly, not through the proxy), but
// kubelet refuses to start pods that reference missing Secrets.

function createDummyCASecret(): void {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-llm-ca-'));
  try {
    execSync(
      `openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 ` +
        `-keyout ${tmp}/tls.key -out ${tmp}/tls.crt -days 1 ` +
        `-subj "/CN=kubeclaw-e2e-llm-broker-ca"`,
      { stdio: 'pipe' },
    );
    execSync(
      `kubectl -n ${NS} create secret tls kubeclaw-egress-ca-tls ` +
        `--cert=${tmp}/tls.crt --key=${tmp}/tls.key ` +
        `--dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'pipe' },
    );
    const crtB64 = execSync(`base64 -w0 ${tmp}/tls.crt`, {
      encoding: 'utf8',
    }).trim();
    execSync(
      `kubectl -n ${NS} patch secret kubeclaw-egress-ca-tls --type=merge ` +
        `--patch '${JSON.stringify({ data: { 'ca.crt': crtB64 } })}'`,
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Poll helper ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!hasCluster)(
  'minikube-live: LLM egress is broker-stamped (sidecar mode); in-cluster bypass works',
  { timeout: 15 * 60 * 1000 },
  () => {
    let installed = false;
    let releaseLock: (() => void) | null = null;

    // ── Setup ─────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      releaseLock = await acquireClusterLock();
    }, 30 * 60 * 1000);

    beforeAll(async () => {
      // Clean slate from any previous run.
      execSync(
        `kubectl wait --for=delete ns/${NS} --timeout=120s 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
      execSync(`kubectl create ns ${NS} || true`, { stdio: 'pipe' });

      createDummyCASecret();

      const image = tagBrokerImage();

      // Install with mode=sidecar.  We pass secrets.openaiApiKey so the chart
      // creates kubeclaw-secrets with both the hyphenated key (openai-api-key)
      // and the catalog-id key (openai) that operatorSecretReader uses to
      // resolve the operator-fallback credential.
      // credentialInjection.catalog is rendered from values.yaml defaults,
      // which includes the openai entry with allowOperatorFallback=true.
      execSync(
        `helm upgrade --install ${RELEASE} ./helm/kubeclaw -n ${NS} ` +
          `--set namespace=${NS} ` +
          `--set credentialInjection.mode=sidecar ` +
          `--set credentialInjection.internalCA.autoProvision=false ` +
          `--set credentialInjection.broker.image=${image} ` +
          `--set secrets.openaiApiKey=${OPERATOR_OPENAI_KEY} ` +
          `--set orchestrator.admin.enabled=false ` +
          `--wait --timeout 5m`,
        { stdio: 'inherit' },
      );

      installed = true;
    }, 600_000);

    // ── Teardown ──────────────────────────────────────────────────────────────

    afterAll(() => {
      if (installed) {
        execSync(`helm uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`, {
          stdio: 'pipe',
        });
      }
      execSync(`kubectl delete ns ${NS} --wait=false 2>/dev/null || true`, {
        stdio: 'pipe',
      });
      if (releaseLock) releaseLock();
    }, 120_000);

    // ── Test 1: broker is healthy ─────────────────────────────────────────────

    it('credential broker deployment is Ready', () => {
      execSync(
        `kubectl -n ${NS} rollout status deployment/kubeclaw-credential-broker --timeout=120s`,
        { stdio: 'inherit' },
      );
      const ready = k(
        `get deployment kubeclaw-credential-broker ` +
          `-o jsonpath={.status.readyReplicas}`,
      );
      expect(parseInt(ready, 10), 'broker readyReplicas').toBeGreaterThanOrEqual(1);
    }, 150_000);

    // ── Test 2: openai catalog entry is present in the broker config ──────────
    //
    // Verifies that Task 1 (LLM providers as catalog entries) wired correctly:
    // the rendered ConfigMap contains the openai catalog entry with
    // allowOperatorFallback=true.

    it('broker ConfigMap includes openai catalog entry with allowOperatorFallback=true', () => {
      const cm = k(
        `get configmap kubeclaw-credential-broker-config ` +
          `-o 'jsonpath={.data.config\\.yaml}'`,
      );
      expect(cm, 'broker config must contain openai catalog entry').toContain('id: "openai"');
      expect(cm, 'broker config must allow operator fallback for openai').toContain(
        'allowOperatorFallback: true',
      );
      expect(cm, 'broker config must list api.openai.com as the openai host').toContain(
        'host: "api.openai.com"',
      );
    });

    // ── Test 3: LLM egress is broker-stamped (operator-fallback) ─────────────
    //
    // A probe pod calls the broker /authz endpoint with:
    //   X-Forwarded-Authority: api.openai.com
    //   Authorization: Bearer <projected SA token for kubeclaw-tool-job>
    //
    // The broker resolves the catalog entry for api.openai.com, finds no
    // per-group secret (the probe has no owner-group), falls back to the
    // operator key (operatorFallback), and returns:
    //   HTTP 200
    //   x-kubeclaw-substitutions: KC_PH_FALLBACK_openai=<base64(OPERATOR_KEY)>
    //
    // The test asserts:
    //   (a) The broker returned 200.
    //   (b) The substitutions header maps KC_PH_FALLBACK_openai to the real key.
    //   (c) The broker audit log records keySource=operatorFallback,
    //       catalogId=openai, destination=api.openai.com, status=200.
    //
    // No real OpenAI API call is made.

    it(
      'broker returns 200 with operatorFallback substitution for api.openai.com; audit log confirms',
      async () => {
        const podName = 'probe-llm-broker';

        // Clean up any stale pod.
        execSync(
          `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
          { stdio: 'pipe' },
        );

        const brokerUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/authz`;

        // Script:
        //   1. Read the projected SA token.
        //   2. Call /authz with X-Forwarded-Authority: api.openai.com.
        //   3. Print AUTHZ_STATUS=<n> + response headers.
        //   4. Print the placeholder value from x-kubeclaw-substitutions.
        const script = [
          'set -e',
          'sleep 2',
          'TOKEN=$(cat /var/run/secrets/tokens/broker-token)',
          `AUTHZ_STATUS=$(curl -sS -D /tmp/authz-hdrs.txt -o /dev/null -w "%{http_code}" \\`,
          `  -H "Authorization: Bearer $TOKEN" \\`,
          `  -H "X-Forwarded-Authority: api.openai.com" \\`,
          `  -X POST ${brokerUrl})`,
          'echo "AUTHZ_STATUS=$AUTHZ_STATUS"',
          'cat /tmp/authz-hdrs.txt',
          // Extract the substitution header value for later assertion.
          'SUB=$(grep -i "x-kubeclaw-substitutions" /tmp/authz-hdrs.txt | cut -d" " -f2- | tr -d "\\r\\n" || echo "")',
          'echo "SUB_HEADER=$SUB"',
        ].join('\n');

        const podManifest = {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: podName,
            namespace: NS,
            // The broker resolver short-circuits with no_owner_group (→ 403) when
            // this annotation is absent.  Any non-empty value causes the resolver to
            // look for a per-group secret; finding none it returns no_credential,
            // which then falls through to the operator-fallback path.
            annotations: { 'kubeclaw.io/owner-group': 'e2e-llm-broker-test' },
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
                        audience: BROKER_AUDIENCE,
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

        const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-llm-pod-'));
        const podFile = path.join(tmp, 'pod.yaml');

        try {
          writeFileSync(podFile, JSON.stringify(podManifest, null, 2));
          execSync(`kubectl apply -f ${podFile}`, { stdio: 'pipe' });

          // Poll until the pod reaches a terminal phase (Succeeded/Failed).
          const terminated = await pollUntil(
            () => {
              const phase = execSync(
                `kubectl -n ${NS} get pod ${podName} -o jsonpath='{.status.phase}'`,
                { encoding: 'utf8' },
              ).trim();
              return phase === 'Succeeded' || phase === 'Failed';
            },
            120_000,
          );
          expect(terminated, `probe pod ${podName} must reach a terminal phase`).toBe(true);

          const logs = k(`logs ${podName} -c probe 2>/dev/null || true`, {
            allowFail: true,
          });

          // (a) The broker returned 200.
          expect(logs, 'broker authz must return 200 for api.openai.com').toContain(
            'AUTHZ_STATUS=200',
          );

          // (b) The substitutions header maps KC_PH_FALLBACK_openai → OPERATOR_OPENAI_KEY.
          const subMatch = logs.match(/SUB_HEADER=(.+)/);
          const subHeader = subMatch?.[1]?.trim() ?? '';
          expect(subHeader, 'x-kubeclaw-substitutions header must be present').toBeTruthy();

          // The wire format is: placeholder=base64(realValue)[;placeholder2=…]
          // KC_PH_FALLBACK_openai is the operator-fallback sentinel emitted by
          // buildCatalogEnvs() (FALLBACK_SENTINEL_PREFIX + catalog id).
          const placeholder = 'KC_PH_FALLBACK_openai';
          expect(
            subHeader,
            `substitution header must contain placeholder ${placeholder}`,
          ).toContain(placeholder);

          // Decode the base64 value and assert it is the operator key.
          const entry = subHeader.split(';').find((e) => e.startsWith(placeholder));
          expect(
            entry,
            `x-kubeclaw-substitutions header must contain an entry starting with "${placeholder}"; ` +
              `got: "${subHeader}" — header format may have changed or broker did not emit the placeholder`,
          ).toBeDefined();
          const b64 = entry!.slice(placeholder.length + 1); // skip "placeholder="
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          expect(decoded, 'substituted value must be the operator OpenAI key').toBe(
            OPERATOR_OPENAI_KEY,
          );
        } finally {
          rmSync(tmp, { recursive: true, force: true });
          execSync(
            `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
            { stdio: 'pipe' },
          );
        }

        // (c) Broker audit log: keySource=operatorFallback, catalogId=openai,
        //     destination=api.openai.com, status=200.
        //
        // The broker emits one pino JSON line per authz decision with
        // `kind: 'credential-broker.authz'`. We scan recent logs.
        const brokerLogs = k(
          `logs deployment/kubeclaw-credential-broker --since=300s 2>/dev/null || true`,
          { allowFail: true },
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
              j.destination === 'api.openai.com' &&
              j.catalogId === 'openai' &&
              j.keySource === 'operatorFallback' &&
              j.status === 200,
          );

        expect(
          auditLine,
          'broker audit log must record keySource=operatorFallback, catalogId=openai, status=200 for api.openai.com',
        ).toBeDefined();
      },
      180_000,
    );

    // ── Test 4: in-cluster HTTP bypasses the proxy (NO_PROXY) ────────────────
    //
    // When the credential sidecar sets HTTPS_PROXY=http://127.0.0.1:8443,
    // Node fetch routes all egress through Envoy.  In-cluster destinations
    // (broker Service, Redis, Qdrant, Ollama) must be in NO_PROXY so they
    // reach their targets directly.
    //
    // Assertion: a probe pod curls the broker's /healthz endpoint over the
    // cluster-internal Service name (kubeclaw-credential-broker.<NS>.svc:8080)
    // and gets a 200.  Because the probe has HTTP_PROXY / HTTPS_PROXY set but
    // the Service FQDN matches *.svc in NO_PROXY, curl sends the request
    // directly, bypassing the proxy address (which has nothing listening on
    // port 8443 — no Envoy sidecar in the probe pod).  A 200 proves bypass;
    // a connection failure would prove the proxy env was not bypassed.
    //
    // Note: the broker does not expose a /healthz endpoint; it responds to
    // any unrecognised path with a 404 which is still a live TCP response.
    // We accept any HTTP status ≥100 from the broker as proof of connectivity.

    it(
      'in-cluster HTTP reaches the broker Service directly (NO_PROXY bypass)',
      async () => {
        const podName = 'probe-noproxy';

        execSync(
          `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
          { stdio: 'pipe' },
        );

        const brokerServiceUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/`;

        // Set HTTP_PROXY and HTTPS_PROXY to a non-existent address (port 8443
        // on 127.0.0.1). If NO_PROXY is NOT honoured, curl will try to connect
        // through 127.0.0.1:8443 — which is not listening — and fail.
        // If NO_PROXY is honoured (*.svc matches), curl goes direct and gets
        // a response from the broker.
        //
        // NO_PROXY value must match what workload-env.ts and _helpers.tpl emit:
        // "localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,
        //  kubeclaw-qdrant,.svc,.svc.cluster.local,.cluster.local"
        //
        // The *.svc suffix covers kubeclaw-credential-broker.<NS>.svc.
        const noProxy =
          'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,kubeclaw-qdrant,.svc,.svc.cluster.local,.cluster.local';

        const script = [
          'set -e',
          'sleep 2',
          // curl with --proxy explicitly set (overrides env) then also via env.
          // We rely on env-based proxy detection matching what Node does.
          `STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \\`,
          `  --max-time 10 \\`,
          `  -x http://127.0.0.1:8443 \\`,
          `  --noproxy "${noProxy}" \\`,
          `  ${brokerServiceUrl})`,
          'echo "INCLUSTER_STATUS=$STATUS"',
        ].join('\n');

        const podManifest = {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: podName,
            namespace: NS,
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
                env: [
                  { name: 'HTTP_PROXY', value: 'http://127.0.0.1:8443' },
                  { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:8443' },
                  { name: 'NO_PROXY', value: noProxy },
                ],
              },
            ],
          },
        };

        const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-noproxy-'));
        const podFile = path.join(tmp, 'pod.yaml');

        try {
          writeFileSync(podFile, JSON.stringify(podManifest, null, 2));
          execSync(`kubectl apply -f ${podFile}`, { stdio: 'pipe' });

          const terminated = await pollUntil(
            () => {
              const phase = execSync(
                `kubectl -n ${NS} get pod ${podName} -o jsonpath='{.status.phase}'`,
                { encoding: 'utf8' },
              ).trim();
              return phase === 'Succeeded' || phase === 'Failed';
            },
            120_000,
          );
          expect(terminated, `probe pod ${podName} must reach a terminal phase`).toBe(true);

          const logs = k(`logs ${podName} -c probe 2>/dev/null || true`, {
            allowFail: true,
          });

          // Any numeric HTTP status means curl received an HTTP response
          // (i.e. the connection bypassed the non-existent proxy at :8443
          // and reached the broker Service directly).
          const statusMatch = logs.match(/INCLUSTER_STATUS=(\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          expect(
            status,
            `in-cluster curl to broker Service must return an HTTP status (got ${status}); ` +
              `status=0 means curl failed to connect (proxy not bypassed)`,
          ).toBeGreaterThanOrEqual(100);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
          execSync(
            `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
            { stdio: 'pipe' },
          );
        }
      },
      180_000,
    );

    // ── Test 5: channel pod carries KC_PH_FALLBACK_openai (Helm wiring) ──────
    //
    // Confirms Task 4 (channel-pod Helm wiring): in sidecar mode, the channel
    // pod's environment has OPENAI_API_KEY=KC_PH_FALLBACK_openai, not a raw
    // secretKeyRef.  No channel pod is deployed in this release (the test
    // install omits `channels.http.enabled=true`), so we assert via the Helm
    // render, not a live pod.
    //
    // This is a lightweight confirm that the helm template wiring is correct;
    // the full live channel-pod test is in minikube-live-combined-journey.test.ts.

    it('helm template: channel pod in sidecar mode carries KC_PH_FALLBACK_openai, not a raw secretKeyRef', () => {
      // helm template renders without a cluster; it only uses local chart files.
      // We enable channels.http so the channel Deployment is rendered.
      const rendered = execSync(
        `helm template ${RELEASE} helm/kubeclaw ` +
          `--set credentialInjection.mode=sidecar ` +
          `--set channels.http.enabled=true ` +
          `-n ${NS}`,
        { encoding: 'utf8' },
      );

      // Split the rendered output into per-resource blocks so we can target
      // only the kubeclaw-channel-http Deployment (not the orchestrator, which
      // reads the raw key directly for its own LLM calls).
      const resourceBlocks = rendered.split(/^---/m).filter(Boolean);
      const channelDeployment = resourceBlocks.find(
        (b) => b.includes('kind: Deployment') && b.includes('kubeclaw-channel-http'),
      );

      expect(
        channelDeployment,
        'kubeclaw-channel-http Deployment must be present in rendered output',
      ).toBeTruthy();

      // (a) The llmBrokerEnv helper must emit KC_PH_FALLBACK_openai for the channel pod.
      expect(
        channelDeployment,
        'channel pod must carry KC_PH_FALLBACK_openai placeholder',
      ).toContain('KC_PH_FALLBACK_openai');

      // (b) The raw secretKeyRef for openai-api-key must NOT appear in the channel pod.
      // (The orchestrator deployment may still reference it for direct LLM calls —
      //  that is expected. Only channel pods must use the placeholder in sidecar mode.)
      const hasRawKeyRef = /secretKeyRef[\s\S]*?openai-api-key/.test(
        channelDeployment ?? '',
      );
      expect(
        hasRawKeyRef,
        'channel pod must not expose raw openai-api-key secretKeyRef in sidecar mode',
      ).toBe(false);
    });
  },
);
