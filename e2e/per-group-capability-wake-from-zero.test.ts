/**
 * End-to-end test for Story 39 — per-group capability wakes from zero on first
 * use after scale-down.
 *
 * Target:   kind cluster `kubeclaw-e2e-istio`
 * Namespace: `kubeclaw-e2e-cap-wakeup`
 * Port:      14123
 *
 * Pre-requisites:
 *   - `kind load docker-image kubeclaw-echo:e2e-test --name kubeclaw-e2e-istio`
 *   - Echo image must serve GET /health → 200 (for waitForReady polling).
 *   - A running Redis accessible via KUBECLAW_REDIS_URL or default localhost:6379.
 *
 * This file is intentionally not run in CI unless the kind cluster is present.
 * It is skipped automatically when `kubectl cluster-info` fails.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { acquireClusterLock } from './lib/per-test-cluster.js';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  gcGroup,
  groupHash,
} from '../src/per-group-capabilities/index.js';
import {
  __handleRequestForTest,
  setDiscoveryDeps,
  _resetDiscoveryDepsForTest,
} from '../src/capabilities/discovery.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { setCapability } from '../src/capabilities/db.js';
import { getInstance } from '../src/per-group-capabilities/db.js';
import type { CapabilityDiscoveryEntry } from '../src/capabilities/types.js';
import { isKubernetesAvailable } from './setup.js';

// ── Config ─────────────────────────────────────────────────────────────────

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.CAP_WAKEUP_NAMESPACE ?? 'kubeclaw-e2e-cap-wakeup';
const ECHO_IMAGE = 'kubeclaw-echo:e2e-test';
const DISCOVERY_TIMEOUT_MS = 60_000;  // AC1: wake within 60 s
const REDIS_URL =
  process.env.KUBECLAW_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

// Two groups to test per-group isolation (AC5).
const ALICE_GROUP = 'http-http-alice';
const BOB_GROUP = 'http-http-bob';

const echoSpec = {
  kind: 'mcp' as const,
  name: 'echo',
  image: ECHO_IMAGE,
  scope: 'group' as const,
  // Test scales deployment to zero manually; this value doesn't drive the test,
  // but the validator enforces a minimum of 60s (see validateScopeFields).
  scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: false,
  credentialsFrom: 'none' as const,
  resources: {
    memoryRequest: '64Mi',
    memoryLimit: '128Mi',
    cpuRequest: '50m',
    cpuLimit: '200m',
  },
};

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!K8S_AVAILABLE)('Story 39 — per-group capability wake from zero (e2e)', () => {
  let k8sClient: RealPerGroupK8sClient;
  let redis: Redis;

  let releaseClusterLock: (() => void) | null = null;

  beforeAll(async () => {
    // Serialise with other helm-installing e2e tests so we don't race them
    // for shared minikube docker/image state.
    releaseClusterLock = await acquireClusterLock();

    // Ensure namespace exists.
    try {
      sh(
        `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
      );
    } catch (err) {
      console.warn('namespace setup warning:', err);
    }

    // Build the echo image into minikube's docker daemon so the in-cluster
    // capability pod can pull it locally. Idempotent — docker build is a no-op
    // on cache hits. Falls back to `kind load` for legacy kind environments.
    try {
      sh(
        'eval $(minikube docker-env) && ' +
          `docker build -t ${ECHO_IMAGE} -f container/echo-mcp/Dockerfile container/echo-mcp`,
      );
    } catch {
      try {
        sh(`kind load docker-image ${ECHO_IMAGE} --name kubeclaw-e2e-istio 2>&1 || true`);
      } catch {
        // Not using kind either — assume image already present.
      }
    }

    await _initTestDatabase();

    // Connect to Redis for response verification.
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      await redis.ping();
    } catch (err) {
      console.warn(`Redis at ${REDIS_URL} not reachable — some assertions may be skipped.`);
    }
  }, 600_000);

  beforeEach(() => {
    __resetDbForTest();
    _resetDiscoveryDepsForTest();
    k8sClient = new RealPerGroupK8sClient();
    setCapability(echoSpec);
  });

  afterAll(async () => {
    // Clean up both test groups.
    for (const group of [ALICE_GROUP, BOB_GROUP]) {
      try {
        await gcGroup({ client: new RealPerGroupK8sClient(), namespace: NAMESPACE, groupFolder: group });
      } catch (err) {
        console.warn(`afterAll cleanup for ${group} failed:`, err);
      }
    }
    try { await redis.quit(); } catch { /* ignore */ }
    // Delete the namespace and release the cluster lock so the next test
    // can claim it.
    try {
      sh(`kubectl delete namespace ${NAMESPACE} --ignore-not-found --wait=false`);
    } catch { /* ignore */ }
    if (releaseClusterLock) releaseClusterLock();
  });

  it('AC1 – request to scaled-to-zero capability resolves within 60 s (state=ready)', async () => {
    // Provision alice and bob groups.
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [ALICE_GROUP],
      specs: [echoSpec],
    });

    const aliceHash = groupHash(ALICE_GROUP);
    const aliceDep = `mcp-echo-${aliceHash}`;

    // Scale alice to zero (simulating sweeper action).
    await k8sClient.patchDeploymentReplicas(NAMESPACE, aliceDep, 0);

    // Wire discovery deps.
    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    const requestId = randomUUID();
    await __handleRequestForTest({
      requestId,
      capability: 'echo',
      group: ALICE_GROUP,
    });

    // Read the discovery response from Redis.
    const raw = await redis.get(`kubeclaw:discovery:response:${requestId}`);
    expect(raw, 'discovery response must be written to Redis').not.toBeNull();

    const result = JSON.parse(raw!) as CapabilityDiscoveryEntry[];
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('ready');
    expect(result[0].endpoint).toContain(aliceDep);
  }, 90_000); // outer timeout > 60 s to allow setup overhead

  it('AC2 – orchestrator log contains per_group_capability_scale_up with coldStartMs >= 0', async () => {
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [ALICE_GROUP],
      specs: [echoSpec],
    });

    const aliceHash = groupHash(ALICE_GROUP);
    const aliceDep = `mcp-echo-${aliceHash}`;
    await k8sClient.patchDeploymentReplicas(NAMESPACE, aliceDep, 0);

    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    // Redirect pino logger to capture the structured log entry.
    const loggedScaleUps: Array<{ group: string; capability: string; coldStartMs: number }> = [];
    const { logger: realLogger } = await import('../src/logger.js');
    const origInfo = realLogger.info.bind(realLogger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (realLogger as any).info = (data: unknown, msg?: string) => {
      if (msg === 'per_group_capability_scale_up' && typeof data === 'object' && data !== null) {
        loggedScaleUps.push(data as { group: string; capability: string; coldStartMs: number });
      }
      origInfo(data as Parameters<typeof origInfo>[0], msg ?? '');
    };

    try {
      await __handleRequestForTest({
        requestId: randomUUID(),
        capability: 'echo',
        group: ALICE_GROUP,
      });
    } finally {
      // Restore original logger.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (realLogger as any).info = origInfo;
    }

    expect(loggedScaleUps).toHaveLength(1);
    expect(loggedScaleUps[0].group).toBe(ALICE_GROUP);
    expect(loggedScaleUps[0].capability).toBe('echo');
    expect(loggedScaleUps[0].coldStartMs).toBeGreaterThanOrEqual(0);
  }, 90_000);

  it('AC3 – second concurrent request from same user is answered after readiness', async () => {
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [ALICE_GROUP],
      specs: [echoSpec],
    });

    const aliceHash = groupHash(ALICE_GROUP);
    const aliceDep = `mcp-echo-${aliceHash}`;
    await k8sClient.patchDeploymentReplicas(NAMESPACE, aliceDep, 0);

    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    const reqA = randomUUID();
    const reqB = randomUUID();

    // Fire two concurrent discovery requests.
    await Promise.all([
      __handleRequestForTest({ requestId: reqA, capability: 'echo', group: ALICE_GROUP }),
      __handleRequestForTest({ requestId: reqB, capability: 'echo', group: ALICE_GROUP }),
    ]);

    // Both responses must be present.
    const [rawA, rawB] = await Promise.all([
      redis.get(`kubeclaw:discovery:response:${reqA}`),
      redis.get(`kubeclaw:discovery:response:${reqB}`),
    ]);
    expect(rawA, 'first request must get a response').not.toBeNull();
    expect(rawB, 'second request must get a response').not.toBeNull();

    const resA = JSON.parse(rawA!) as CapabilityDiscoveryEntry[];
    const resB = JSON.parse(rawB!) as CapabilityDiscoveryEntry[];
    expect(resA[0].state).toBe('ready');
    expect(resB[0].state).toBe('ready');
  }, 120_000);

  it('AC4 – after wake, kubectl shows replicas=1 and last_used_at updated', async () => {
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [ALICE_GROUP],
      specs: [echoSpec],
    });

    const aliceHash = groupHash(ALICE_GROUP);
    const aliceDep = `mcp-echo-${aliceHash}`;
    await k8sClient.patchDeploymentReplicas(NAMESPACE, aliceDep, 0);

    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    const beforeTs = Math.floor(Date.now() / 1000);
    await __handleRequestForTest({
      requestId: randomUUID(),
      capability: 'echo',
      group: ALICE_GROUP,
    });

    // kubectl check: deployment replicas=1, readyReplicas=1.
    const kubectlOut = sh(
      `kubectl get deployment -l kubeclaw.io/capability=echo,kubeclaw.io/group-hash=${aliceHash} ` +
      `-n ${NAMESPACE} -o jsonpath='{.items[0].spec.replicas}'`,
    );
    expect(kubectlOut.trim()).toBe('1');

    // DB check: last_used_at updated.
    const inst = getInstance(ALICE_GROUP, 'echo');
    expect(inst?.currentReplicas).toBe(1);
    expect(inst?.lastUsedAt).toBeGreaterThanOrEqual(beforeTs);
  }, 90_000);

  it('AC5 – bob deployments are NOT woken by alice request', async () => {
    // Provision both groups.
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [ALICE_GROUP, BOB_GROUP],
      specs: [echoSpec],
    });

    const aliceHash = groupHash(ALICE_GROUP);
    const bobHash = groupHash(BOB_GROUP);
    const aliceDep = `mcp-echo-${aliceHash}`;
    const bobDep = `mcp-echo-${bobHash}`;

    // Scale both to zero.
    await k8sClient.patchDeploymentReplicas(NAMESPACE, aliceDep, 0);
    await k8sClient.patchDeploymentReplicas(NAMESPACE, bobDep, 0);

    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
    });

    // Only alice sends a request.
    await __handleRequestForTest({
      requestId: randomUUID(),
      capability: 'echo',
      group: ALICE_GROUP,
    });

    // Alice woke up.
    const aliceDepObj = await k8sClient.readDeployment(NAMESPACE, aliceDep);
    expect(aliceDepObj?.spec?.replicas).toBe(1);

    // Bob remains at replicas=0 — per-group isolation confirmed.
    const bobDepObj = await k8sClient.readDeployment(NAMESPACE, bobDep);
    expect(
      bobDepObj?.spec?.replicas,
      "bob's deployment must remain at 0 after alice's request",
    ).toBe(0);

    // kubectl double-check for bob.
    const kubectlBob = sh(
      `kubectl get deployment -l kubeclaw.io/capability=echo,kubeclaw.io/group-hash=${bobHash} ` +
      `-n ${NAMESPACE} -o jsonpath='{.items[0].spec.replicas}'`,
    );
    expect(kubectlBob.trim()).toBe('0');
  }, 120_000);
});
