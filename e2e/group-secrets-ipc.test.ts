/**
 * e2e tests for Story 8: Group credential secrets via orchestrator IPC.
 *
 * Acceptance criteria:
 *  1. secret.add → K8s Secret kubeclaw-group-secrets-<group> created with base64 data
 *  2. secret.list → { ok: true, result: [{ catalogId, registeredAt }] } (no raw values)
 *  3. secret.remove → K8s Secret deleted (was the only entry)
 *  4. catalog.list → { ok: true, result: [...] } with at least one entry matching helm catalog
 *  5. secret.add with unknown catalogId → { ok: false, error: "unknown_catalog_entry" }
 *
 * Prerequisites:
 *  - minikube cluster (context: minikube)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup from racing this install)
 *
 * IPC contract:
 *  - Stream: kubeclaw:task-requests (getTaskRequestStream())
 *  - All messages MUST include groupFolder (non-empty, valid pattern) or the
 *    orchestrator silently drops them (ipc-redis.ts line 1081: `if (!type || !groupFolder) continue`)
 *  - secret.add fields: type, groupFolder, group, catalogId, fields (JSON string), resultStream
 *  - secret.remove fields: type, groupFolder, group, catalogId, resultStream
 *  - secret.list fields: type, groupFolder, group, resultStream
 *  - catalog.list fields: type, groupFolder, resultStream
 *  - Response written to resultStream as XADD with field 'result' containing JSON
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Redis } from 'ioredis';

const NS = 'kubeclaw-e2e-grpsec';
const RELEASE = 'ke2e-grpsec';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const REDIS_LOCAL_PORT = 16382; // unique — does not conflict with any other e2e test
const REDIS_SERVICE_PORT = 6379;

// The test group name used for secret operations
const TEST_GROUP = 'e2etest';
// groupFolder must be a valid group folder (alphanum + _ -, max 64, no 'global')
const TEST_GROUP_FOLDER = 'e2etest';

// The catalog entry ID declared in the helm install below
const CATALOG_ID = 'replicate';

// Helm install timeout (ms)
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
// How long to wait for a response from the orchestrator IPC
const IPC_BLOCK_MS = 10_000;

let redisPfProc: ChildProcess | null = null;
let redis: Redis | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function kube(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(`kubectl --context ${CONTEXT} --namespace ${NS} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

function kubeGlobal(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(`kubectl --context ${CONTEXT} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send an IPC message to the orchestrator's task-request stream and wait for
 * the response on a unique result stream.
 *
 * All fields are passed as flat key-value pairs to XADD. The caller must
 * include groupFolder (required by ipc-redis.ts to avoid silent drops).
 */
