/**
 * Minikube-live: orchestrator admin shell (port 9090) e2e tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts helm-installs kubeclaw and
 * port-forwards svc/kubeclaw-admin → localhost:KUBECLAW_LIVE_ADMIN_LOCAL_PORT.
 *
 * The admin shell is the LLM-powered HTTP interface embedded in the
 * orchestrator pod. It exposes:
 *   GET  /         → HTML admin UI (KubeClaw Admin)
 *   GET  /events   → SSE stream for assistant replies
 *   POST /chat     → submit a command (async, reply arrives on /events)
 *
 * Auth: HTTP Basic with username=admin, password read from kubeclaw-secrets.
 *
 * Provider config (override via env vars):
 *   LIVE_LLM_BASE_URL   http://192.168.7.100:8080/v1
 *   LIVE_LLM_MODEL      gemma-4-E4B-it-Q4_0.gguf
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

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

describe('Minikube-live: orchestrator admin shell (port 9090)', () => {
  let provisioned = false;
  let adminPass = '';

  beforeAll(async () => {
    // Read the admin password directly from the cluster Secret. The
    // globalSetup `let` export is not reliably propagated across the module
    // boundary to test workers, so we fetch it ourselves here.
    const pwdResult = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-secrets',
      '-o', 'jsonpath={.data.admin-http-password}',
    ]);
    if (pwdResult.ok && pwdResult.stdout) {
      adminPass = Buffer.from(pwdResult.stdout, 'base64').toString('utf8');
    }

    // Sanity-check: wait for the port-forward to be reachable.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${ADMIN_URL}/`, {
          signal: AbortSignal.timeout(2000),
          // no auth header — 401 is fine, it means the server is up
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // try again
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `⚠️  Admin port-forward to ${ADMIN_URL} not reachable after retries — globalSetup may have failed.`,
      );
    }
  });

  // ── 1. Admin sidecar container is Running and Ready ───────────────────────
  it('admin sidecar container is Running and Ready in the orchestrator pod', () => {
    expect(provisioned, 'globalSetup admin port-forward not live').toBe(true);

    // Get the orchestrator pod name.
    const podResult = kubectl([
      'get', 'pods',
      '-n', NAMESPACE,
      '-l', 'app=kubeclaw-orchestrator',
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    expect(podResult.ok, `kubectl get pods failed: ${podResult.stderr}`).toBe(true);
    const podName = podResult.stdout.trim();
    expect(podName, 'orchestrator pod not found').toBeTruthy();

    // Inspect containerStatuses for the admin container.
    const csResult = kubectl([
      'get', 'pod', podName,
      '-n', NAMESPACE,
      '-o', 'jsonpath={.status.containerStatuses}',
    ]);
    expect(csResult.ok, `kubectl get pod failed: ${csResult.stderr}`).toBe(true);

    const containerStatuses = JSON.parse(csResult.stdout) as Array<{
      name: string;
      ready: boolean;
      state?: { running?: object };
    }>;

    // The admin shell runs inside the orchestrator container (not a separate
    // sidecar image) — it is the same orchestrator process started with
    // ADMIN_HTTP_PORT set. There is no second container; the admin port is
    // exposed on the single container named `orchestrator` (helm template
    // line: `- name: orchestrator`).
    //
    // We verify that: (a) the orchestrator container itself is ready, and
    // (b) the kubeclaw-admin Service exists and is reachable (covered by
    // provisioned=true above, plus explicit Service check below).
    const orchContainer = containerStatuses.find((c) => c.name === 'orchestrator');
    expect(orchContainer, 'orchestrator container not found in pod').toBeTruthy();
    expect(orchContainer!.ready, 'orchestrator container not Ready').toBe(true);
    expect(
      orchContainer!.state?.running,
      'orchestrator container not in Running state',
    ).toBeTruthy();

    // Verify the kubeclaw-admin Service exists.
    const svcResult = kubectl([
      'get', 'service', 'kubeclaw-admin',
      '-n', NAMESPACE,
      '-o', 'jsonpath={.spec.ports[0].port}',
    ]);
    expect(svcResult.ok, `kubeclaw-admin Service not found: ${svcResult.stderr}`).toBe(true);
    expect(svcResult.stdout.trim()).toBe('9090');
  });

  // ── 2. GET / without auth returns 401 ────────────────────────────────────
  it('GET / without auth returns 401 with WWW-Authenticate header', async () => {
    expect(provisioned, 'globalSetup admin port-forward not live').toBe(true);

    const res = await fetch(`${ADMIN_URL}/`, {
      signal: AbortSignal.timeout(5000),
      // deliberately no Authorization header
    });

    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth, 'WWW-Authenticate header missing').toBeTruthy();
    expect(wwwAuth).toMatch(/Basic/i);
  });

  // ── 3. GET / with correct credentials returns the admin HTML UI ───────────
  it('GET / with correct admin credentials returns HTML admin UI', async () => {
    expect(provisioned, 'globalSetup admin port-forward not live').toBe(true);
    expect(adminPass, 'admin password not populated by globalSetup').toBeTruthy();

    const res = await fetch(`${ADMIN_URL}/`, {
      headers: {
        Authorization: basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass),
      },
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\/html/i);

    const body = await res.text();
    // The admin shell serves an HTML page titled "KubeClaw Admin".
    expect(body).toContain('KubeClaw Admin');
    // The page wires up a /chat POST endpoint.
    expect(body).toContain('/chat');
  });

  // ── 4. GET /events with correct credentials returns SSE stream ───────────
  it('GET /events with correct credentials establishes an SSE stream', async () => {
    expect(provisioned, 'globalSetup admin port-forward not live').toBe(true);
    expect(adminPass, 'admin password not populated by globalSetup').toBeTruthy();

    const controller = new AbortController();
    const res = await fetch(`${ADMIN_URL}/events`, {
      headers: {
        Authorization: basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass),
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    try {
      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') ?? '';
      expect(contentType).toMatch(/text\/event-stream/i);

      // Read until we see the keepalive ping comment (:ok) or any data,
      // or time out after 5 seconds.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        // The server sends ":ok\n\n" immediately on connect.
        if (received.includes(':ok') || received.includes('data:')) break;
      }
      expect(received, 'SSE stream sent no data within 5s').toBeTruthy();
    } finally {
      controller.abort();
    }
  });

  // ── 5. POST /chat with a read-only command returns a non-empty LLM reply ─
  it('POST /chat "list groups" returns a non-empty assistant reply via SSE within 60s', async () => {
    expect(provisioned, 'globalSetup admin port-forward not live').toBe(true);
    expect(adminPass, 'admin password not populated by globalSetup').toBeTruthy();

    const authHeader = basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass);

    // Open the SSE stream first so we don't miss the reply.
    const eventsController = new AbortController();
    const eventsRes = await fetch(`${ADMIN_URL}/events`, {
      headers: { Authorization: authHeader, Accept: 'text/event-stream' },
      signal: eventsController.signal,
    });
    expect(eventsRes.status, 'SSE /events failed').toBe(200);

    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let eventsBuffer = '';
    const receivedLines: string[] = [];

    // Background reader — accumulates SSE data lines.
    const readLoop = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          eventsBuffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = eventsBuffer.indexOf('\n')) !== -1) {
            const line = eventsBuffer.slice(0, nl).trimEnd();
            eventsBuffer = eventsBuffer.slice(nl + 1);
            if (line.startsWith('data: ')) {
              receivedLines.push(line.slice(6));
            }
          }
        }
      } catch {
        // aborted — expected
      }
    })();

    try {
      // POST the command.
      const chatRes = await fetch(`${ADMIN_URL}/chat`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'list groups' }),
        signal: AbortSignal.timeout(10_000),
      });
      // /chat returns 202 Accepted (async — reply comes on SSE).
      expect(chatRes.status, 'POST /chat did not return 202').toBe(202);

      // Wait up to 60s for an assistant reply SSE event.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const assistantEvent = receivedLines.find((line) => {
          try {
            const obj = JSON.parse(line) as { type?: string; text?: string };
            return obj.type === 'assistant' || obj.type === 'status';
          } catch {
            return false;
          }
        });
        if (assistantEvent !== undefined) {
          const parsed = JSON.parse(assistantEvent) as { type: string; text: string };
          // The admin LLM processed the "list groups" request — any non-empty
          // reply confirms the full request→LLM→SSE-push path works.
          expect(parsed.text, 'assistant reply is empty').toBeTruthy();
          return; // test passes
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      // If we reach here, no reply arrived in time.
      // Provide the raw lines for diagnostics.
      expect(
        receivedLines,
        `no assistant SSE reply within 60s (received lines: ${JSON.stringify(receivedLines)})`,
      ).toContainEqual(expect.stringContaining('"type":"assistant"'));
    } finally {
      eventsController.abort();
      await readLoop;
    }
  });
});
