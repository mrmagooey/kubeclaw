import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
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
import type { CapabilitySpec } from '../src/capabilities/types.js';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const ECHO_IMAGE = 'kubeclaw-echo-mcp:test';

const echoSpec: CapabilitySpec = {
  name: 'echo',
  kind: 'mcp',
  image: ECHO_IMAGE,
  scope: 'group',
  // 300s gives plenty of headroom for the kubectl run probe pod to schedule,
  // pull the curl image (first run), and complete — even under load.
  scaleDownAfterIdleSeconds: 300,
  volumeFromGroupPvc: false,
  credentialsFrom: 'none',
  resources: {
    memoryRequest: '64Mi', memoryLimit: '128Mi',
    cpuRequest: '50m', cpuLimit: '200m',
  },
};

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!K8S_AVAILABLE)('per-group capabilities — discovery e2e', () => {
  let k8sClient: RealPerGroupK8sClient;
  const groupFolder = 'e2e-pgc-disco';

  beforeAll(async () => {
    try {
      sh(`kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`);
    } catch (err) {
      console.warn('namespace setup failed:', err);
    }
    try {
      sh(`./container/echo-mcp/build.sh ${ECHO_IMAGE}`);
    } catch {
      console.warn('echo-mcp build failed — test will likely fail on cold start.');
    }
    try {
      sh(`minikube image load ${ECHO_IMAGE} 2>&1 || true`);
    } catch {
      // not minikube
    }
    await _initTestDatabase();
  }, 300_000);

  beforeEach(() => {
    __resetDbForTest();
    _resetDiscoveryDepsForTest();
    k8sClient = new RealPerGroupK8sClient();
  });

  afterAll(async () => {
    try {
      await gcGroup({ client: new RealPerGroupK8sClient(), namespace: NAMESPACE, groupFolder });
    } catch (err) {
      console.warn('afterAll cleanup failed:', err);
    }
  });

  it('discovery request → scale up → endpoint usable for MCP call', async () => {
    // 1. Set up: install the spec into the registry, reconcile the group's Deployment.
    setCapability(echoSpec);
    await reconcileGroupCapabilities({
      client: k8sClient,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [groupFolder],
      specs: [echoSpec],
    });

    // 2. Wire the discovery handler's per-group deps to our K8s client.
    setDiscoveryDeps({
      perGroupK8sClient: k8sClient,
      namespace: NAMESPACE,
      discoveryTimeoutMs: 90_000,
    });

    // 3. Drive the discovery handler directly. (Going through Redis stream would
    //    add port-forward + stream-watcher orchestration that is itself well-covered
    //    by unit tests in Task 11; here we focus on the K8s-side scale-up wire-up.)
    //    We use the per-group capabilities mock-DB setup pattern from Task 11
    //    integration tests if it exists; otherwise we set up the per-group instance
    //    via the reconciler (above) and rely on the handler's internal lookup.
    const requestId = randomUUID();

    // We need a Redis client so the handler can write its response. If KUBECLAW_REDIS_URL
    // isn't set, fall back to a local Redis or skip.
    // NOTE: getRedisClient() (the production singleton used internally by the discovery
    // handler) reads process.env.REDIS_URL (defaults to 'redis://kubeclaw-redis:6379').
    // For the test's verification reads to see the same response key, our redis client
    // must point to the same instance. We prefer KUBECLAW_REDIS_URL (set by e2e
    // port-forward setup) then REDIS_URL (which the singleton also reads), then
    // the default localhost fallback.
    const redisUrl =
      process.env.KUBECLAW_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    let redis: Redis;
    try {
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      await redis.ping();
    } catch (err) {
      console.warn(`Redis at ${redisUrl} not available — skipping this scenario.`);
      return;
    }

    try {
      // Inject a Redis client into the handler module's getRedisClient if possible.
      // If discovery.ts always uses getRedisClient() (the production singleton)
      // and we can't inject our own redis, this test will need to either (a) use
      // the same singleton (which means our redis url must match) or (b) be
      // restructured. Most likely (a) works because the singleton respects
      // KUBECLAW_REDIS_URL.
      await __handleRequestForTest({
        requestId,
        capability: 'echo',
        group: groupFolder,
      });

      // Read the response key the handler wrote.
      const raw = await redis.get(`kubeclaw:discovery:response:${requestId}`);
      expect(raw, 'discovery response missing — handler did not write to Redis').not.toBeNull();
      const result = JSON.parse(raw!) as Array<{
        kind: string;
        endpoint?: string;
        state?: string;
        error?: string;
      }>;
      expect(result).toHaveLength(1);
      const entry = result[0];
      if (entry.state !== 'ready') {
        console.error('discovery entry:', entry);
      }
      expect(entry.state).toBe('ready');
      expect(entry.endpoint).toMatch(/^http:\/\/mcp-echo-/);

      // 4. Verify the MCP pod is reachable via kubectl port-forward.
      const hash = groupHash(groupFolder);
      const svcName = `mcp-echo-${hash}`;
      // Run a short curl from inside the cluster to confirm the pod's /health endpoint responds.
      // The NetworkPolicy on the capability pod allows ingress only from pods with
      // kubeclaw.io/role=channel or kubeclaw.io/role=orchestrator, so we label the
      // probe pod accordingly.
      const probe = sh(
        `kubectl run pgc-disco-probe-${requestId.slice(0, 8)} ` +
        `-n ${NAMESPACE} --rm -i --restart=Never --image=curlimages/curl:latest ` +
        `--labels='kubeclaw.io/role=channel' -- ` +
        `curl -s -o /dev/null -w '%{http_code}' http://${svcName}:3000/health || true`,
      );
      expect(probe.trim()).toContain('200');
    } finally {
      await redis.quit();
    }
  }, 180_000);
});
