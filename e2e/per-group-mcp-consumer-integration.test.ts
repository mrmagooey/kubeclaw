import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { createConnection } from 'net';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  groupHash,
  scrapeMissingSchemas,
  scaleUpInstance,
} from '../src/per-group-capabilities/index.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { getCachedSchemas } from '../src/per-group-capabilities/schema-cache.js';
import { _resetDiscoveryDepsForTest } from '../src/capabilities/discovery.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isKubernetesAvailable } from './setup.js';
import type { McpToolSchema } from '../src/per-group-capabilities/schema-cache.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const ECHO_IMAGE = 'kubeclaw-echo-mcp:test';

const echoSpec = {
  name: 'echo',
  kind: 'mcp' as const,
  image: ECHO_IMAGE,
  scope: 'group' as const,
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

/**
 * Port-forward a Kubernetes service to the given local port, returning the
 * local base URL and a cleanup function. Waits until the port-forward is
 * accepting TCP connections before returning.
 */
async function portForwardService(
  namespace: string,
  serviceName: string,
  remotePort: number,
  localPort: number,
  timeoutMs = 30_000,
): Promise<{ url: string; stop: () => void }> {
  const pfArgs = [
    'port-forward',
    '-n',
    namespace,
    `svc/${serviceName}`,
    `${localPort}:${remotePort}`,
  ];
  const proc = spawn('kubectl', pfArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain stdout/stderr so the subprocess doesn't block on a full pipe buffer.
  let pfOutput = '';
  proc.stdout?.on('data', (d: Buffer) => { pfOutput += d.toString(); });
  proc.stderr?.on('data', (d: Buffer) => { pfOutput += d.toString(); });

  const stop = (): void => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore if already gone
    }
  };

  // Wait until the local TCP port is accepting connections. Use net.createConnection
  // (lower level than fetch) to avoid any HTTP-layer complications in the test runner.
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    await new Promise<void>((resolve) => {
      const socket = createConnection({ port: localPort, host: '127.0.0.1' }, () => {
        // Graceful close: let the port-forward handle the FIN properly.
        socket.end(() => {
          lastErr = null;
          resolve();
        });
      });
      socket.on('error', (err) => {
        lastErr = err;
        socket.destroy();
        resolve();
      });
      socket.setTimeout(1000, () => {
        lastErr = new Error('socket timeout');
        socket.destroy();
        resolve();
      });
    });
    if (lastErr === null) break;
  }
  if (lastErr !== null) {
    stop();
    throw new Error(
      `port-forward svc/${serviceName} did not become ready within ${timeoutMs}ms: ${lastErr}\nkubectl output: ${pfOutput}`,
    );
  }

  // Give kubectl port-forward a moment to stabilise after the probe connection.
  await new Promise((r) => setTimeout(r, 500));

  return { url: `http://localhost:${localPort}`, stop };
}

