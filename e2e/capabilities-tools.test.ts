/**
 * End-to-end test for Story 54: /capabilities tools <type>
 *
 * Target cluster: kubeclaw-e2e-istio
 * Namespace: kubeclaw-e2e-cap-tools
 * HTTP channel port: 14137
 *
 * This test requires:
 *   1. A running kubeclaw deployment in the namespace above.
 *   2. A per-group MCP capability named 'echo' installed with scope=group.
 *      The orchestrator's schema-scraper must have run and cached the echo
 *      server's tool schemas.
 *   3. Port-forward: kubectl port-forward -n kubeclaw-e2e-cap-tools
 *        svc/kubeclaw-http 14137:80
 *
 * The test sends POST /message with body "/capabilities tools echo" and
 * asserts that the SSE response contains at least one tool name.
 *
 * AC1: schema available → SSE reply lists tool names.
 * AC2: not provisioned  → SSE reply contains "not provisioned".
 * AC3: pending-schema   → SSE reply contains "schema not yet available".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { isKubernetesAvailable } from './setup.js';

const PORT = parseInt(process.env.CAP_TOOLS_HTTP_PORT ?? '14137', 10);
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const TEST_USER = process.env.CAP_TOOLS_USER ?? 'e2e';
const TEST_PASS = process.env.CAP_TOOLS_PASS ?? 'e2e-secret';
const CAP_TYPE = process.env.CAP_TOOLS_TYPE ?? 'echo';
const NAMESPACE = 'kubeclaw-e2e-cap-tools';
const RELEASE = 'kubeclaw-cap-tools';
const K8S_AVAILABLE = isKubernetesAvailable();

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Send a chat message via POST /message and collect SSE output lines until
 * the stream closes or the predicate matches.  Times out after timeoutMs.
 */
async function sendAndCollect(text: string, timeoutMs = 30_000): Promise<string[]> {
  const auth = basicAuth(TEST_USER, TEST_PASS);

  // Open SSE stream first so we don't miss the reply.
  const controller = new AbortController();
  const streamRes = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: auth },
    signal: controller.signal,
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`SSE /stream failed: HTTP ${streamRes.status}`);
  }

  const lines: string[] = [];
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const readerLoop = (async () => {
    try {
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
      // aborted or stream ended
    }
  })();

  // Post the message.
  const msgRes = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: text }),
  });
  if (!msgRes.ok) {
    controller.abort();
    throw new Error(`POST /message failed: HTTP ${msgRes.status}`);
  }

  // Wait for reply to appear (heuristic: wait until lines stop arriving or timeout).
  const deadline = Date.now() + timeoutMs;
  let lastLen = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (lines.length > lastLen) {
      lastLen = lines.length;
    } else if (lines.length > 0) {
      // Lines have stabilised; give one more tick then break.
      await new Promise((r) => setTimeout(r, 600));
      break;
    }
  }

  controller.abort();
  await readerLoop.catch(() => {});
  return lines;
}

