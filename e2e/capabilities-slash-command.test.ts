/**
 * Story 36 e2e: `/capabilities add/list/remove` slash command
 *
 * Prerequisites (cluster must be running before this test):
 *   cluster:     minikube
 *   namespace:    kubeclaw-e2e-caps
 *   helm release: kubeclaw-caps — installed with:
 *     helm upgrade --install kubeclaw-caps ./helm/kubeclaw \
 *       --namespace kubeclaw-e2e-caps \
 *       --set channels.http.enabled=true \
 *       --set channels.http.users[0].username=alice \
 *       --set channels.http.users[0].password=alicepass \
 *       --set channels.http.users[1].username=bob \
 *       --set channels.http.users[1].password=bobpass \
 *       --set-json 'perGroupCapabilities=[{"type":"echo","image":"kubeclaw-echo:e2e-test","scaleDownAfterIdleSeconds":120}]'
 *
 *   Pre-load test image:
 *     docker build -t kubeclaw-echo:e2e-test ./container/echo/ (or similar)
 *     minikube image load kubeclaw-echo:e2e-test
 *
 * Port forwarding expected on localhost:14120 → channel HTTP pod port 3000.
 *
 * This test does NOT execute automatically in CI unless E2E_CAPS=1 is set
 * (to avoid blocking PRs on a cluster dependency that CI doesn't have).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const E2E_CAPS = process.env.E2E_CAPS === '1';
const NAMESPACE = process.env.CAPS_NAMESPACE || 'kubeclaw-e2e-caps';
const HTTP_PORT = process.env.CAPS_HTTP_PORT ? Number(process.env.CAPS_HTTP_PORT) : 14120;
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';

const BASE_URL = `http://localhost:${HTTP_PORT}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * POST a message to the HTTP channel and collect the SSE reply text.
 * Returns the concatenated text of all `data:` SSE events received within
 * `timeoutMs` milliseconds.
 */
async function postMessage(
  user: string,
  pass: string,
  text: string,
  timeoutMs = 15_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${BASE_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(user, pass),
      },
      body: JSON.stringify({ message: text }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    // Collect SSE body
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const textParts: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.text) textParts.push(payload.text);
            if (payload.done) break;
          } catch {
            // non-JSON data line — ignore
          }
        }
      }
    }
    return textParts.join('');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll kubectl until the Deployment exists and has readyReplicas >= 1,
 * or until timeoutMs elapses.
 */
async function waitForDeploymentReady(
  labelSelector: string,
  namespace: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = sh(
        `kubectl get deployment -l ${labelSelector} -n ${namespace} -o jsonpath='{.items[0].status.readyReplicas}' 2>/dev/null`,
      ).trim();
      if (out === '1' || Number(out) >= 1) return;
    } catch {
      // kubectl returned nothing — not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Deployment with selector '${labelSelector}' not ready after ${timeoutMs}ms in ${namespace}`,
  );
}

