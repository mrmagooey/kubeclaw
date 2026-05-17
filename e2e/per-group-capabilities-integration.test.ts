import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  scaleUpInstance,
  sweepIdleInstances,
  gcGroup,
  groupHash,
} from '../src/per-group-capabilities/index.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { touchLastUsed } from '../src/per-group-capabilities/db.js';
import type { McpCapabilitySpec } from '../src/capabilities/types.js';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const ECHO_IMAGE = 'kubeclaw-echo-mcp:test';

const echoSpec: McpCapabilitySpec = {
  kind: 'mcp',
  name: 'echo',
  image: ECHO_IMAGE,
  scope: 'group',
  scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: false,
  credentialsFrom: 'none',
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

describe.skipIf(!K8S_AVAILABLE)('per-group capabilities (real K8s)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    // Ensure namespace exists.
    try {
      sh(
        `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
      );
    } catch (err) {
      console.warn('namespace setup failed; tests may fail:', err);
    }
    // Build echo image and load into minikube (best effort).
    try {
      sh(`./container/echo-mcp/build.sh ${ECHO_IMAGE}`);
    } catch {
      console.warn(
        `echo-mcp build failed; integration tests will likely fail unless ${ECHO_IMAGE} already exists.`,
      );
    }
    try {
      sh(`minikube image load ${ECHO_IMAGE} 2>&1 || true`);
    } catch {
      // Not using minikube; assume image is reachable.
    }
    await _initTestDatabase();
  }, 300_000);

  beforeEach(() => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
  });

  afterEach(async () => {
    // Clean up everything we created in this namespace, regardless of test outcome.
    try {
      await client.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
    } catch (err) {
      console.warn('afterEach cleanup failed:', err);
    }
  });

  it('reconciler creates Deployment+Service+NetworkPolicy at replicas: 0', async () => {
    const groupFolder = 'itest-1';
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc', // doesn't have to exist; volumeFromGroupPvc is false on echoSpec
      groups: [groupFolder],
      specs: [echoSpec],
    });
    const hash = groupHash(groupFolder);
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep).not.toBeNull();
    expect(dep?.spec?.replicas).toBe(0);
    expect(dep?.metadata?.labels?.['kubeclaw.io/managed-by']).toBe(
      'kubeclaw-orchestrator',
    );
    expect(dep?.metadata?.labels?.['kubeclaw.io/capability']).toBe('echo');

    const svc = await client.readService(NAMESPACE, `mcp-echo-${hash}`);
    expect(svc).not.toBeNull();
    expect(svc?.spec?.ports?.[0]?.targetPort).toBe(3000);
  }, 60_000);

  it('scaleUpInstance brings pod to ready then sweeper scales down', async () => {
    const groupFolder = 'itest-2';
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [groupFolder],
      specs: [echoSpec],
    });

    const res = await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder,
      capabilityName: 'echo',
      timeoutMs: 60_000,
    });
    expect(res.state).toBe('ready');

    // Force last_used into the past so the sweeper considers it idle.
    touchLastUsed(groupFolder, 'echo', Math.floor(Date.now() / 1000) - 120);
    await sweepIdleInstances({
      client,
      namespace: NAMESPACE,
      specs: [echoSpec],
    });

    const hash = groupHash(groupFolder);
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep?.spec?.replicas).toBe(0);
  }, 120_000);

  it('gcGroup removes all K8s objects for the group', async () => {
    const groupFolder = 'itest-3';
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: [groupFolder],
      specs: [echoSpec],
    });
    await gcGroup({ client, namespace: NAMESPACE, groupFolder });

    const hash = groupHash(groupFolder);
    expect(
      await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`),
    ).toBeNull();
    expect(await client.readService(NAMESPACE, `mcp-echo-${hash}`)).toBeNull();
  }, 60_000);
});
