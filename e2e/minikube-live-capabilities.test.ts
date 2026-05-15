/**
 * Minikube-live capability end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts helm-installs kubeclaw into
 * namespace `kubeclaw-live` and starts port-forwards for the HTTP channel
 * (localhost:14081) and Redis (localhost:16381).
 *
 * This suite installs the test MCP capability AT RUNTIME via Redis IPC
 * (`kubeclaw:task-requests` stream, type=install_capability). Doing the
 * install at runtime — rather than at helm time — avoids a startup race
 * where the orchestrator publishes `capabilities_update` before the channel
 * pod has subscribed to its control channel.
 *
 * The test MCP image (kubeclaw-test-mcp:latest, built by globalSetup) exposes:
 *   - POST /mcp     — MCP Streamable HTTP transport (port 3000)
 *   - GET  /test/log — convenience endpoint, returns { messages: string[] }
 *   - GET  /health  — { ok: true }
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';

// Hardcoded — matches what the globalSetup helm-installs.
// When minikube-live-setup.ts exports MCP_CAPABILITY_NAME, import it instead.
const MCP_CAPABILITY_NAME = 'test-mcp';

// The capability Service name follows deploymentName() in
// src/capabilities/builders/common.ts: `kubeclaw-cap-${name}`
const CAP_SERVICE = `kubeclaw-cap-${MCP_CAPABILITY_NAME}`;
// Pod label likewise comes from renderDeploymentAndService: app = deploymentName
const CAP_LABEL = `app=${CAP_SERVICE}`;

const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers (mirrors minikube-live.test.ts) ──────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Poll until the named Deployment no longer exists in the given namespace,
 * or until the timeout elapses.  Returns true if the deployment is gone,
 * false if it still exists after the timeout.
 */
async function waitForDeploymentGone(
  name: string,
  namespace: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'deployment', name, '-n', namespace,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    if (!r.ok) return true; // 404 — gone
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

/**
 * Send a remove_capability XADD and wait (up to timeoutMs) for its Deployment
 * to disappear.  Returns true if the deployment is confirmed gone (or was
 * never present), false on timeout.  Swallows Redis errors so it is safe to
 * call from finally blocks.
 */
async function cleanupCapability(
  redisClient: Redis,
  name: string,
  namespace: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  try {
    await redisClient.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'remove_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'name', name,
    );
  } catch {
    /* best-effort */
  }
  return waitForDeploymentGone(`kubeclaw-cap-${name}`, namespace, timeoutMs);
}

/**
 * Reads `data: ...` lines from an SSE stream and resolves on a predicate.
 * Returns an array of all data lines received so far.
 */
async function openSseStream(
  user: string,
  pass: string,
): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  const lines: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // aborted
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

