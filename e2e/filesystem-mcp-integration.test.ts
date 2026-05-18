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
import {
  getCachedSchemas,
  type McpToolSchema,
} from '../src/per-group-capabilities/schema-cache.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const BUNDLE_IMAGE = 'kubeclaw-mcp-bundle:test';

const fsSpec = {
  name: 'filesystem',
  kind: 'mcp' as const,
  image: BUNDLE_IMAGE,
  scope: 'group' as const,
  scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: true,
  credentialsFrom: 'none' as const,
  command: ['node', '/app/index.js', '--server', 'filesystem', '--root', '/data'],
  env: {
    KUBECLAW_FS_MAX_FILE_BYTES: '104857600',
    NODE_OPTIONS: '--max-old-space-size=384',
  },
  resources: {
    memoryRequest: '128Mi',
    memoryLimit: '512Mi',
    cpuRequest: '50m',
    cpuLimit: '500m',
  },
  allowedTools: [
    'read_file',
    'write_file',
    'list_directory',
    'search_files',
    'create_directory',
  ],
};

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function portForward(
  deployment: string,
  localPort: number,
): Promise<() => void> {
  const proc = spawn(
    'kubectl',
    [
      'port-forward',
      '-n',
      NAMESPACE,
      `deployment/${deployment}`,
      `${localPort}:3000`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Wait until the port is accepting connections.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port: localPort });
      sock.once('connect', () => {
        sock.end();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return () => {
    proc.kill();
  };
}

async function mcpCall(
  localPort: number,
  tool: string,
  args: Record<string, unknown>,
) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${localPort}/mcp`),
  );
  const mcp = new McpClient(
    { name: 'test', version: '0.0.1' },
    { capabilities: {} },
  );
  await mcp.connect(transport);
  try {
    return await mcp.callTool({ name: tool, arguments: args });
  } finally {
    await transport.close();
  }
}

describe.skipIf(!K8S_AVAILABLE)('filesystem MCP (real K8s)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    try {
      sh(
        `kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`,
      );
    } catch (err) {
      console.warn('namespace setup failed:', err);
    }
    // Create the groups PVC that filesystem mounts via subPath. Cross-namespace
    // PVC references aren't supported, so the test namespace needs its own.
    try {
      sh(
        `cat <<'EOF' | kubectl apply -n ${NAMESPACE} -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kubeclaw-groups-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF`,
      );
    } catch (err) {
      console.warn('PVC setup failed:', err);
    }
    try {
      sh(`./container/mcp-bundle/build.sh ${BUNDLE_IMAGE}`);
    } catch {
      console.warn('mcp-bundle build failed.');
    }
    // Load image into the active local cluster. Try minikube first, then kind.
    try {
      sh(`minikube image load ${BUNDLE_IMAGE} 2>&1 || true`);
    } catch {
      /* not minikube */
    }
    try {
      const ctx = sh('kubectl config current-context').trim();
      if (ctx.startsWith('kind-')) {
        const clusterName = ctx.replace(/^kind-/, '');
        sh(`kind load docker-image ${BUNDLE_IMAGE} --name ${clusterName} 2>&1 || true`);
      }
    } catch {
      /* not kind */
    }
    await _initTestDatabase();
  }, 300_000);

  afterEach(async () => {
    try {
      await client?.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
    } catch (err) {
      console.warn('afterEach cleanup failed:', err);
    }
  });

  it('schema scrape end-to-end caches all 5 tools', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-1'],
      specs: [fsSpec],
    });

    const hash = groupHash('fs-itest-1');
    const localPort = 32100;
    await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder: 'fs-itest-1',
      capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const callToolsList = async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${localPort}/mcp`),
        );
        const mcp = new McpClient(
          { name: 't', version: '0' },
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
        specs: [fsSpec],
        callToolsList,
        scrapeTimeoutMs: 60_000,
      });
    } finally {
      stop();
    }
    const cached = getCachedSchemas('filesystem', BUNDLE_IMAGE);
    expect(cached).not.toBeNull();
    const names = (cached ?? []).map((s) => s.name).sort();
    expect(names).toEqual([
      'create_directory',
      'list_directory',
      'read_file',
      'search_files',
      'write_file',
    ]);
  }, 300_000);

  it('write then read round-trips through the per-group pod', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-2'],
      specs: [fsSpec],
    });
    const hash = groupHash('fs-itest-2');
    await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder: 'fs-itest-2',
      capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const localPort = 32101;
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const write = await mcpCall(localPort, 'write_file', {
        path: 'notes.md',
        content: 'hello',
      });
      expect(write.isError).toBeFalsy();
      const read = await mcpCall(localPort, 'read_file', { path: 'notes.md' });
      const text = (read.content?.[0] as { text?: string })?.text;
      expect(text).toBe('hello');
    } finally {
      stop();
    }
  }, 240_000);

  it('path traversal is rejected', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client,
      namespace: NAMESPACE,
      groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-3'],
      specs: [fsSpec],
    });
    const hash = groupHash('fs-itest-3');
    await scaleUpInstance({
      client,
      namespace: NAMESPACE,
      groupFolder: 'fs-itest-3',
      capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const localPort = 32102;
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const out = await mcpCall(localPort, 'read_file', {
        path: '../../etc/passwd',
      });
      expect(out.isError).toBe(true);
      const text = (out.content?.[0] as { text?: string })?.text;
      expect(text).toMatch(/traversal/i);
    } finally {
      stop();
    }
  }, 180_000);
});
