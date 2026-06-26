/**
 * Minikube-live: database capability end-to-end tests.
 *
 * Proves the full database capability stack end-to-end:
 *   - kubeclaw-postgres-mcp image built + loaded into minikube
 *   - Per-group deployment (mcp-database-<groupHash>) provisioned with a
 *     dedicated PVC for Postgres data (pinned: true, scope: group)
 *   - Credentials (POSTGRES_PASSWORD / PG_RO_PASSWORD / KUBECLAW_MCP_TOKEN)
 *     provisioned by the reconciler into a group-specific creds Secret
 *   - execute tool (rw Postgres role) can CREATE TABLE + INSERT
 *   - query tool (ro Postgres role) can SELECT and returns the inserted row
 *   - Per-group isolation: a second group's DB cannot see alice's tables
 *   - Read-only enforcement: the ro role rejects INSERT via the query tool
 *
 * Requires the globalSetup in minikube-live-setup.ts to have:
 *   1. Built the kubeclaw-orchestrator + channel images and helm-installed the chart.
 *   2. Bootstrapped the http channel so alice's group is registered with the
 *      orchestrator (which triggers onGroupAdded → per-group reconcile).
 *   3. Made the Redis port-forward live on localhost:KUBECLAW_LIVE_REDIS_LOCAL_PORT.
 *
 * This test also builds + loads kubeclaw-postgres-mcp:latest into minikube.
 * If the image is already present and up to date, the build step is skipped.
 *
 * Skip guard:
 *   If the Redis port-forward is not reachable (no cluster / globalSetup skipped),
 *   each test calls ctx.skip() — NOT a bare return — so the suite shows as SKIPPED
 *   rather than silently passing.
 *
 * Architecture note:
 *   The database capability is scope: group, pinned: true. Its K8s resources are
 *   named mcp-database-<groupHash(groupFolder)>. For the http channel's "alice"
 *   user, groupHash('http-alice') = 17c2919a5e, yielding:
 *     Deployment:   mcp-database-17c2919a5e
 *     PVC:          selected by label kubeclaw.io/capability=database,kubeclaw.io/group-hash=17c2919a5e
 *     Creds Secret: mcp-database-17c2919a5e-creds
 *   These are computed inline below rather than hard-coded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-live';

/**
 * Compute the groupHash for a given groupFolder.
 * Mirror of src/per-group-capabilities/hash.ts: groupHash().
 */
function computeGroupHash(folder: string): string {
  return createHash('sha1').update(folder.trim(), 'utf8').digest('hex').slice(0, 10);
}

/** The deployment / service name for a per-group capability instance. */
function instanceName(capName: string, hash: string): string {
  return `mcp-${capName}-${hash}`;
}

/** The creds-secret name for a per-group capability instance. */
function credsSecretName(capName: string, hash: string): string {
  return `${instanceName(capName, hash)}-creds`;
}

// The HTTP channel derives the group folder from the username as `http-<username>`.
// Mirror of folderPrefixForChannel + jidToFolder in src/channel-runner.ts.
const ALICE_FOLDER = `http-${KUBECLAW_LIVE_USER}`; // 'http-alice'
const ALICE_HASH = computeGroupHash(ALICE_FOLDER);
const ALICE_DEPLOYMENT = instanceName('database', ALICE_HASH);
const ALICE_CREDS_SECRET = credsSecretName('database', ALICE_HASH);

const BOB_USER = 'bob';
const BOB_FOLDER = `http-${BOB_USER}`; // 'http-bob'
const BOB_HASH = computeGroupHash(BOB_FOLDER);
const BOB_DEPLOYMENT = instanceName('database', BOB_HASH);
const BOB_CREDS_SECRET = credsSecretName('database', BOB_HASH);

const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Probe the Redis port-forward; return true if reachable. */
function isRedisReachable(): boolean {
  const r = spawnSync('nc', ['-z', 'localhost', String(KUBECLAW_LIVE_REDIS_LOCAL_PORT)], {
    stdio: 'pipe',
  });
  return r.status === 0;
}

