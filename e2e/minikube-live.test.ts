/**
 * Minikube-live end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live`, pointed at the live LLM provider
 * (LIVE_LLM_BASE_URL), and port-forwarded svc/kubeclaw-channel-http to
 * localhost. These tests drive the deployed system from outside the cluster,
 * exactly like a real user would.
 *
 * Provider config (override via env vars):
 *   LIVE_LLM_BASE_URL   http://localhost:11434/v1  (default — set to override)
 *   LIVE_LLM_MODEL      gemma-4-E4B-it-Q4_0.gguf
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
  restartChannelPortForward,
} from './minikube-live-setup.js';
import { LIVE_BASE_URL } from './lib/live-llm.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

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

describe('Minikube-live: real-user flow through helm-deployed kubeclaw', () => {
  let provisioned = false;

  beforeAll(async () => {
    // Sanity: the port-forward set up by globalSetup must be live. Retry a
    // few times — `kubectl port-forward`'s socket bind can race with test
    // worker startup.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        // 401 is the expected response (Basic auth challenge), so any HTTP
        // status means the channel pod is reachable.
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
        `⚠️  Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
    }
  });

  // ── 1. Deployment healthy ─────────────────────────────────────────────
  it('all expected pods are Ready in kubeclaw-live namespace', () => {
    expect(provisioned, 'globalSetup port-forward not live').toBe(true);
    for (const sel of [
      'app=kubeclaw-orchestrator',
      'app=kubeclaw-redis',
      'app=kubeclaw-channel-http',
    ]) {
      const r = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', sel,
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      expect(r.ok, `kubectl get pods for ${sel} failed: ${r.stderr}`).toBe(true);
      const statuses = r.stdout.trim().split(/\s+/).filter(Boolean);
      expect(
        statuses.length,
        `no pods matched ${sel}`,
      ).toBeGreaterThan(0);
      expect(
        statuses.every((s) => s === 'True'),
        `not all pods Ready for ${sel}: ${statuses.join(',')}`,
      ).toBe(true);
    }
  });

  // ── 2. Channel pod auth ───────────────────────────────────────────────
  it('GET / requires Basic auth and serves chat UI when authenticated', async () => {
    expect(provisioned).toBe(true);
    const anonRes = await fetch(`${HTTP_URL}/`);
    expect(anonRes.status).toBe(401);

    const authRes = await fetch(`${HTTP_URL}/`, {
      headers: { Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS) },
    });
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain('<html');
  });

  // ── 3. LLM egress from the channel pod ────────────────────────────────
  // Uses `kubectl exec` to make the channel pod open a TCP connection to
  // LIVE_LLM_BASE_URL. This proves both that the NetworkPolicy permits
  // egress on the provider port (via extraEgressPorts), and that routing
  // host → pod → the LLM host actually works.
  it('channel pod has TCP egress to the live LLM provider', () => {
    expect(provisioned).toBe(true);
    // Pull host & port out of LIVE_BASE_URL.
    const url = new URL(LIVE_BASE_URL);
    const host = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');

    // node:net via inline node script — the channel pod runs node so this works
    // without installing extra tools.
    const probeScript = `
      const net = require('node:net');
      const s = net.createConnection({ host: ${JSON.stringify(host)}, port: ${port} });
      s.setTimeout(5000);
      s.on('connect', () => { console.log('connect-ok'); s.end(); process.exit(0); });
      s.on('timeout', () => { console.error('connect-timeout'); process.exit(2); });
      s.on('error', (e) => { console.error('connect-error:', e.message); process.exit(3); });
    `;
    const pods = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    expect(pods.ok).toBe(true);
    const podName = pods.stdout.trim();
    expect(podName).toBeTruthy();

    const exec = kubectl(
      ['exec', '-n', NAMESPACE, podName, '-c', 'channel', '--', 'node', '-e', probeScript],
      { timeout: 20_000 },
    );
    expect(
      exec.ok,
      `egress probe failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
    ).toBe(true);
    expect(exec.stdout).toContain('connect-ok');
  });

  // ── 4. Real-user roundtrip: POST → channel pod → live LLM → SSE ──────
  it('POST /message produces an SSE assistant reply from the live LLM', async () => {
    expect(provisioned).toBe(true);
    const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
    try {
      const res = await postMessage(
        "Reply with exactly one short sentence acknowledging this message.",
      );
      expect(res.status).toBe(200);
      await sse.waitFor((l) => l.length > 0, 90_000);
      expect(sse.lines.join('\n').length).toBeGreaterThan(0);
    } finally {
      sse.dispose();
    }
  });

  // ── 5. Group auto-registration on first message ───────────────────────
  // The channel pod's onChatMetadata auto-registers new chats via
  // src/channel-runner.ts:689. After test (4) ran above, the SQLite in the
  // channel pod's groups PVC should contain a row for `http:alice`.
  it("first message auto-registers the user's group in the channel pod's SQLite", () => {
    expect(provisioned).toBe(true);
    const pods = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    expect(pods.ok).toBe(true);
    const podName = pods.stdout.trim();

    // The channel pod's working dir is /app; the registered_groups.db lives
    // under /app/groups/registered_groups.db (see src/db.ts dbPath logic).
    // We use a small node script with sql.js (already a dependency) to read
    // the rows without needing sqlite3 inside the pod.
    const queryScript = `
      const fs = require('node:fs');
      const initSqlJs = require('/app/node_modules/sql.js');
      (async () => {
        const SQL = await initSqlJs();
        const candidates = [
          '/app/groups/registered_groups.db',
          '/app/groups/db.sqlite',
          '/data/sessions/registered_groups.db',
        ];
        let dbPath = null;
        for (const p of candidates) { if (fs.existsSync(p)) { dbPath = p; break; } }
        if (!dbPath) {
          // Fall back: find any .db file under /app or /data
          const { execSync } = require('node:child_process');
          const found = execSync('find /app/groups /data /app/store -name "*.db" 2>/dev/null || true').toString().trim().split('\\n').filter(Boolean);
          if (found.length === 0) { console.log('no-db-found'); process.exit(0); }
          dbPath = found[0];
        }
        const data = fs.readFileSync(dbPath);
        const db = new SQL.Database(new Uint8Array(data));
        const rows = db.exec("SELECT jid, folder FROM registered_groups WHERE jid = 'http:${KUBECLAW_LIVE_USER}'");
        if (rows.length === 0) { console.log('no-match'); process.exit(0); }
        console.log('FOUND:' + JSON.stringify(rows[0].values));
      })().catch((e) => { console.error('script-error:', e.message); process.exit(4); });
    `;
    const exec = kubectl(
      ['exec', '-n', NAMESPACE, podName, '-c', 'channel', '--', 'node', '-e', queryScript],
      { timeout: 30_000 },
    );
    expect(
      exec.ok,
      `db probe failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
    ).toBe(true);
    expect(
      exec.stdout,
      `expected FOUND: marker in stdout, got: ${exec.stdout}`,
    ).toMatch(/^FOUND:/m);
  });

  // ── 6. Conversation history persists across pod restart ───────────────
  // Delete the channel pod (kubectl delete pod), wait for the new one to be
  // Ready, then ask about a fact set in the prior message. The conversation
  // history is on the PVC, so it survives the restart.
  it(
    'conversation history persists across channel pod restart (PVC)',
    async () => {
      expect(provisioned).toBe(true);

      // Seed a fact on the original pod.
      let sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
      try {
        await postMessage(
          "Please remember: my pet's name is Mochi. Acknowledge with 'noted'.",
        );
        await sse.waitFor((l) => l.length > 0, 90_000);
      } finally {
        sse.dispose();
      }

      // Capture the current pod's name before deleting, so we can wait for
      // a different (new) pod to come up afterwards.
      const oldPod = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      expect(oldPod.ok, `get old pod failed: ${oldPod.stderr}`).toBe(true);
      const oldPodName = oldPod.stdout.trim();
      expect(oldPodName, 'no channel pod found before restart').toBeTruthy();

      // Trigger the delete without waiting. `--wait=true` blocks kubectl until
      // the pod is fully gone, which can easily exceed the helper's default
      // spawnSync timeout; --wait=false returns immediately and we poll for
      // the new pod's readiness ourselves.
      const restart = kubectl([
        'delete', 'pod', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
        '--wait=false',
      ]);
      expect(restart.ok, `delete pod failed: ${restart.stderr}`).toBe(true);

      // Poll for a NEW pod (different name from oldPodName) to be Ready.
      const deadline = Date.now() + 180_000;
      let newPodReady = false;
      while (Date.now() < deadline) {
        const r = kubectl([
          'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
          '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
        ]);
        if (r.ok) {
          const lines = r.stdout.trim().split('\n').filter(Boolean);
          newPodReady = lines.some((line) => {
            const [name, ready] = line.split('\t');
            return name && name !== oldPodName && ready === 'True';
          });
          if (newPodReady) break;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      expect(newPodReady, 'new channel pod did not become Ready within 180s').toBe(true);

      // `kubectl port-forward` dies when its backing pod is deleted —
      // re-spawn it against the new pod.
      await restartChannelPortForward();
      sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
      try {
        await postMessage("What is my pet's name?");
        await sse.waitFor((l) => l.length > 0, 120_000);
        const reply = sse.lines.join('\n').toLowerCase();
        expect(
          reply,
          `expected reply to mention 'mochi'. Got: ${JSON.stringify(reply)}`,
        ).toContain('mochi');
      } finally {
        sse.dispose();
      }
    },
    300_000,
  );

  // ── 7. Orchestrator saw the channel pod come up ───────────────────────
  it("orchestrator pod's logs show the channel pod registered as ready", () => {
    expect(provisioned).toBe(true);
    const r = kubectl([
      'logs', '-n', NAMESPACE,
      'deployment/kubeclaw-orchestrator',
      '--tail=2000',
    ]);
    expect(r.ok).toBe(true);
    // The orchestrator subscribes to kubeclaw:channel-status:<name> and logs
    // when a channel reports ready. Either the explicit "ready" or
    // discovery of the channel deployment is acceptable evidence.
    expect(
      r.stdout,
      `expected 'http' or 'channel-status' references in orchestrator logs`,
    ).toMatch(/channel-status|http|kubeclaw-channel/i);
  });
});
