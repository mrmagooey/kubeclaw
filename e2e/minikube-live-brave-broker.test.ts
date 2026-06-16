/**
 * Minikube-live e2e: Brave Search egress is broker-stamped (operator-fallback).
 *
 * ── What this test proves ────────────────────────────────────────────────────
 *
 * When `credentialInjection.mode=sidecar`, a workload that would send
 * `KC_PH_FALLBACK_brave-search` in its `X-Subscription-Token` header causes
 * the broker to record a 200 authz decision with `catalogId=brave-search` and
 * `keySource=operatorFallback` for `destination=api.search.brave.com`. This
 * proves that:
 *   (a) The chart now wires `secrets.braveApiKey` → `kubeclaw-secrets[brave-search]`.
 *   (b) The broker's `operatorSecretReader("brave-search")` resolves the key.
 *   (c) The broker supports header-position substitution for brave-search
 *       (`allowedPositions: [header]`), meaning the Envoy Lua script can
 *       substitute `KC_PH_FALLBACK_brave-search` in `X-Subscription-Token`.
 *
 * ── Assertion strategy ───────────────────────────────────────────────────────
 *
 * No real Brave API call is made. The test:
 *   a) Skips if `LIVE_BRAVE_API_KEY` is unset.
 *   b) Deploys a fresh kubeclaw release in sidecar mode with
 *      `--set secrets.braveApiKey=${LIVE_BRAVE_API_KEY}`.
 *   c) Spawns a probe pod that calls the broker /authz endpoint directly with
 *      `X-Forwarded-Authority: api.search.brave.com` and a projected SA token.
 *   d) Asserts the broker returns HTTP 200 with an `x-kubeclaw-substitutions`
 *      header containing `KC_PH_FALLBACK_brave-search=<base64(real_key)>`.
 *   e) Reads the broker pod logs and asserts a JSON audit line with
 *      `keySource=operatorFallback`, `catalogId=brave-search`,
 *      `destination=api.search.brave.com`, `status=200`.
 *
 * ── Header substitution note ─────────────────────────────────────────────────
 *
 * The broker does NOT directly stamp `X-Subscription-Token`. Instead it
 * returns `x-kubeclaw-substitutions: KC_PH_FALLBACK_brave-search=<b64>` and
 * Envoy Lua performs the placeholder replacement in the actual request headers
 * at egress time. The authz /authz endpoint call in this test proves the broker
 * side of the substitution chain; the Envoy Lua side is tested by the sidecar
 * integration tests.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *
 * - A running minikube/kind cluster with `kubectl` on PATH.
 * - `kubeclaw-orchestrator:latest` present in the cluster's docker daemon.
 * - `LIVE_BRAVE_API_KEY` env var set (gitignored in `.env.test.local`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { acquireClusterLock } from './lib/per-test-cluster.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-brave-broker';
const RELEASE = 'ke2e-brave-broker';
/** SA token audience the broker validates via TokenReview. */
const BROKER_AUDIENCE = 'kubeclaw-credential-broker';

// ── Live-key guard ────────────────────────────────────────────────────────────
//
// The test is skipped (not failed) when the live key is absent, matching the
// pattern used by other live-credential minikube tests.

const LIVE_BRAVE_API_KEY = process.env.LIVE_BRAVE_API_KEY ?? '';

// ── Cluster availability guard ────────────────────────────────────────────────

const hasCluster =
  spawnSync('kubectl', ['cluster-info'], { stdio: 'pipe' }).status === 0;

const shouldRun = hasCluster && LIVE_BRAVE_API_KEY.length > 0;

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