describe.skipIf(!K8S_AVAILABLE || !E2E_CAPS)(
  'Story 36 e2e: /capabilities add/list/remove',
  () => {
    // Derived from folderPrefixForChannel('http') + channel name 'http' + username
    // e.g. http-http-alice (matches the channel-runner's folderPrefixForChannel logic)
    const aliceGroup = `http-http-${ALICE_USER}`;
    const bobGroup = `http-http-${BOB_USER}`;

    beforeAll(async () => {
      // Ensure the test namespace exists and the echo image is loaded.
      try {
        sh(`kubectl get namespace ${NAMESPACE}`);
      } catch {
        sh(`kubectl create namespace ${NAMESPACE}`);
      }

      // Pre-load the echo image into the kind cluster if kind is the context.
      try {
        sh(
          `minikube image load kubeclaw-echo:e2e-test 2>&1 || true`,
        );
      } catch {
        // Not a kind cluster or image already loaded — continue.
      }
    }, 60_000);

    afterAll(async () => {
      // Best-effort cleanup of any Deployments created during the test.
      try {
        sh(
          `kubectl delete deployment -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
        );
        sh(
          `kubectl delete service -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
        );
        sh(
          `kubectl delete networkpolicy -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
        );
      } catch {
        // ignore cleanup errors
      }
    });

    // ── AC1: /capabilities add echo returns "provisioned" and deployment name ─

    it('AC1: /capabilities add echo → reply contains "provisioned" and deployment name', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities add echo', 30_000);
      expect(reply.toLowerCase()).toContain('provisioned');
      expect(reply).toMatch(/mcp-echo-[0-9a-f]+/);
    }, 60_000);

    it(
      'AC1: within 60s the echo Deployment has readyReplicas=1 for alice\'s group',
      async () => {
        // Deployment label selector is capability=echo + group-hash from alice's folder.
        // We query by the capability label since we don't know the exact hash here.
        await waitForDeploymentReady(
          `kubeclaw.io/capability=echo,kubeclaw.io/scope=group`,
          NAMESPACE,
          60_000,
        );
      },
      90_000,
    );

    // ── AC2: /capabilities list returns type, replicas, lastUsedAt, scaleDownAfterIdleSeconds ─

    it('AC2: /capabilities list returns capability with required fields', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities list', 20_000);

      expect(reply).toContain('echo');
      expect(reply).toContain('replicas');
      expect(reply).toContain('lastUsedAt');
      expect(reply).toContain('scaleDownAfterIdleSeconds');
      expect(reply).toContain('120'); // configured in helm values
    }, 60_000);

    it('AC2: lastUsedAt in list reply is either "never" or ISO-8601', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities list', 20_000);
      // Either 'never' or a string matching ISO-8601 pattern
      const hasNever = reply.includes('never');
      const hasIso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(reply);
      expect(hasNever || hasIso).toBe(true);
    }, 60_000);

    // ── AC3: second /capabilities add echo is idempotent ─────────────────────

    it('AC3: /capabilities add echo a second time returns "already provisioned"', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities add echo', 20_000);
      expect(reply.toLowerCase()).toContain('already provisioned');
    }, 60_000);

    it('AC3: Deployment metadata.uid unchanged after second add', async () => {
      const uid1 = sh(
        `kubectl get deployment -l kubeclaw.io/capability=echo,kubeclaw.io/scope=group -n ${NAMESPACE} -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null`,
      ).trim();

      // Second add (idempotent — should not change K8s object)
      await postMessage(ALICE_USER, ALICE_PASS, '/capabilities add echo', 20_000);

      const uid2 = sh(
        `kubectl get deployment -l kubeclaw.io/capability=echo,kubeclaw.io/scope=group -n ${NAMESPACE} -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null`,
      ).trim();

      expect(uid1).toBeTruthy();
      expect(uid1).toBe(uid2);
    }, 60_000);

    // ── AC5: per-group isolation — bob sees empty list ────────────────────────

    it('AC5: bob sees no capabilities even though alice\'s Deployment exists', async () => {
      const reply = await postMessage(BOB_USER, BOB_PASS, '/capabilities list', 20_000);
      // Bob's list must not include the echo capability (scoped to alice)
      expect(reply.toLowerCase()).toMatch(/no capabilities provisioned/);
    }, 60_000);

    // ── AC4: /capabilities remove deletes Deployment and DB row ──────────────

    it('AC4: /capabilities remove echo deletes Deployment within 30s', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities remove echo', 20_000);
      expect(reply.toLowerCase()).toContain('removed');

      // Poll until the Deployment disappears
      const deadline = Date.now() + 30_000;
      let gone = false;
      while (Date.now() < deadline) {
        try {
          const items = sh(
            `kubectl get deployment -l kubeclaw.io/capability=echo,kubeclaw.io/scope=group -n ${NAMESPACE} -o jsonpath='{.items}' 2>/dev/null`,
          ).trim();
          if (items === '[]' || items === '') {
            gone = true;
            break;
          }
        } catch {
          // kubectl error — treat as gone
          gone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(gone).toBe(true);
    }, 60_000);

    it('AC4: after remove, /capabilities list returns empty for alice', async () => {
      const reply = await postMessage(ALICE_USER, ALICE_PASS, '/capabilities list', 20_000);
      expect(reply.toLowerCase()).toMatch(/no capabilities provisioned/);
    }, 60_000);
  },
);