describe.skipIf(!K8S_AVAILABLE)('/capabilities tools — e2e', () => {
  let portForwardProc: ReturnType<typeof spawn> | null = null;
  let helmInstalledByTest = false;

  beforeAll(async () => {
    // 1. Build the echo-mcp image into minikube so the orchestrator can pull it.
    const buildResult = spawnSync(
      'bash',
      [
        '-c',
        'eval $(minikube docker-env 2>/dev/null || true) && bash container/echo-mcp/build.sh kubeclaw-echo-mcp:cap-tools-test',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 300_000 },
    );
    if (buildResult.status !== 0) {
      console.warn('echo-mcp build failed — test may fail AC1:', buildResult.stderr);
    }

    // 2. Install kubeclaw into the dedicated namespace (idempotent).
    const existingRelease = spawnSync(
      'helm',
      ['status', RELEASE, '--namespace', NAMESPACE],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (existingRelease.status !== 0) {
      spawnSync(
        'kubectl',
        ['apply', '-f', '-'],
        {
          input: `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${NAMESPACE}\n`,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      const installResult = spawnSync(
        'helm',
        [
          'upgrade', '--install', RELEASE, './helm/kubeclaw',
          '--namespace', NAMESPACE,
          '--timeout', '120s',
          '--set', `namespace=${NAMESPACE}`,
          '--set', 'secrets.anthropicApiKey=test-key',
          '--set', 'channels.http.enabled=true',
          '--set', 'channels.http.users[0].username=e2e',
          '--set', 'channels.http.users[0].password=e2e-secret',
          '--set-json', `perGroupCapabilities=[{"type":"echo","image":"kubeclaw-echo-mcp:cap-tools-test","scaleDownAfterIdleSeconds":60}]`,
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 150_000 },
      );
      if (installResult.status !== 0) {
        throw new Error(`helm install failed: ${installResult.stderr}`);
      }
      helmInstalledByTest = true;

      // Wait for orchestrator to be ready.
      spawnSync(
        'kubectl',
        [
          'wait', '--namespace', NAMESPACE,
          '--for=condition=available', 'deployment/kubeclaw-orchestrator',
          '--timeout=120s',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }

    // 3. Kill any stale port-forward, then start a fresh one.
    spawnSync('pkill', ['-f', `port-forward.*${PORT}:.*${NAMESPACE}`], { stdio: 'pipe' });
    await new Promise((r) => setTimeout(r, 500));

    portForwardProc = spawn(
      'kubectl',
      ['port-forward', '-n', NAMESPACE, 'svc/kubeclaw-http', `${PORT}:80`],
      { stdio: 'ignore', detached: true },
    );
    portForwardProc.unref();

    // Wait up to 30 s for port-forward to be ready.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const nc = spawnSync('nc', ['-z', '127.0.0.1', String(PORT)], { stdio: 'pipe' });
      if (nc.status === 0) break;
    }

    // 4. Wait for the echo capability schema to be scraped (up to 60 s).
    //    The orchestrator's schema-scraper runs shortly after startup.
    const schemaDeadline = Date.now() + 60_000;
    while (Date.now() < schemaDeadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      // Probe: send "/capabilities tools echo" and check if schema is available.
      try {
        const probe = await sendAndCollect(`/capabilities tools ${CAP_TYPE}`, 8_000);
        const combined = probe.join('\n');
        if (!combined.includes('schema not yet available')) break;
      } catch {
        // not ready yet
      }
    }
  }, 300_000);

  afterAll(async () => {
    if (portForwardProc) {
      try { portForwardProc.kill(); } catch { /* ignore */ }
    }
    spawnSync('pkill', ['-f', `port-forward.*${PORT}:.*${NAMESPACE}`], { stdio: 'pipe' });
    if (helmInstalledByTest) {
      spawnSync(
        'helm',
        ['uninstall', RELEASE, '--namespace', NAMESPACE],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      spawnSync(
        'kubectl',
        ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    }
  }, 120_000);

  it('AC1: /capabilities tools <type> lists MCP tools when schema is available', async () => {
    const lines = await sendAndCollect(`/capabilities tools ${CAP_TYPE}`);
    const combined = lines.join('\n');
    // The reply should contain at least one tool line (name — description pattern).
    expect(combined).toMatch(/Tools for/i);
    // At least one tool line should be present (format: "  <name> — <desc>")
    expect(combined).toMatch(/\s+\S+ — /);
  }, 60_000);

  it('AC2: /capabilities tools <nonexistent> → "not provisioned"', async () => {
    const lines = await sendAndCollect('/capabilities tools __nonexistent_cap__');
    const combined = lines.join('\n');
    expect(combined).toMatch(/not provisioned/i);
  }, 30_000);

  it('AC4: /capabilities tools (no type) → usage help, no crash', async () => {
    const lines = await sendAndCollect('/capabilities tools');
    const combined = lines.join('\n');
    expect(combined).toMatch(/Usage:/i);
    expect(combined).toContain('/capabilities tools <type>');
  }, 30_000);
});

// Smoke test that runs without a live cluster: verify the HTTP channel guard
// is present and the test infrastructure doesn't throw at import time.
describe('/capabilities tools — e2e infra smoke', () => {
  it('test constants are set', () => {
    expect(HTTP_URL).toMatch(/^http:\/\//);
    expect(CAP_TYPE).toBeTruthy();
  });
});