function tagBrokerImage(): string {
  const tag = 'kubeclaw-orchestrator:e2e-brave-broker';
  if (process.env.KC_E2E_SKIP_BUILD === '1') return tag;
  const profileFlag = process.env.KUBECLAW_MINIKUBE_PROFILE
    ? `-p ${process.env.KUBECLAW_MINIKUBE_PROFILE}`
    : '';
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

function createDummyCASecret(): void {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-brave-ca-'));
  try {
    execSync(
      `openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 ` +
        `-keyout ${tmp}/tls.key -out ${tmp}/tls.crt -days 1 ` +
        `-subj "/CN=kubeclaw-e2e-brave-broker-ca"`,
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

describe.skipIf(!shouldRun)(
  'minikube-live: Brave Search egress is broker-stamped (sidecar mode, operator-fallback)',
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

      // Install with mode=sidecar and secrets.braveApiKey set so the chart
      // creates kubeclaw-secrets with the brave-search catalog-id key that
      // operatorSecretReader uses to resolve the operator-fallback credential.
      execSync(
        `helm upgrade --install ${RELEASE} ./helm/kubeclaw -n ${NS} ` +
          `--set namespace=${NS} ` +
          `--set credentialInjection.mode=sidecar ` +
          `--set credentialInjection.internalCA.autoProvision=false ` +
          `--set credentialInjection.broker.image=${image} ` +
          `--set secrets.braveApiKey=${LIVE_BRAVE_API_KEY} ` +
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

    // ── Test 2: brave-search catalog entry is present in broker config ────────

    it('broker ConfigMap includes brave-search catalog entry with allowOperatorFallback=true', () => {
      const cm = k(
        `get configmap kubeclaw-credential-broker-config ` +
          `-o 'jsonpath={.data.config\\.yaml}'`,
      );
      expect(cm, 'broker config must contain brave-search catalog entry').toContain('id: "brave-search"');
      expect(cm, 'broker config must allow operator fallback for brave-search').toContain(
        'allowOperatorFallback: true',
      );
      expect(cm, 'broker config must list api.search.brave.com as the brave-search host').toContain(
        'host: "api.search.brave.com"',
      );
    });

    // ── Test 3: Brave broker substitution (operator-fallback) ─────────────────
    //
    // A probe pod calls the broker /authz endpoint with:
    //   X-Forwarded-Authority: api.search.brave.com
    //   Authorization: Bearer <projected SA token for kubeclaw-tool-job>
    //
    // The broker resolves the catalog entry for api.search.brave.com, finds no
    // per-group secret (the probe has no owner-group), falls back to the
    // operator key (operatorFallback), and returns:
    //   HTTP 200
    //   x-kubeclaw-substitutions: KC_PH_FALLBACK_brave-search=<base64(BRAVE_KEY)>
    //   x-kubeclaw-policy: positions=header;per=10;total=50
    //
    // The test asserts:
    //   (a) The broker returned 200.
    //   (b) The substitutions header maps KC_PH_FALLBACK_brave-search to the real key.
    //   (c) The broker audit log records keySource=operatorFallback,
    //       catalogId=brave-search, destination=api.search.brave.com, status=200.
    //
    // No real Brave Search API call is made.

    it(
      'broker returns 200 with operatorFallback substitution for api.search.brave.com; audit log confirms',
      async () => {
        const podName = 'probe-brave-broker';

        execSync(
          `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
          { stdio: 'pipe' },
        );

        const brokerUrl = `http://kubeclaw-credential-broker.${NS}.svc:8080/authz`;

        const script = [
          'set -e',
          'sleep 2',
          'TOKEN=$(cat /var/run/secrets/tokens/broker-token)',
          `AUTHZ_STATUS=$(curl -sS -D /tmp/authz-hdrs.txt -o /dev/null -w "%{http_code}" \\`,
          `  -H "Authorization: Bearer $TOKEN" \\`,
          `  -H "X-Forwarded-Authority: api.search.brave.com" \\`,
          `  -X POST ${brokerUrl})`,
          'echo "AUTHZ_STATUS=$AUTHZ_STATUS"',
          'cat /tmp/authz-hdrs.txt',
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
            annotations: { 'kubeclaw.io/owner-group': 'e2e-brave-broker-test' },
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

        const tmp = mkdtempSync(path.join(tmpdir(), 'ke2e-brave-pod-'));
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

          // (a) The broker returned 200.
          expect(logs, 'broker authz must return 200 for api.search.brave.com').toContain(
            'AUTHZ_STATUS=200',
          );

          // (b) The substitutions header maps KC_PH_FALLBACK_brave-search → LIVE_BRAVE_API_KEY.
          const subMatch = logs.match(/SUB_HEADER=(.+)/);
          const subHeader = subMatch?.[1]?.trim() ?? '';
          expect(subHeader, 'x-kubeclaw-substitutions header must be present').toBeTruthy();

          // The wire format is: placeholder=base64(realValue)[;placeholder2=…]
          // KC_PH_FALLBACK_brave-search is the operator-fallback sentinel emitted by
          // the resolver (FALLBACK_SENTINEL_PREFIX + catalog id).
          const placeholder = 'KC_PH_FALLBACK_brave-search';
          expect(
            subHeader,
            `substitution header must contain placeholder ${placeholder}`,
          ).toContain(placeholder);

          const entry = subHeader.split(';').find((e) => e.startsWith(placeholder));
          expect(
            entry,
            `x-kubeclaw-substitutions header must contain an entry starting with "${placeholder}"; ` +
              `got: "${subHeader}" — header format may have changed or broker did not emit the placeholder`,
          ).toBeDefined();
          const b64 = entry!.slice(placeholder.length + 1); // skip "placeholder="
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          expect(decoded, 'substituted value must be the operator Brave API key').toBe(
            LIVE_BRAVE_API_KEY,
          );
        } finally {
          rmSync(tmp, { recursive: true, force: true });
          execSync(
            `kubectl -n ${NS} delete pod ${podName} --ignore-not-found --wait=false`,
            { stdio: 'pipe' },
          );
        }

        // (c) Broker audit log: keySource=operatorFallback, catalogId=brave-search,
        //     destination=api.search.brave.com, status=200.
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
              j.destination === 'api.search.brave.com' &&
              j.catalogId === 'brave-search' &&
              j.keySource === 'operatorFallback' &&
              j.status === 200,
          );

        expect(
          auditLine,
          'broker audit log must record keySource=operatorFallback, catalogId=brave-search, status=200 for api.search.brave.com',
        ).toBeDefined();
      },
      180_000,
    );
  },
);