async function ipcRequest(
  r: Redis,
  fields: Record<string, string>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const resultStream = `e2e:grpsec:result:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const allFields: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    allFields.push(k, v);
  }
  allFields.push('resultStream', resultStream);

  await r.xadd('kubeclaw:task-requests', '*', ...allFields);

  const resp = await r.xread(
    'COUNT',
    1,
    'BLOCK',
    IPC_BLOCK_MS,
    'STREAMS',
    resultStream,
    '0',
  );

  if (!resp) throw new Error(`IPC timeout: no response on ${resultStream} within ${IPC_BLOCK_MS}ms`);

  const [[, messages]] = resp as [string, [string, string[]][]][];
  const [, msgFields] = messages[0];
  const obj: Record<string, string> = {};
  for (let i = 0; i < msgFields.length; i += 2) obj[msgFields[i]] = msgFields[i + 1];

  return JSON.parse(obj['result']) as { ok: boolean; result?: unknown; error?: string };
}

/**
 * Wait until the port-forward to Redis is accepting connections.
 */
async function waitForRedisPortForward(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = new Redis({
        host: '127.0.0.1',
        port: REDIS_LOCAL_PORT,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableReadyCheck: false,
      });
      await probe.connect();
      await probe.disconnect();
      return;
    } catch {
      // Not yet ready
    }
    await sleep(1000);
  }
  throw new Error(`Redis port-forward not ready after ${timeoutMs}ms`);
}

// ── Skip guard: only run on the minikube cluster ──────────────

const clusterReachable = (() => {
  try {
    execSync(`kubectl --context ${CONTEXT} cluster-info`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  'group-secrets IPC end-to-end (Story 8)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Clean namespace from any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for full termination
      for (let i = 0; i < 30; i++) {
        const nsOut = kubeGlobal(`get namespace ${NS} 2>/dev/null || echo GONE`, {
          allowFail: true,
        });
        if (nsOut.includes('GONE') || nsOut === '') break;
        await sleep(2000);
      }

      // Install kubeclaw with credential injection enabled and a catalog entry
      execSync(
        [
          `helm --kube-context ${CONTEXT} upgrade --install ${RELEASE} ./helm/kubeclaw`,
          `--namespace ${NS} --create-namespace`,
          `--set namespace=${NS}`,
          `--set image.tag=e2e-test`,
          `--set image.pullPolicy=IfNotPresent`,
          `--set credentialInjection.broker.image=kubeclaw-orchestrator:e2e-test`,
          `--set credentialInjection.mode=sidecar`,
          `--set orchestrator.replicas=1`,
          `--set networkPolicy.enabled=false`,
          `--set-json 'credentialInjection.catalog=[{"id":"replicate","host":"api.replicate.com","upstreamPort":443,"credentialFields":[{"name":"token","envVar":"REPLICATE_API_TOKEN"}],"baseUrlEnvs":{},"allowOperatorFallback":false,"allowedPositions":["header","body"]}]'`,
        ].join(' '),
        { stdio: 'inherit', timeout: 120_000 },
      );
      installed = true;

      // Wait for orchestrator to be ready
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      // Kill any stale port-forward on our local port
      execSync(`fuser -k ${REDIS_LOCAL_PORT}/tcp 2>/dev/null || true`, { shell: true });
      await sleep(500);

      // Start port-forward to Redis service
      redisPfProc = spawn(
        'kubectl',
        [
          '--context', CONTEXT,
          '--namespace', NS,
          'port-forward',
          `svc/kubeclaw-redis`,
          `${REDIS_LOCAL_PORT}:${REDIS_SERVICE_PORT}`,
        ],
        { stdio: 'ignore', detached: false },
      );

      await waitForRedisPortForward(30_000);

      // Retrieve the Redis admin password from the kubeclaw-redis secret
      const adminPassB64 = kube(
        `get secret kubeclaw-redis -o jsonpath={.data.admin-password}`,
      );
      const adminPass = Buffer.from(adminPassB64, 'base64').toString('utf8').trim();

      // Connect to Redis via port-forward with admin credentials
      redis = new Redis({
        host: '127.0.0.1',
        port: REDIS_LOCAL_PORT,
        username: 'orchestrator',
        password: adminPass,
        connectTimeout: 10_000,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
      });

      // Verify connection
      const pong = await redis.ping();
      if (pong !== 'PONG') throw new Error(`Redis ping failed: ${pong}`);
      console.log('[grpsec] Redis connected via port-forward');

      // Give the orchestrator a few extra seconds to finish initialising its
      // secret-management deps (registerSecretDeps is called from index.ts
      // after the orchestrator pod becomes Ready; stream watchers start shortly after)
      await sleep(5000);
    }, INSTALL_TIMEOUT);

    afterAll(async () => {
      if (redis) {
        await redis.quit().catch(() => {});
        redis = null;
      }
      if (redisPfProc) {
        redisPfProc.kill();
        redisPfProc = null;
      }
      if (installed) {
        execSync(
          `helm --kube-context ${CONTEXT} uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
        execSync(
          `kubectl --context ${CONTEXT} delete namespace ${NS} --wait=false 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
      }
    }, 60_000);

    // ── AC1: secret.add creates K8s Secret with base64 data ──────────────────

    it(
      'AC1: secret.add creates K8s Secret with base64-encoded catalogId data',
      async () => {
        const resp = await ipcRequest(redis!, {
          type: 'secret.add',
          groupFolder: TEST_GROUP_FOLDER,
          group: TEST_GROUP,
          catalogId: CATALOG_ID,
          fields: JSON.stringify({ token: 'test-token-value-ac1' }),
        });

        expect(resp.ok, `secret.add failed: ${JSON.stringify(resp)}`).toBe(true);

        // Verify the K8s Secret exists and has base64 data for the catalogId
        const secretData = kube(
          `get secret kubeclaw-group-secrets-${TEST_GROUP} -o jsonpath={.data.${CATALOG_ID}}`,
        );
        expect(secretData, 'K8s Secret data for catalogId must be non-empty').toBeTruthy();

        // The data must be valid base64 (ioredis/kubectl returns b64 as-is)
        const decoded = Buffer.from(secretData, 'base64').toString('utf8');
        const blob = JSON.parse(decoded);
        expect(blob).toHaveProperty('registeredAt');
        expect(blob).toHaveProperty('fields');
        // The raw token must NOT appear in plaintext in the secret value
        // (the blob stores field metadata, not the raw value — it stores value+placeholder)
        // Actually the blob does store the value (used for credential injection);
        // but the IPC *response* must not echo it back. We only verify structure here.
        expect(typeof blob.fields).toBe('object');
      },
      TEST_TIMEOUT,
    );

    // ── AC2: secret.list returns registeredAt without raw values in IPC response ─

    it(
      'AC2: secret.list returns { ok: true, result: [{ catalogId, registeredAt }] } without raw values',
      async () => {
        const resp = await ipcRequest(redis!, {
          type: 'secret.list',
          groupFolder: TEST_GROUP_FOLDER,
          group: TEST_GROUP,
        });

        expect(resp.ok, `secret.list failed: ${JSON.stringify(resp)}`).toBe(true);
        const result = resp.result as Array<{ catalogId: string; registeredAt: string }>;
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);

        const entry = result.find((e) => e.catalogId === CATALOG_ID);
        expect(entry, `Expected entry with catalogId "${CATALOG_ID}" in list result`).toBeDefined();
        expect(typeof entry!.registeredAt).toBe('string');
        expect(entry!.registeredAt).toBeTruthy();

        // The response payload must not contain the raw credential value
        const respStr = JSON.stringify(resp);
        expect(respStr).not.toContain('test-token-value-ac1');
        // Verify no 'value' or 'token' field leaks from the blob
        expect(respStr).not.toContain('"token"');
      },
      TEST_TIMEOUT,
    );

    // ── AC3: secret.remove deletes the K8s Secret when it was the only entry ──

    it(
      'AC3: secret.remove deletes K8s Secret (sole entry)',
      async () => {
        const resp = await ipcRequest(redis!, {
          type: 'secret.remove',
          groupFolder: TEST_GROUP_FOLDER,
          group: TEST_GROUP,
          catalogId: CATALOG_ID,
        });

        expect(resp.ok, `secret.remove failed: ${JSON.stringify(resp)}`).toBe(true);

        // Verify the K8s Secret is gone (404)
        const out = kube(
          `get secret kubeclaw-group-secrets-${TEST_GROUP} 2>&1 || echo NOTFOUND`,
          { allowFail: true },
        );
        expect(out, 'K8s Secret must not exist after sole-entry removal').toMatch(/not found|NOTFOUND/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: catalog.list returns the catalog entry declared in helm values ───

    it(
      'AC4: catalog.list returns at least one entry matching the helm catalog',
      async () => {
        const resp = await ipcRequest(redis!, {
          type: 'catalog.list',
          groupFolder: TEST_GROUP_FOLDER,
        });

        expect(resp.ok, `catalog.list failed: ${JSON.stringify(resp)}`).toBe(true);
        const catalog = resp.result as Array<{ id: string }>;
        expect(Array.isArray(catalog)).toBe(true);

        const entry = catalog.find((e) => e.id === CATALOG_ID);
        expect(
          entry,
          `Expected catalog entry with id "${CATALOG_ID}" — got: ${JSON.stringify(catalog)}`,
        ).toBeDefined();
      },
      TEST_TIMEOUT,
    );

    // ── AC5: secret.add with unknown catalogId returns { ok: false, error: "unknown_catalog_entry" } ─

    it(
      'AC5: secret.add with unknown catalogId returns { ok: false, error: "unknown_catalog_entry" }',
      async () => {
        const unknownId = 'no-such-provider-xyz';

        const resp = await ipcRequest(redis!, {
          type: 'secret.add',
          groupFolder: TEST_GROUP_FOLDER,
          group: TEST_GROUP,
          catalogId: unknownId,
          fields: JSON.stringify({ token: 'should-not-matter' }),
        });

        expect(resp.ok).toBe(false);
        expect((resp as { ok: false; error: string }).error).toBe('unknown_catalog_entry');

        // No K8s Secret must have been created
        const out = kube(
          `get secret kubeclaw-group-secrets-${TEST_GROUP} 2>&1 || echo NOTFOUND`,
          { allowFail: true },
        );
        expect(out, 'No K8s Secret must be created for unknown catalogId').toMatch(/not found|NOTFOUND/i);
      },
      TEST_TIMEOUT,
    );
  },
);