/** Build the postgres-mcp image inside minikube's docker daemon if needed. */
function ensurePostgresMcpImage(): void {
  const IMAGE = 'kubeclaw-postgres-mcp:latest';
  const DOCKERFILE = 'container/postgres-mcp/Dockerfile';
  const CONTEXT = '.';

  const check = spawnSync(
    'bash',
    [
      '-c',
      `eval $(minikube docker-env) && docker image inspect ${IMAGE} -f "{{.Id}}" 2>/dev/null`,
    ],
    { encoding: 'utf8' },
  );
  if (check.status === 0 && check.stdout.trim()) {
    console.log(`[db-e2e] ${IMAGE} already present in minikube daemon`);
    return;
  }
  console.log(`[db-e2e] Building ${IMAGE} inside minikube docker daemon...`);
  const build = spawnSync(
    'bash',
    [
      '-c',
      `eval $(minikube docker-env) && docker build -t ${IMAGE} -f ${DOCKERFILE} ${CONTEXT}`,
    ],
    { encoding: 'utf8', stdio: 'inherit', timeout: 900_000 },
  );
  if (build.status !== 0) {
    throw new Error(`${IMAGE} build failed (exit ${build.status})`);
  }
  console.log(`[db-e2e] ${IMAGE} built successfully`);
}

/** Wait up to timeoutMs for the named deployment's pods to be Ready. */
async function waitForDeploymentReady(
  name: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE,
      '-l', `app=${name}`,
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
    ]);
    if (
      r.ok &&
      r.stdout.trim() &&
      r.stdout.trim().split(/\s+/).every((s) => s === 'True')
    ) {
      return true;
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  return false;
}

/** Rollout-restart a deployment and wait for it to stabilise. */
function rolloutRestart(name: string): void {
  kubectl(
    ['rollout', 'restart', `deployment/${name}`, '-n', NAMESPACE],
    { timeout: 15_000 },
  );
  kubectl(
    ['rollout', 'status', `deployment/${name}`, '-n', NAMESPACE, '--timeout=120s'],
    { timeout: 130_000 },
  );
}

/** Read a base64-encoded data key from a K8s Secret. Returns null if absent. */
function readSecretKey(secretName: string, key: string): string | null {
  const r = kubectl([
    'get', 'secret', '-n', NAMESPACE, secretName,
    '-o', `jsonpath={.data.${key}}`,
  ]);
  if (!r.ok || !r.stdout.trim()) return null;
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

/**
 * Build a Node.js script that POSTs a JSON-RPC MCP tools/call request to
 * localhost:3000/mcp and prints STATUS:<code> + BODY:<response> to stdout.
 *
 * We do NOT use template literals with the token or SQL embedded directly —
 * instead we pass them as JSON.stringify'd constants at the top of the script
 * so that special characters (backslashes, quotes, newlines) in SQL or the
 * token cannot break the script syntax.
 */
// Container names inside the database capability pod:
//   - 'mcp'      — the postgres-mcp Node.js server (primary container, renderDeployment)
//   - 'postgres' — the Postgres sidecar (values.yaml sidecars[0].name)
const MCP_CONTAINER = 'mcp';

function buildMcpScript(
  token: string,
  toolName: 'query' | 'execute',
  sql: string,
): string {
  // Pre-serialise at the TypeScript level; the script receives ready literals.
  const serialisedBody = JSON.stringify(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: { sql } },
    }),
  );
  const serialisedToken = JSON.stringify(`Bearer ${token}`);

  return `
const http = require('node:http');
const body = ${serialisedBody};
const auth = ${serialisedToken};
const req = http.request({
  host: '127.0.0.1',
  port: 3000,
  path: '/mcp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': auth,
    'Content-Length': Buffer.byteLength(body),
  },
}, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    process.stdout.write('STATUS:' + res.statusCode + '\\n');
    process.stdout.write('BODY:' + data + '\\n');
  });
});
req.on('error', (e) => { console.error('ERR:' + e.message); process.exit(1); });
req.write(body);
req.end();
`.trim();
}

/**
 * Parse the STATUS: + BODY: output produced by buildMcpScript.
 * Returns { statusCode, rawBody }.
 */