describe.skipIf(!K8S_AVAILABLE)('per-group MCP consumer (real K8s + Redis)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    try {
      sh(
        `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
      );
    } catch (err) {
      console.warn('namespace setup failed:', err);
    }
    try {
      sh(`./container/echo-mcp/build.sh ${ECHO_IMAGE}`);
    } catch {
      console.warn('echo-mcp build failed.');
    }
    try {
      sh(`minikube image load ${ECHO_IMAGE} 2>&1 || true`);
    } catch {
      // Not using minikube; assume image is reachable.
    }
    await _initTestDatabase();
  }, 300_000);

  afterEach(async () => {
    try {
      await client?.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
    } catch (err) {
      console.warn('afterEach cleanup failed:', err);
    }
    _resetDiscoveryDepsForTest();
  });

  it('schema scraper end-to-end: scales up, scrapes tools/list, caches, scales back', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['e2e-pgc-scraper'],
      specs: [echoSpec],
    });

    const hash = groupHash('e2e-pgc-scraper');
    const serviceName = `mcp-echo-${hash}`;

    // Manually scale up before port-forwarding so kubectl can proxy a live pod.
    const scaleRes = await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder: 'e2e-pgc-scraper',
      capabilityName: 'echo',
      timeoutMs: 60_000,
    });
    expect(scaleRes.state).toBe('ready');

    // Establish port-forward to the running pod via the service.
    // The pod is guaranteed ready at this point (scaleUpInstance returned).
    const pf = await portForwardService(NAMESPACE, serviceName, 3000, 19301, 30_000);

    // Keep the port-forward alive by continuously pinging it in the background.
    // Without this, the port-forward process may idle-timeout or be reaped.
    let keepAlive = true;
    const keepAliveLoop = (async () => {
      while (keepAlive) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch(`${pf.url}/health`);
          void res.body?.cancel();
        } catch {
          // ignore; the port-forward may be closing
        }
      }
    })();

    try {
      // callToolsList receives the cluster-internal URL from the scraper; we
      // ignore it and use the already-established local port-forward instead.
      const callToolsList = async (_endpointUrl: string): Promise<McpToolSchema[]> => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`${pf.url}/mcp`),
        );
        const mcp = new McpClient(
          { name: 'test-scraper', version: '0.0.1' },
          { capabilities: {} },
        );
        await mcp.connect(transport);
        try {
          const res = await mcp.listTools();
          return (res.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })) as McpToolSchema[];
        } finally {
          await transport.close();
        }
      };

      await scrapeMissingSchemas({
        client,
        namespace: NAMESPACE,
        specs: [echoSpec],
        callToolsList,
        scrapeTimeoutMs: 60_000,
      });
    } finally {
      keepAlive = false;
      await keepAliveLoop;
      pf.stop();
    }

    const cached = getCachedSchemas('echo', ECHO_IMAGE);
    expect(cached).not.toBeNull();
    expect(cached?.some((s) => s.name === 'echo')).toBe(true);

    // Scraper should scale the deployment back to 0 after scraping.
    const dep = await client.readDeployment(NAMESPACE, `mcp-echo-${hash}`);
    expect(dep?.spec?.replicas).toBe(0);
  }, 180_000);

  it('discovery client round-trip: scale up instance, verify endpoint, MCP call returns expected result', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['e2e-pgc-disco'],
      specs: [echoSpec],
    });

    // Scale up the per-group instance directly. This exercises the full K8s
    // scale-up path (patch replicas → waitForReady) and returns the
    // cluster-internal endpoint URL. The Redis-stream IPC is tested by the
    // discovery unit tests; here we care about the K8s + MCP HTTP layer.
    const scaleRes = await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder: 'e2e-pgc-disco',
      capabilityName: 'echo',
      timeoutMs: 90_000,
    });
    expect(scaleRes.state).toBe('ready');
    if (scaleRes.state !== 'ready') return;

    // The returned endpoint is cluster-internal (svc.cluster.local).
    expect(scaleRes.endpoint).toMatch(/^http:\/\/mcp-echo-/);

    // Make a real MCP call via port-forward so the host can reach the
    // cluster-internal service.
    const hash = groupHash('e2e-pgc-disco');
    const serviceName = `mcp-echo-${hash}`;
    const pf = await portForwardService(NAMESPACE, serviceName, 3000, 19302, 30_000);
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${pf.url}/mcp`),
      );
      const mcp = new McpClient(
        { name: 'test-call', version: '0.0.1' },
        { capabilities: {} },
      );
      await mcp.connect(transport);
      try {
        const result = await mcp.callTool({
          name: 'echo',
          arguments: { msg: 'hi' },
        });
        const content = result.content as Array<{
          type?: string;
          text?: string;
        }>;
        const text = content[0]?.text;
        expect(text).toBe('hi');
      } finally {
        await transport.close();
      }
    } finally {
      pf.stop();
    }
  }, 240_000);
});