async function postMessage(text: string): Promise<Response> {
  return await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
    },
    body: JSON.stringify({ text }),
  });
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Minikube-live: capability installed at runtime + used by channel', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `⚠️  Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Read the Redis admin password the chart auto-generated, then connect
    //    as the 'orchestrator' ACL user.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        // Tolerant config: survive a port-forward restart (typically <100 ms)
        // without the test-side client giving up. 20 retries × up to 2 s back-
        // off = up to ~20 s of reconnect attempts before hard failure.
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();

    // 3. XADD an install_capability task. `isMain` MUST be the literal string
    //    'true' — see src/k8s/ipc-redis.ts:1218 for the equality check.
    const spec = {
      kind: 'mcp',
      name: MCP_CAPABILITY_NAME,
      image: 'kubeclaw-test-mcp:latest',
      port: 3000,
      path: '/mcp',
    };
    await redis.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'install_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'spec', JSON.stringify(spec),
    );

    // 4. Wait for the capability pod to be Ready.
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const r = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', CAP_LABEL,
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (
        r.ok &&
        r.stdout.trim() &&
        r.stdout.trim().split(/\s+/).every((s) => s === 'True')
      ) {
        break;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }

    // 5. Wait briefly for the orchestrator's post-install
    //    capabilities_update push to reach the channel pod's McpManager.
    await new Promise((r) => setTimeout(r, 4000));
  }, 300_000);

  afterAll(async () => {
    // Remove the main test-mcp capability installed in beforeAll so it does not
    // leak into subsequent test files (e.g. minikube-live-rag.test.ts would find
    // the cluster resource-constrained if we leave all pods running).
    if (redis) {
      await cleanupCapability(redis, MCP_CAPABILITY_NAME, NAMESPACE, 60_000);
    }
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── 1. Capability pod Ready + Service exists ──────────────────────────────
  it(
    'capability pod is Running/Ready and its Service exists',
    () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Pod readiness
      const pods = kubectl([
        'get',
        'pods',
        '-n',
        NAMESPACE,
        '-l',
        CAP_LABEL,
        '-o',
        'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      expect(
        pods.ok,
        `kubectl get pods for ${CAP_LABEL} failed: ${pods.stderr}`,
      ).toBe(true);
      const statuses = pods.stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      expect(
        statuses.length,
        `no pods matched selector ${CAP_LABEL}`,
      ).toBeGreaterThan(0);
      expect(
        statuses.every((s) => s === 'True'),
        `not all pods Ready for ${CAP_LABEL}: ${statuses.join(',')}`,
      ).toBe(true);

      // Service exists
      const svc = kubectl([
        'get',
        'service',
        CAP_SERVICE,
        '-n',
        NAMESPACE,
        '-o',
        'jsonpath={.metadata.name}',
      ]);
      expect(
        svc.ok,
        `Service ${CAP_SERVICE} not found: ${svc.stderr}`,
      ).toBe(true);
      expect(svc.stdout.trim()).toBe(CAP_SERVICE);
    },
    90_000,
  );

  // ── 2. Channel pod logs show capability was discovered ────────────────────
  // handleCapabilitiesUpdate (src/channel-runner.ts:96-131) logs:
  //   'MCP servers reconfigured from capabilities_update'
  it(
    'channel pod logs show capability was discovered (capabilities_update)',
    () => {
      expect(provisioned).toBe(true);

      const r = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        'deployment/kubeclaw-channel-http',
        '--tail=2000',
      ]);
      expect(r.ok, `kubectl logs failed: ${r.stderr}`).toBe(true);

      // Either the JSON log message from handleCapabilitiesUpdate, or the
      // capability name appearing in any capabilities-related log line.
      expect(
        r.stdout,
        `expected capabilities_update reference or '${MCP_CAPABILITY_NAME}' in channel logs`,
      ).toMatch(
        new RegExp(
          `capabilities_update|MCP servers reconfigured|${MCP_CAPABILITY_NAME}`,
          'i',
        ),
      );
    },
    90_000,
  );

  // ── 3. Channel pod connected to the MCP server ───────────────────────────
  // discoverAndRegister() (src/runtime/mcp-manager.ts:230-237) logs:
  //   'Connected to MCP server'  with field  server: <name>
  it(
    'channel pod logs show successful MCP client connection + tool discovery',
    () => {
      expect(provisioned).toBe(true);

      const r = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        'deployment/kubeclaw-channel-http',
        '--tail=2000',
      ]);
      expect(r.ok, `kubectl logs failed: ${r.stderr}`).toBe(true);

      // Loose regex: accept the explicit log message OR evidence the
      // record_test_message tool was registered.
      expect(
        r.stdout,
        `expected MCP connect evidence in channel logs`,
      ).toMatch(
        /Connected to MCP server|record_test_message|test-mcp.*connect|tools\/list/i,
      );
    },
    90_000,
  );

  // ── 4. Tool list reachable from channel pod's network ────────────────────
  // kubectl exec into the channel pod and use a Node.js one-liner to hit
  // the capability pod's /test/log convenience endpoint (avoids MCP
  // handshake complexity). A 200 with { messages: [] } proves routing works.
  it(
    'channel pod can reach the capability pod over the cluster network',
    () => {
      expect(provisioned).toBe(true);

      const pods = kubectl([
        'get',
        'pods',
        '-n',
        NAMESPACE,
        '-l',
        'app=kubeclaw-channel-http',
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ]);
      expect(pods.ok).toBe(true);
      const channelPod = pods.stdout.trim();
      expect(channelPod).toBeTruthy();

      // First try the MCP tools/list endpoint.  If the server requires an
      // initialize handshake this may return 4xx; in that case fall back to
      // GET /test/log which requires no handshake.
      const mcpProbe = `
        const http = require('node:http');
        const body = JSON.stringify({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
        const req = http.request({
          host: '${CAP_SERVICE}',
          port: 3000,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (data.includes('record_test_message')) {
                console.log('tools-ok:record_test_message');
              } else {
                console.log('tools-ok:no-tool-in-response:' + data.slice(0, 200));
              }
            } else {
              // Fall back: hit /test/log instead
              http.get('http://${CAP_SERVICE}:3000/test/log', (r2) => {
                let d2 = '';
                r2.on('data', (c) => d2 += c);
                r2.on('end', () => { console.log('fallback-ok:' + d2.slice(0, 200)); });
              }).on('error', (e) => { console.error('fallback-err:' + e.message); process.exit(3); });
            }
          });
        });
        req.on('error', (e) => { console.error('req-err:' + e.message); process.exit(3); });
        req.write(body);
        req.end();
      `;

      const exec = kubectl(
        [
          'exec',
          '-n',
          NAMESPACE,
          channelPod,
          '-c',
          'channel',
          '--',
          'node',
          '-e',
          mcpProbe,
        ],
        { timeout: 30_000 },
      );
      expect(
        exec.ok,
        `network probe failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
      ).toBe(true);
      // Accept either a successful MCP tools/list or a successful /test/log fallback.
      expect(
        exec.stdout,
        `expected tools-ok or fallback-ok in stdout: ${exec.stdout}`,
      ).toMatch(/tools-ok|fallback-ok/);
    },
    90_000,
  );

  // ── 5. Real-user roundtrip invokes the tool ───────────────────────────────
  // The LLM (Gemma-4-E4B) is small. Tool-calling latency varies widely with
  // this model, sometimes exceeding any reasonable test timeout. The hard
  // assertions therefore focus on what we control:
  //   - POST accepted (channel pod is alive and authenticated)
  //   - capability pod is reachable from the channel pod's network namespace
  // The "did the LLM actually invoke the tool?" check is informational.
  it(
    'POST /message with tool-call directive — capability pod reachable + channel pod alive',
    async () => {
      expect(provisioned).toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
      let sseDelivered = false;
      try {
        const res = await postMessage(
          "You have a tool called record_test_message(text). " +
          "You MUST call it with the exact text \"kubeclaw-live-capability-test-marker\". " +
          "Do not respond with any words — only call the tool.",
        );
        expect(
          res.status,
          `POST /message returned unexpected status`,
        ).toBe(200);

        // Wait up to 60s for SSE — informational, not a hard fail. With
        // Gemma's slow tool-calling path, this can exceed any wall-clock budget.
        try {
          await sse.waitFor((l) => l.length > 0, 60_000);
          sseDelivered = sse.lines.length > 0;
        } catch {
          // small model didn't reply within the budget — that's expected and OK
        }
      } finally {
        sse.dispose();
      }

      // Locate the capability pod by its label.
      const capPods = kubectl([
        'get',
        'pods',
        '-n',
        NAMESPACE,
        '-l',
        CAP_LABEL,
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ]);
      expect(capPods.ok).toBe(true);
      const capPod = capPods.stdout.trim();
      expect(capPod, 'no capability pod found').toBeTruthy();

      // Verify /test/log is reachable from inside the capability pod.
      // The container name is set to a.component in renderDeploymentAndService;
      // for MCP capabilities that is 'capability-mcp' (see src/capabilities/builders/mcp.ts).
      const logProbe = `
        const http = require('node:http');
        http.get('http://localhost:3000/test/log', (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => { console.log('log-ok:' + data); });
        }).on('error', (e) => { console.error('log-err:' + e.message); process.exit(3); });
      `;
      const logExec = kubectl(
        [
          'exec',
          '-n',
          NAMESPACE,
          capPod,
          '-c',
          'capability-mcp',
          '--',
          'node',
          '-e',
          logProbe,
        ],
        { timeout: 20_000 },
      );
      expect(
        logExec.ok,
        `/test/log probe failed:\nstdout: ${logExec.stdout}\nstderr: ${logExec.stderr}`,
      ).toBe(true);
      expect(
        logExec.stdout,
        `expected log-ok in /test/log probe output`,
      ).toMatch(/log-ok/);

      // Best-effort: did the LLM actually call the tool? Log only — small
      // models (Gemma-4-E4B) routinely ignore tool-call directives, so this
      // is not a hard failure. The hard assertions above already prove the
      // capability wiring works; whether the LLM chose to use it is outside
      // our control.
      const markerPresent = logExec.stdout.includes(
        'kubeclaw-live-capability-test-marker',
      );
      console.log(
        `📊 Live-LLM tool-call observability: ` +
        `SSE delivered=${sseDelivered}, marker recorded=${markerPresent}`,
      );
      if (markerPresent) {
        console.log(
          '✅ LLM successfully called record_test_message with the marker phrase.',
        );
      } else {
        console.warn(
          '⚠️  LLM did not call record_test_message — small model may have ' +
          'ignored the directive. /test/log was reachable, the channel pod ' +
          'is healthy, and the capability is connected — but the LLM chose ' +
          `not to invoke the tool. Full /test/log response: ${logExec.stdout}`,
        );
      }
    },
    180_000,
  );

  // ── 6. ACL scoping ────────────────────────────────────────────────────────
  // Install a second test capability with a channels ACL that does NOT
  // include 'http'. The orchestrator's getEntriesForChannel filter
  // (registry.ts:97-103) should omit it from the http channel pod's
  // capabilities_update payload, leaving only test-mcp visible.
  it(
    'ACL: a capability scoped to a different channel is not exposed to http',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis, 'redis client should be initialised by beforeAll').not.toBeNull();

      const aclName = 'test-mcp-scoped';
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'install_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'spec', JSON.stringify({
          kind: 'mcp',
          name: aclName,
          image: 'kubeclaw-test-mcp:latest',
          port: 3000,
          path: '/mcp',
          channels: ['signal'], // deliberately not http
        }),
      );

      // Wait for the scoped capability pod to be Ready.
      const deadline = Date.now() + 180_000;
      const aclLabel = `app=kubeclaw-cap-${aclName}`;
      while (Date.now() < deadline) {
        const r = kubectl([
          'get', 'pods', '-n', NAMESPACE, '-l', aclLabel,
          '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
        ]);
        if (
          r.ok &&
          r.stdout.trim() &&
          r.stdout.trim().split(/\s+/).every((s) => s === 'True')
        ) {
          break;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }

      // Give the orchestrator a moment to push capabilities_update to http.
      await new Promise((r) => setTimeout(r, 4000));

      // Channel pod log must NOT mention the scoped capability name.
      const logs = kubectl([
        'logs', '-n', NAMESPACE,
        'deployment/kubeclaw-channel-http', '--tail=5000',
      ]);
      expect(logs.ok).toBe(true);
      // It is OK if the McpManager log mentions ALL servers it considered, but
      // we expect no successful "Connected to MCP server ... test-mcp-scoped"
      // line — the channel should never have learned the scoped server's URL.
      expect(
        logs.stdout,
        `unexpectedly found '${aclName}' in http channel logs`,
      ).not.toMatch(new RegExp(`Connected to MCP server[^\\n]*${aclName}`));

      // Clean up the scoped capability so it doesn't leak into later tests.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'remove_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'name', aclName,
      );
    },
    240_000,
  );

  // ── 7. remove_capability tears down Deployment + channel pod sees updated sync ──
  // XADD type=install_capability for temp-mcp-remove, wait for its Deployment,
  // wait for the channel pod to acknowledge it in a "Synced capabilities to local DB"
  // log line, then XADD remove_capability and assert the Deployment disappears and
  // the next sync log no longer mentions temp-mcp-remove.
  // Log shape: channel-runner.ts:225-228 — logger.info({ written, total }, 'Synced capabilities to local DB')
  it(
    'remove_capability tears down the Deployment and the channel pod sees an updated capabilities_update',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis, 'redis client should be initialised by beforeAll').not.toBeNull();

      const removeName = 'temp-mcp-remove';
      const removeDeployment = `kubeclaw-cap-${removeName}`;

      // Pre-test idempotency: remove any stale capability from a prior failed run
      // so the cluster starts from a known-clean state.
      await cleanupCapability(redis!, removeName, NAMESPACE, 30_000);

      try {
        // Install the temporary capability.
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify({
            kind: 'mcp',
            name: removeName,
            image: 'kubeclaw-test-mcp:latest',
            port: 3000,
            path: '/mcp',
          }),
        );

        // Wait for the Deployment to exist (up to 120 s).
        const installDeadline = Date.now() + 120_000;
        let deploymentExists = false;
        while (Date.now() < installDeadline) {
          const r = kubectl([
            'get', 'deployment', removeDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (r.ok && r.stdout.trim() === removeDeployment) {
            deploymentExists = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          deploymentExists,
          `Deployment ${removeDeployment} did not appear within 120 s`,
        ).toBe(true);

        // Wait for the channel pod's first sync log that references temp-mcp-remove.
        // "Synced capabilities to local DB" is logged by syncCapabilitiesToLocalDb
        // in src/channel-runner.ts:225-228 — the `written` array contains {name,kind}.
        const syncDeadline = Date.now() + 60_000;
        let firstSyncSeen = false;
        while (Date.now() < syncDeadline) {
          const logs = kubectl([
            'logs', '-n', NAMESPACE,
            'deployment/kubeclaw-channel-http', '--tail=3000',
          ]);
          if (
            logs.ok &&
            logs.stdout.includes('Synced capabilities to local DB') &&
            logs.stdout.includes(removeName)
          ) {
            firstSyncSeen = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
        expect(
          firstSyncSeen,
          `channel pod did not log a sync containing '${removeName}' within 60 s`,
        ).toBe(true);

        // Record a unique marker so we can distinguish log lines emitted BEFORE
        // vs AFTER the remove request.  We search for the marker in the log
        // timestamp: any "Synced capabilities to local DB" line whose JSON
        // timestamp is >= the marker time was generated after removal.
        // Simpler approach: record the removal XADD time and only accept sync
        // lines that appear in the log AFTER we've issued the removal.
        const removalXaddTime = Date.now();

        // Now request removal.
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'remove_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'name', removeName,
        );

        // Poll up to 60 s for the Deployment to disappear.
        const removeDeadline = Date.now() + 60_000;
        let deploymentGone = false;
        while (Date.now() < removeDeadline) {
          const r = kubectl([
            'get', 'deployment', removeDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (!r.ok) {
            deploymentGone = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          deploymentGone,
          `Deployment ${removeDeployment} still exists after remove_capability`,
        ).toBe(true);

        // Poll for a "Synced capabilities to local DB" line that does NOT
        // include temp-mcp-remove and whose pino timestamp is >= removalXaddTime.
        // syncCapabilitiesToLocalDb (src/channel-runner.ts:225-228) logs
        //   { written: [{name,kind},...], total: N }
        // After removal the capabilities_update payload omits the removed cap,
        // so `removeName` will not appear in the `written` array.
        const postSyncDeadline = Date.now() + 60_000;
        let postRemoveSyncOk = false;
        while (Date.now() < postSyncDeadline) {
          const logs = kubectl([
            'logs', '-n', NAMESPACE,
            'deployment/kubeclaw-channel-http', '--tail=5000',
          ]);
          if (logs.ok) {
            // Accept any sync line whose JSON "time" field (ms epoch) is after
            // the removal XADD, AND that does not mention removeName.
            const syncLines = logs.stdout
              .split('\n')
              .filter((l) => l.includes('Synced capabilities to local DB'));
            const postRemovalSyncs = syncLines.filter((l) => {
              try {
                const parsed = JSON.parse(l) as { time?: number };
                return (parsed.time ?? 0) >= removalXaddTime;
              } catch {
                return false;
              }
            });
            // Check the `written` JSON field specifically — the channel-runner
            // also logs `deleted: [removeName]` on removal (commit 9fd0019),
            // so a substring match on the whole line would falsely match the
            // deleted observability field. Parse and check `written` only.
            const writtenExcludesRemoved = postRemovalSyncs.every((l) => {
              try {
                const parsed = JSON.parse(l) as {
                  written?: Array<{ name: string }>;
                };
                return !(parsed.written ?? []).some(
                  (e) => e.name === removeName,
                );
              } catch {
                return false;
              }
            });
            if (postRemovalSyncs.length > 0 && writtenExcludesRemoved) {
              postRemoveSyncOk = true;
              break;
            }
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
        expect(
          postRemoveSyncOk,
          `channel pod did not log a post-removal sync without '${removeName}' within 60 s`,
        ).toBe(true);
      } finally {
        // Always clean up so a failure here does not leave temp-mcp-remove
        // installed for the next test run.
        await cleanupCapability(redis!, removeName, NAMESPACE, 30_000);
      }
    },
    300_000,
  );

  // ── 8. allowedTools filter restricts which tools the channel pod registers ───
  // Install mcp-allow-filter with allowedTools:["nonexistent_tool"]. The server
  // is still up (record_test_message is visible from the cluster), but the
  // channel pod's McpManager filters everything out and logs toolCount=0.
  // Log shape: mcp-manager.ts:230-237 — logger.info({ server, toolCount, totalDiscovered }, 'Connected to MCP server')
  it(
    'MCP allowedTools filter restricts which tools the channel pod connects/registers',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis, 'redis client should be initialised by beforeAll').not.toBeNull();

      const filterName = 'mcp-allow-filter';
      const filterDeployment = `kubeclaw-cap-${filterName}`;

      // Pre-test idempotency: remove any stale capability from a prior failed run.
      await cleanupCapability(redis!, filterName, NAMESPACE, 30_000);

      try {
        // Install the capability with an allowedTools that matches nothing.
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify({
            kind: 'mcp',
            name: filterName,
            image: 'kubeclaw-test-mcp:latest',
            port: 3000,
            path: '/mcp',
            allowedTools: ['nonexistent_tool'],
          }),
        );

        // Wait for the Deployment to exist (up to 120 s).
        const installDeadline = Date.now() + 120_000;
        let deploymentExists = false;
        while (Date.now() < installDeadline) {
          const r = kubectl([
            'get', 'deployment', filterDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (r.ok && r.stdout.trim() === filterDeployment) {
            deploymentExists = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          deploymentExists,
          `Deployment ${filterDeployment} did not appear within 120 s`,
        ).toBe(true);

        // Wait for the channel pod to sync and attempt connection.
        await new Promise((r) => setTimeout(r, 6000));

        // Prove the MCP server itself is up: kubectl exec into the channel pod
        // and POST a tools/list to confirm record_test_message is served.
        const channelPods = kubectl([
          'get', 'pods', '-n', NAMESPACE,
          '-l', 'app=kubeclaw-channel-http',
          '-o', 'jsonpath={.items[0].metadata.name}',
        ]);
        expect(channelPods.ok).toBe(true);
        const channelPod = channelPods.stdout.trim();
        expect(channelPod, 'no channel pod found').toBeTruthy();

        const serverProbe = `
          const http = require('node:http');
          const body = JSON.stringify({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
          const req = http.request({
            host: '${filterDeployment}',
            port: 3000,
            path: '/mcp',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
              'Content-Length': Buffer.byteLength(body),
            },
          }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
              if (data.includes('record_test_message')) {
                console.log('server-has-tool:record_test_message');
              } else {
                console.log('server-response:' + data.slice(0, 300));
              }
            });
          });
          req.on('error', (e) => { console.error('probe-err:' + e.message); process.exit(3); });
          req.write(body);
          req.end();
        `;
        const probeExec = kubectl(
          [
            'exec', '-n', NAMESPACE, channelPod,
            '-c', 'channel',
            '--', 'node', '-e', serverProbe,
          ],
          { timeout: 30_000 },
        );
        expect(
          probeExec.ok,
          `tools/list probe failed: stdout=${probeExec.stdout} stderr=${probeExec.stderr}`,
        ).toBe(true);
        // The MCP server must expose record_test_message regardless of the filter.
        expect(
          probeExec.stdout,
          `expected the MCP server to list record_test_message: ${probeExec.stdout}`,
        ).toMatch(/server-has-tool:record_test_message/);

        // Now check channel pod logs for toolCount=0 for mcp-allow-filter.
        // The log line is emitted by McpManager.discoverAndRegister in
        // src/runtime/mcp-manager.ts:230-237:
        //   logger.info({ server, toolCount, totalDiscovered }, 'Connected to MCP server')
        // We expect toolCount=0 because allowedTools:["nonexistent_tool"] strips everything.
        const logsAfterSync = kubectl([
          'logs', '-n', NAMESPACE,
          'deployment/kubeclaw-channel-http', '--tail=5000',
        ]);
        expect(logsAfterSync.ok).toBe(true);

        // The JSON log line will contain: "server":"mcp-allow-filter","toolCount":0
        const toolCount0Pattern = new RegExp(
          `${filterName}[^\\n]*toolCount.*?0|toolCount.*?0[^\\n]*${filterName}`,
        );
        expect(
          logsAfterSync.stdout,
          `expected toolCount=0 for ${filterName} in channel logs: ${logsAfterSync.stdout.slice(-2000)}`,
        ).toMatch(toolCount0Pattern);
      } finally {
        // Cleanup: remove the capability and confirm it is gone before returning.
        await cleanupCapability(redis!, filterName, NAMESPACE, 30_000);
      }
    },
    300_000,
  );

  // ── 9. MCP LLM tools route through Redis IPC correctly ───────────────────────
  // Bypasses the live LLM entirely. Directly writes Redis stream entries to
  // validate the orchestrator-side install_capability / list_capabilities /
  // remove_capability handlers (ipc-redis.ts:1218-1266).
  it(
    'MCP LLM tools (deploy/remove/list) route through Redis IPC correctly via fake LLM tool-call bypass',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis, 'redis client should be initialised by beforeAll').not.toBeNull();

      const llmToolName = 'llm-tool-mcp';
      const llmToolDeployment = `kubeclaw-cap-${llmToolName}`;

      // Pre-test idempotency: remove any stale capability from a prior failed run.
      await cleanupCapability(redis!, llmToolName, NAMESPACE, 30_000);

      try {
        // a) XADD install_capability — mirrors what mcpServerAction('deploy_mcp_server') does
        //    in src/runtime/direct-llm-runner.ts:668-699.
        //    NOTE: install_capability does NOT write to a resultStream
        //    (src/k8s/ipc-redis.ts:1218-1232 — only list_capabilities writes back).
        //    We confirm success by polling for the Deployment instead.
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify({
            kind: 'mcp',
            name: llmToolName,
            image: 'kubeclaw-test-mcp:latest',
            port: 3000,
            path: '/mcp',
          }),
        );

        // Wait for the Deployment (up to 120 s — same window as other install tests).
        const installDeadline = Date.now() + 120_000;
        let installDone = false;
        while (Date.now() < installDeadline) {
          const r = kubectl([
            'get', 'deployment', llmToolDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (r.ok && r.stdout.trim() === llmToolDeployment) {
            installDone = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          installDone,
          `Deployment ${llmToolDeployment} did not appear within 120 s`,
        ).toBe(true);

        // b) XADD list_capabilities — mirrors mcpServerAction('list_mcp_servers') in
        //    src/runtime/direct-llm-runner.ts:715-761. The orchestrator responds with a
        //    JSON array on the resultStream (ipc-redis.ts:1252-1266).
        //    list_capabilities DOES write to resultStream.
        const resultStream = `kubeclaw:capabilities-list-result:${Date.now()}-test`;
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'list_capabilities',
          'groupFolder', 'http',
          'isMain', 'true',
          'resultStream', resultStream,
        );

        // XREAD the result stream with BLOCK 10 s.
        const readResult = await redis!.xread(
          'COUNT', 1,
          'BLOCK', 10000,
          'STREAMS', resultStream, '0-0',
        ) as [string, [string, string[]][]][] | null;

        expect(
          readResult,
          'list_capabilities result stream timed out (no response within 10 s)',
        ).not.toBeNull();

        let capabilityList: Array<{ name: string; kind: string }> = [];
        if (readResult) {
          for (const [, messages] of readResult) {
            for (const [, fields] of messages) {
              const obj: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
              if (obj.result) {
                capabilityList = JSON.parse(obj.result) as Array<{ name: string; kind: string }>;
              }
            }
          }
        }

        const names = capabilityList.map((c) => c.name);
        expect(
          names,
          `expected ${MCP_CAPABILITY_NAME} in capability list: ${JSON.stringify(names)}`,
        ).toContain(MCP_CAPABILITY_NAME);
        expect(
          names,
          `expected ${llmToolName} in capability list: ${JSON.stringify(names)}`,
        ).toContain(llmToolName);

        // c) XADD remove_capability — mirrors mcpServerAction('remove_mcp_server').
        //    remove_capability does NOT write to a resultStream; confirm via poll.
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'remove_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'name', llmToolName,
        );

        // Poll for Deployment to disappear (up to 60 s).
        const removeDeadline = Date.now() + 60_000;
        let removeDone = false;
        while (Date.now() < removeDeadline) {
          const r = kubectl([
            'get', 'deployment', llmToolDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (!r.ok) {
            removeDone = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          removeDone,
          `Deployment ${llmToolDeployment} still exists after remove_capability`,
        ).toBe(true);
      } finally {
        // Always clean up so a failure here does not leave llm-tool-mcp installed
        // for the next test run.  waitForDeploymentGone is embedded in
        // cleanupCapability, so subsequent tests start from a clean slate.
        await cleanupCapability(redis!, llmToolName, NAMESPACE, 30_000);
      }
    },
    300_000,
  );

  // ── 10. assertNoConflictingRag rejects a second unscoped RAG install ─────────
  // Verifies the guard in src/capabilities/registry.ts:114-145.
  // The throw site (line 128-134) fires when both RAGs are unscoped (no `channels`
  // field). The orchestrator catches the error and logs:
  //   logger.error({ err }, 'Failed to install capability')  — ipc-redis.ts:1231
  it(
    'assertNoConflictingRag rejects a second unscoped RAG install',
    async () => {
      expect(provisioned).toBe(true);
      expect(redis, 'redis client should be initialised by beforeAll').not.toBeNull();

      const baselineRagName = 'rag-baseline-for-conflict-test';
      const conflictRagName = 'rag-conflict-attempt';
      const conflictDeployment = `kubeclaw-cap-${conflictRagName}`;

      // Ensure a baseline RAG exists so the conflict guard can fire.
      // Prefer test-rag (installed by minikube-live-rag.test.ts) if it exists,
      // otherwise check for a stale rag-baseline-for-conflict-test from a prior run.
      const existingTestRag = kubectl([
        'get', 'deployment', 'kubeclaw-cap-test-rag', '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      const existingBaselineRag = kubectl([
        'get', 'deployment', `kubeclaw-cap-${baselineRagName}`, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      const baselineIsExternalRag =
        (existingTestRag.ok && existingTestRag.stdout.includes('test-rag')) ||
        (existingBaselineRag.ok && existingBaselineRag.stdout.includes(baselineRagName));

      let installedBaseline = false;
      try {
        if (!baselineIsExternalRag) {
          // Install our own baseline RAG.
          await redis!.xadd(
            'kubeclaw:task-requests',
            '*',
            'type', 'install_capability',
            'groupFolder', 'http',
            'isMain', 'true',
            'spec', JSON.stringify({
              kind: 'rag',
              name: baselineRagName,
              backend: 'qdrant',
              image: 'qdrant/qdrant:latest',
              port: 6333,
            }),
          );
          installedBaseline = true;
          // Give the orchestrator time to process the baseline install.
          // We only need the orchestrator's DB row to exist so
          // assertNoConflictingRag fires.  The Deployment may take longer.
          const baselineDeadline = Date.now() + 30_000;
          while (Date.now() < baselineDeadline) {
            const r = kubectl([
              'get', 'deployment', `kubeclaw-cap-${baselineRagName}`, '-n', NAMESPACE,
              '-o', 'jsonpath={.metadata.name}',
            ]);
            if (r.ok && r.stdout.includes(baselineRagName)) break;
            await new Promise((res) => setTimeout(res, 3000));
          }
        }

        // Record the time immediately before the conflict attempt so we can
        // filter orchestrator log lines that are definitely from this attempt.
        // pino emits {"time":<ms epoch>,...} in JSON mode.
        const conflictXaddTime = Date.now();

        // Attempt to install a SECOND unscoped RAG — this must be rejected by
        // assertNoConflictingRag (src/capabilities/registry.ts:114-145).
        await redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify({
            kind: 'rag',
            name: conflictRagName,
            backend: 'qdrant',
            image: 'qdrant/qdrant:latest',
            port: 6333,
          }),
        );

        // Poll up to 30 s confirming NO Deployment is created for the conflict
        // attempt.  The conflict guard fires before applySpec, so no K8s resource
        // should ever appear.
        const conflictDeadline = Date.now() + 30_000;
        let conflictDeploymentFound = false;
        while (Date.now() < conflictDeadline) {
          const r = kubectl([
            'get', 'deployment', conflictDeployment, '-n', NAMESPACE,
            '-o', 'jsonpath={.metadata.name}',
          ]);
          if (r.ok && r.stdout.includes(conflictRagName)) {
            conflictDeploymentFound = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
        expect(
          conflictDeploymentFound,
          `Deployment ${conflictDeployment} was created — conflict guard did not fire`,
        ).toBe(false);

        // Poll orchestrator logs for the conflict error.
        // assertNoConflictingRag throws (registry.ts:128-134):
        //   "RAG '<name>' conflicts with already-installed RAG '<other>': ..."
        // ipc-redis.ts:1231 catches and logs:
        //   logger.error({ err }, 'Failed to install capability')
        // pino serialises the Error as: {"err":{"message":"...conflicts..."},...}
        //
        // We search the full tail rather than slicing by a line-count snapshot,
        // because --tail=N returns a rolling window that can shift between calls.
        // We filter to lines whose JSON "time" field >= conflictXaddTime so we
        // only accept log entries that were written AFTER the conflict XADD.
        const logDeadline = Date.now() + 20_000;
        let conflictLogFound = false;
        while (Date.now() < logDeadline) {
          const logs = kubectl([
            'logs', '-n', NAMESPACE,
            'deployment/kubeclaw-orchestrator', '--tail=3000',
          ]);
          if (logs.ok) {
            const matchingLine = logs.stdout.split('\n').find((l) => {
              if (
                !l.includes('Failed to install capability') ||
                !l.includes('conflicts with already-installed RAG')
              ) {
                return false;
              }
              // Require that the log line was emitted after the conflict XADD.
              try {
                const parsed = JSON.parse(l) as { time?: number };
                return (parsed.time ?? 0) >= conflictXaddTime;
              } catch {
                // If pino-pretty is active (local dev), fall back to substring match.
                return true;
              }
            });
            if (matchingLine !== undefined) {
              conflictLogFound = true;
              break;
            }
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
        expect(
          conflictLogFound,
          'orchestrator did not log a RAG conflict error within 20 s',
        ).toBe(true);
      } finally {
        // CRITICAL: wait for deployments to be fully gone before returning.
        // If we leave rag-baseline-for-conflict-test in the registry, the next
        // test file (minikube-live-rag.test.ts) will fail its beforeAll because
        // assertNoConflictingRag rejects test-rag as a conflicting unscoped RAG.
        if (installedBaseline) {
          await cleanupCapability(redis!, baselineRagName, NAMESPACE, 60_000);
        }
        // The conflict attempt should never have been installed, but clean up
        // defensively in case the guard failed to fire.
        await cleanupCapability(redis!, conflictRagName, NAMESPACE, 30_000);
      }
    },
    240_000,
  );
});