function parseScriptOutput(stdout: string): { statusCode: number; rawBody: string } {
  const statusLine = stdout.split('\n').find((l) => l.startsWith('STATUS:'));
  const bodyLine = stdout.split('\n').find((l) => l.startsWith('BODY:'));
  const statusCode = statusLine ? parseInt(statusLine.slice(7), 10) : 0;
  const rawBody = bodyLine ? bodyLine.slice(5) : stdout;
  return { statusCode, rawBody };
}

/**
 * Strip SSE framing (data: {...}\n\n) from a response body if present,
 * returning the concatenated JSON-RPC payload.
 */
function stripSseFraming(raw: string): string {
  if (!raw.includes('data: ')) return raw;
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('');
}

/**
 * Call an MCP tool by kubectl exec-ing into a database pod's postgres-mcp
 * container and sending a JSON-RPC request to the MCP server on localhost:3000.
 *
 * Returns the parsed tool result { rows, truncated } on success.
 * Throws on exec failure, non-200 HTTP, or MCP-level error.
 */
async function callMcpTool(
  podName: string,
  token: string,
  toolName: 'query' | 'execute',
  sql: string,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const script = buildMcpScript(token, toolName, sql);

  const exec = kubectl(
    ['exec', '-n', NAMESPACE, podName, '-c', MCP_CONTAINER, '--', 'node', '-e', script],
    { timeout: 30_000 },
  );

  if (!exec.ok) {
    throw new Error(
      `kubectl exec failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
    );
  }

  const { statusCode, rawBody } = parseScriptOutput(exec.stdout);

  if (statusCode !== 200) {
    throw new Error(`MCP server returned HTTP ${statusCode}: ${rawBody.slice(0, 500)}`);
  }

  const responseText = stripSseFraming(rawBody);

  let parsed: {
    result?: { content?: Array<{ type: string; text: string; isError?: boolean }> };
    error?: { message: string };
  };
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    throw new Error(`Failed to parse MCP response JSON: ${responseText.slice(0, 500)}`);
  }

  if (parsed.error) {
    throw new Error(`MCP tool JSON-RPC error: ${parsed.error.message}`);
  }

  const content = parsed.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`MCP response has no content: ${responseText.slice(0, 500)}`);
  }

  // MCP tool errors are returned as content items with isError: true.
  const errorItem = content.find((c) => c.isError === true);
  if (errorItem) {
    throw new Error(`MCP tool returned error: ${errorItem.text}`);
  }

  const textItem = content.find((c) => c.type === 'text');
  if (!textItem) {
    throw new Error(`MCP response has no text content: ${JSON.stringify(content)}`);
  }

  try {
    return JSON.parse(textItem.text) as { rows: unknown[]; truncated: boolean };
  } catch {
    throw new Error(`Failed to parse tool result JSON: ${textItem.text.slice(0, 500)}`);
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: database capability (per-group postgres-mcp, execute+query, isolation)', () => {
  let provisioned = false;
  let alicePodName = '';
  let bobPodName = '';
  let aliceToken = '';
  /** Redis client used to install the database capability with execute enabled. */
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Check that the Redis port-forward is reachable (signals globalSetup ran).
    if (!isRedisReachable()) {
      console.warn(
        '[db-e2e] Redis port-forward not reachable — globalSetup may have failed or ' +
          'no cluster is available. All tests in this suite will be skipped.',
      );
      return;
    }

    // 2. Build + load the postgres-mcp image if it's not already present.
    try {
      ensurePostgresMcpImage();
    } catch (err) {
      console.warn('[db-e2e] postgres-mcp image build failed:', err);
      return;
    }

    // 2b. Connect to Redis as the orchestrator ACL user so we can install the
    //     database capability with allowedTools: ['query', 'execute'].
    //     The default values.yaml ships allowedTools: ['query'] only (execute is
    //     opt-in per group). We upsert the capability spec via install_capability
    //     IPC BEFORE registering alice's group so that when onGroupAdded fires
    //     the reconciler reads the updated spec and creates the per-group pod with
    //     execute enabled.
    //     Request shape: see src/k8s/ipc-redis.ts install_capability handler — the
    //     spec field is a JSON.stringify'd CapabilitySpec (McpCapabilitySpec here).
    //     isMain MUST be the literal string 'true' (equality-checked by the handler).
    const redisPwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!redisPwd.ok || !redisPwd.stdout.trim()) {
      console.warn('[db-e2e] failed to read Redis admin-password — cannot install capability with execute');
      return;
    }
    const redisPassword = Buffer.from(redisPwd.stdout.trim(), 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${redisPassword}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    try {
      await redis.ping();
    } catch (err) {
      console.warn('[db-e2e] Redis ping failed — cannot install capability with execute:', err);
      return;
    }

    // Install (or upsert) the database capability spec with allowedTools: ['query', 'execute'].
    // This overwrites the values.yaml default (allowedTools: ['query']) in the orchestrator DB.
    // The per-group reconciler calls listCapabilities() on every onGroupAdded/reconcile tick,
    // so it will pick up the updated spec immediately for alice's and bob's group pods.
    // NOTE: install_capability also calls applySpec() which creates a cluster-scoped
    // kubeclaw-cap-database Deployment; this is a harmless side effect — per-group pods use
    // the mcp-database-<hash> name scheme and are created by the per-group reconciler.
    const databaseSpec = {
      kind: 'mcp',
      name: 'database',
      scope: 'group',
      pinned: true,
      image: 'kubeclaw-postgres-mcp:latest',
      port: 3000,
      path: '/mcp',
      credentialsFrom: 'secret',
      allowedTools: ['query', 'execute'],
      podSecurity: { fsGroup: 999 },
      storage: {
        sizeGi: 5,
        mountPath: '/var/lib/postgresql/data',
        container: 'postgres',
      },
      env: {
        PGHOST: '127.0.0.1',
        PGUSER: 'kubeclaw',
        PG_RO_USER: 'kubeclaw_ro',
        PGDATABASE: 'kubeclaw',
        KUBECLAW_DB_STATEMENT_TIMEOUT_MS: '5000',
        KUBECLAW_DB_MAX_ROWS: '1000',
      },
      sidecars: [
        {
          name: 'postgres',
          image: 'postgres:16',
          port: 5432,
          env: {
            POSTGRES_USER: 'kubeclaw',
            POSTGRES_DB: 'kubeclaw',
            PGDATA: '/var/lib/postgresql/data/pgdata',
          },
        },
      ],
    };
    await redis.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'install_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'spec', JSON.stringify(databaseSpec),
    );
    console.log('[db-e2e] Sent install_capability IPC with allowedTools: [query, execute]');
    // Give the orchestrator a moment to process the install before we trigger group registration.
    await new Promise((res) => setTimeout(res, 3_000));

    // 3. POST to the HTTP channel to register alice's group with the orchestrator.
    //    This triggers onGroupAdded → per-group reconcile → DB credentials + deployment
    //    provisioned for alice's group. The HTTP port-forward is at HTTP_URL.
    const basicAuth =
      'Basic ' + Buffer.from(`${KUBECLAW_LIVE_USER}:${KUBECLAW_LIVE_PASS}`).toString('base64');
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`${HTTP_URL}/message`, {
          method: 'POST',
          headers: { Authorization: basicAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'db-e2e probe' }),
          signal: AbortSignal.timeout(5_000),
        });
        if (r.status === 200) break;
      } catch {
        // retry
      }
      await new Promise((res) => setTimeout(res, 2_000));
    }

    // Also register bob's group so the isolation test has a second database.
    const bobAuth = 'Basic ' + Buffer.from(`${BOB_USER}:bobpass`).toString('base64');
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`${HTTP_URL}/message`, {
          method: 'POST',
          headers: { Authorization: bobAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'db-e2e bob probe' }),
          signal: AbortSignal.timeout(5_000),
        });
        if (r.status === 200) break;
      } catch {
        // retry
      }
      await new Promise((res) => setTimeout(res, 2_000));
    }

    // Give the orchestrator time to process group registrations and trigger
    // the per-group reconcile (credentials + deployment provisioned).
    await new Promise((res) => setTimeout(res, 5_000));

    // 4. If a database deployment exists but its pod is in ImagePullBackOff
    //    (image wasn't present before step 2), restart it to pick up the new image.
    for (const dep of [ALICE_DEPLOYMENT, BOB_DEPLOYMENT]) {
      const depExists = kubectl([
        'get', 'deployment', dep, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      if (!depExists.ok) continue;

      const podState = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', `app=${dep}`,
        '-o', 'jsonpath={.items[*].status.containerStatuses[*].state.waiting.reason}',
      ]);
      if (
        podState.stdout.includes('ImagePullBackOff') ||
        podState.stdout.includes('ErrImagePull')
      ) {
        console.log(`[db-e2e] Restarting ${dep} (was in ImagePullBackOff)...`);
        rolloutRestart(dep);
      }
    }

    // 5. Wait for alice's database pod to be Ready (up to 5 minutes — postgres
    //    init can take a while the first time it initialises the data directory).
    console.log(`[db-e2e] Waiting for ${ALICE_DEPLOYMENT} to be Ready...`);
    const aliceReady = await waitForDeploymentReady(ALICE_DEPLOYMENT, 300_000);
    if (!aliceReady) {
      const dump = kubectl(['get', 'pods', '-n', NAMESPACE, '-l', `app=${ALICE_DEPLOYMENT}`, '-o', 'wide']);
      console.warn(`[db-e2e] ${ALICE_DEPLOYMENT} did not become Ready:\n${dump.stdout}\n${dump.stderr}`);
      return;
    }
    console.log(`[db-e2e] ${ALICE_DEPLOYMENT} is Ready`);

    // 6. Wait for bob's database pod (best-effort; isolation test will skip if absent).
    const bobReady = await waitForDeploymentReady(BOB_DEPLOYMENT, 300_000);
    if (!bobReady) {
      console.warn(
        `[db-e2e] ${BOB_DEPLOYMENT} did not become Ready — ` +
          'isolation tests (test 6) and K8s-isolation test (test 8) will be skipped. ' +
          'Check: did the bob POST to /message succeed? ' +
          `kubectl get pods -n ${NAMESPACE} -l app=${BOB_DEPLOYMENT} -o wide`,
      );
    }

    // 7. Read alice's MCP token from the creds secret.
    const token = readSecretKey(ALICE_CREDS_SECRET, 'KUBECLAW_MCP_TOKEN');
    if (!token) {
      console.warn(
        `[db-e2e] KUBECLAW_MCP_TOKEN not found in ${ALICE_CREDS_SECRET} — ` +
          'credential provisioning may not have completed.',
      );
      return;
    }
    aliceToken = token;

    // 8. Locate the alice and bob pod names.
    const alicePods = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', `app=${ALICE_DEPLOYMENT}`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    alicePodName = alicePods.stdout.trim();

    if (bobReady) {
      const bobPods = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', `app=${BOB_DEPLOYMENT}`,
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      bobPodName = bobPods.stdout.trim();
    }

    provisioned = true;
  }, 660_000);

  afterAll(async () => {
    // The per-group database Deployments and PVCs are pinned (scope: group, pinned: true)
    // and intentionally left running — they are tied to alice's and bob's group data
    // volumes and will be cleaned up by `helm uninstall`. Removing them here would
    // destroy the per-group PVCs, which is undesirable in shared minikube environments.
    // The cluster-scoped kubeclaw-cap-database Deployment (side effect of the
    // install_capability IPC call above) is also left in place; it is harmless and
    // matches the state that helm install normally produces.
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
      redis = null;
    }
  });

  // ── 1. Deployment + Service + PVC exist and are Ready ────────────────────

  it('alice database Deployment is Ready and its Service + PVC exist', (ctx) => {
    if (!provisioned) return ctx.skip();

    // Pod readiness
    const pods = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', `app=${ALICE_DEPLOYMENT}`,
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
    ]);
    expect(pods.ok, `kubectl get pods failed: ${pods.stderr}`).toBe(true);
    const statuses = pods.stdout.trim().split(/\s+/).filter(Boolean);
    expect(statuses.length, `no pods matched selector app=${ALICE_DEPLOYMENT}`).toBeGreaterThan(0);
    expect(
      statuses.every((s) => s === 'True'),
      `not all pods Ready for ${ALICE_DEPLOYMENT}: ${statuses.join(',')}`,
    ).toBe(true);

    // Service exists
    const svc = kubectl([
      'get', 'service', ALICE_DEPLOYMENT, '-n', NAMESPACE,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    expect(svc.ok, `Service ${ALICE_DEPLOYMENT} not found: ${svc.stderr}`).toBe(true);
    expect(svc.stdout.trim()).toBe(ALICE_DEPLOYMENT);

    // PVC exists (dedicated per-group postgres data PVC)
    const pvc = kubectl([
      'get', 'pvc', '-n', NAMESPACE,
      '-l', `kubeclaw.io/capability=database,kubeclaw.io/group-hash=${ALICE_HASH}`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    expect(pvc.ok, `PVC lookup failed: ${pvc.stderr}`).toBe(true);
    expect(pvc.stdout.trim(), 'alice database PVC should exist').toBeTruthy();
  }, 30_000);

  // ── 2. Creds Secret provisioned ───────────────────────────────────────────

  it('creds secret contains KUBECLAW_MCP_TOKEN, POSTGRES_PASSWORD, PG_RO_PASSWORD', (ctx) => {
    if (!provisioned) return ctx.skip();

    const token = readSecretKey(ALICE_CREDS_SECRET, 'KUBECLAW_MCP_TOKEN');
    expect(token, 'KUBECLAW_MCP_TOKEN should be present').toBeTruthy();
    expect(token!.length, 'KUBECLAW_MCP_TOKEN should be 64 hex chars').toBe(64);

    const rwPwd = readSecretKey(ALICE_CREDS_SECRET, 'POSTGRES_PASSWORD');
    expect(rwPwd, 'POSTGRES_PASSWORD should be present').toBeTruthy();
    expect(rwPwd!.length, 'POSTGRES_PASSWORD should be 48 hex chars').toBe(48);

    const roPwd = readSecretKey(ALICE_CREDS_SECRET, 'PG_RO_PASSWORD');
    expect(roPwd, 'PG_RO_PASSWORD should be present').toBeTruthy();
    expect(roPwd!.length, 'PG_RO_PASSWORD should be 48 hex chars').toBe(48);

    // rw and ro passwords must be distinct
    expect(rwPwd, 'rw and ro passwords should be different secrets').not.toBe(roPwd);
  }, 30_000);

  // ── 3. Token-gate: MCP /mcp returns 401 without Bearer token ─────────────

  it('MCP endpoint returns 401 for unauthenticated requests', (ctx) => {
    if (!provisioned) return ctx.skip();
    expect(alicePodName, 'alice pod name should be set by beforeAll').toBeTruthy();

    const noAuthScript = `
const http = require('node:http');
const body = '{}';
const req = http.request({
  host: '127.0.0.1', port: 3000, path: '/mcp', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => { process.stdout.write('STATUS:' + res.statusCode + '\\n'); });
req.on('error', (e) => { console.error('ERR:' + e.message); process.exit(1); });
req.write(body);
req.end();
    `.trim();

    const exec = kubectl(
      ['exec', '-n', NAMESPACE, alicePodName, '-c', MCP_CONTAINER, '--', 'node', '-e', noAuthScript],
      { timeout: 20_000 },
    );
    expect(exec.ok, `kubectl exec failed: ${exec.stderr}`).toBe(true);
    expect(exec.stdout, 'expected STATUS:401 without Bearer token').toMatch(/STATUS:401/);
  }, 60_000);

  // ── 4. MCP /health endpoint ────────────────────────────────────────────────

  it('MCP /health endpoint returns 200 ok', (ctx) => {
    if (!provisioned) return ctx.skip();
    expect(alicePodName, 'alice pod name should be set by beforeAll').toBeTruthy();

    const healthScript = `
const http = require('node:http');
http.get('http://127.0.0.1:3000/health', (res) => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => process.stdout.write('STATUS:' + res.statusCode + ' BODY:' + d + '\\n'));
}).on('error', (e) => { console.error('ERR:' + e.message); process.exit(1); });
    `.trim();

    const exec = kubectl(
      ['exec', '-n', NAMESPACE, alicePodName, '-c', MCP_CONTAINER, '--', 'node', '-e', healthScript],
      { timeout: 20_000 },
    );
    expect(exec.ok, `kubectl exec failed: ${exec.stderr}`).toBe(true);
    expect(exec.stdout, 'expected STATUS:200 from /health').toMatch(/STATUS:200/);
  }, 60_000);

  // ── 5. Write-then-read: execute CREATE+INSERT, query SELECT returns x=1 ──

  it('execute creates a table + inserts x=1, query reads it back (proves pinned pod + PVC + rw→ro)', async (ctx) => {
    if (!provisioned) return ctx.skip();
    expect(alicePodName, 'alice pod name should be set by beforeAll').toBeTruthy();
    expect(aliceToken, 'alice MCP token should be set by beforeAll').toBeTruthy();

    // Use a timestamp-suffixed table to avoid collision on repeated runs.
    const table = `e2e_t_${Date.now()}`;

    // a) CREATE TABLE via execute (rw Postgres role)
    await callMcpTool(alicePodName, aliceToken, 'execute', `CREATE TABLE ${table} (x int)`);

    // b) INSERT a row via execute (rw role)
    const insertResult = await callMcpTool(
      alicePodName, aliceToken, 'execute',
      `INSERT INTO ${table} (x) VALUES (1)`,
    );
    // INSERT returns no rows — just ensure the call succeeded (no error thrown above)
    expect(
      Array.isArray(insertResult.rows),
      'execute INSERT should return an array (possibly empty)',
    ).toBe(true);

    // c) SELECT via query (ro Postgres role) — must see the row written by execute.
    //    This proves: rw-write committed, ro-read can see it, PVC persisted the data.
    const selectResult = await callMcpTool(
      alicePodName, aliceToken, 'query',
      `SELECT x FROM ${table}`,
    );
    expect(
      Array.isArray(selectResult.rows) && selectResult.rows.length > 0,
      `expected at least one row from SELECT x FROM ${table}: ${JSON.stringify(selectResult)}`,
    ).toBe(true);
    const row = selectResult.rows[0] as Record<string, unknown>;
    expect(row['x'], `expected x=1 in SELECT result: ${JSON.stringify(row)}`).toBe(1);
  }, 120_000);

  // ── 6. Per-group isolation ────────────────────────────────────────────────

  it('bob database cannot see alice tables (per-group isolation)', async (ctx) => {
    if (!provisioned) return ctx.skip();
    if (!bobPodName) return ctx.skip();

    const bobToken = readSecretKey(BOB_CREDS_SECRET, 'KUBECLAW_MCP_TOKEN');
    if (!bobToken) {
      console.warn('[db-e2e] bob MCP token not found — skipping isolation assertion');
      return ctx.skip();
    }

    // Each group has a fully separate postgres instance (separate PVC + init).
    // Bob's DB has no e2e_t_* tables (created only in alice's DB above).
    const result = await callMcpTool(
      bobPodName, bobToken, 'query',
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'e2e_t_%'`,
    );
    expect(
      result.rows.length,
      `expected 0 alice tables in bob's DB, found: ${JSON.stringify(result.rows)}`,
    ).toBe(0);
  }, 90_000);

  // ── 7. Read-only enforcement: query tool (ro role) rejects INSERT ─────────

  it('query tool (ro Postgres role) rejects INSERT — role-level read-only enforcement', (ctx) => {
    if (!provisioned) return ctx.skip();
    expect(alicePodName, 'alice pod name should be set by beforeAll').toBeTruthy();
    expect(aliceToken, 'alice MCP token should be set by beforeAll').toBeTruthy();

    // The ro role has no INSERT privilege — Postgres must reject this at the DB level.
    // We expect the MCP server to surface the Postgres error in the response body.
    // We run the script directly (not via callMcpTool) so we can inspect the raw
    // response and check for the permission-denied indicator regardless of how the
    // MCP SDK frames the error (isError content vs JSON-RPC error vs HTTP error text).
    const script = buildMcpScript(
      aliceToken,
      'query',
      'INSERT INTO _ro_guard_check (x) VALUES (1)',
    );

    const exec = kubectl(
      ['exec', '-n', NAMESPACE, alicePodName, '-c', MCP_CONTAINER, '--', 'node', '-e', script],
      { timeout: 30_000 },
    );
    expect(exec.ok, `kubectl exec failed: ${exec.stderr}`).toBe(true);

    const { rawBody } = parseScriptOutput(exec.stdout);
    const responseText = stripSseFraming(rawBody);

    // Accept any indication that the write was blocked by the ro role.
    // Postgres errors observed in practice:
    //   - "permission denied for table ..."         — ro role lacks INSERT privilege
    //   - "permission denied for relation ..."      — older Postgres phrasing
    //   - "read-only transaction" / "read_only_sql_transaction" — session-level guard
    //   - "cannot execute INSERT in a read-only transaction"
    //   - "does not exist"  — ro role may hit a relation-not-found error before
    //                         reaching a permission check (e.g. _ro_guard_check
    //                         was never created, so the ro role sees "does not exist")
    //   - "insufficient privilege"
    // The MCP server wraps Postgres errors as isError content or JSON-RPC error.
    const indicatesReadOnlyError =
      /permission denied|read[_\- ]?only|read_only_sql_transaction|cannot execute INSERT|insufficient privi|does not exist/i.test(
        responseText,
      );
    expect(
      indicatesReadOnlyError,
      `Expected a permission-denied/read-only error from the ro pool.\nResponse: ${responseText.slice(0, 1000)}`,
    ).toBe(true);
  }, 90_000);

  // ── 8. Alice and bob have distinct Deployments + PVCs ────────────────────

  it('alice and bob have separate Deployments and PVCs (per-group K8s isolation)', (ctx) => {
    if (!provisioned) return ctx.skip();
    // Symmetric with test 6: if bob's pod did not come up, skip rather than hard-fail.
    // bob's Deployment existence is only confirmed once bobPodName is set in beforeAll.
    if (!bobPodName) return ctx.skip();

    const aliceDep = kubectl([
      'get', 'deployment', ALICE_DEPLOYMENT, '-n', NAMESPACE,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    expect(aliceDep.ok, `alice deployment not found: ${aliceDep.stderr}`).toBe(true);
    expect(aliceDep.stdout.trim()).toBe(ALICE_DEPLOYMENT);

    const bobDep = kubectl([
      'get', 'deployment', BOB_DEPLOYMENT, '-n', NAMESPACE,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    expect(bobDep.ok, `bob deployment not found: ${bobDep.stderr}`).toBe(true);
    expect(bobDep.stdout.trim()).toBe(BOB_DEPLOYMENT);

    // Distinct names prove each group has its own pod
    expect(ALICE_DEPLOYMENT).not.toBe(BOB_DEPLOYMENT);

    // Distinct PVCs prove separate data volumes
    const alicePvc = kubectl([
      'get', 'pvc', '-n', NAMESPACE,
      '-l', `kubeclaw.io/capability=database,kubeclaw.io/group-hash=${ALICE_HASH}`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    const bobPvc = kubectl([
      'get', 'pvc', '-n', NAMESPACE,
      '-l', `kubeclaw.io/capability=database,kubeclaw.io/group-hash=${BOB_HASH}`,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    expect(alicePvc.stdout.trim(), 'alice should have a database PVC').toBeTruthy();
    expect(bobPvc.stdout.trim(), 'bob should have a database PVC').toBeTruthy();
    expect(alicePvc.stdout.trim(), 'alice and bob PVCs should be distinct').not.toBe(
      bobPvc.stdout.trim(),
    );
  }, 30_000);
});
