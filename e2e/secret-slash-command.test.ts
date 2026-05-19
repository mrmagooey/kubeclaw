/**
 * e2e tests for Story 10: User registers and manages API credentials via the /secret chat command.
 *
 * Acceptance criteria:
 *  AC1. POST /message containing `/secret catalog` → reply lists at least one catalog entry
 *       (showing id, host, and field names).
 *  AC2. POST /message containing `/secret add <catalogId> <value>` → reply confirms registration;
 *       kubectl confirms K8s Secret kubeclaw-group-secrets-<groupFolder> exists.
 *  AC3. POST /message containing `/secret list` after AC2 → reply contains catalogId and
 *       registeredAt timestamp; raw credential value is absent from reply.
 *  AC4. POST /message containing `/secret remove <catalogId>` → reply confirms deletion;
 *       K8s Secret is absent from cluster.
 *  AC5. POST /message containing `/secret add <unknown-id> <value>` → reply contains "Unknown";
 *       no K8s Secret created.
 *
 * LLM-independent — slash commands are intercepted in channel-runner.ts before the LLM queue.
 *
 * Prerequisites:
 *  - kind cluster kubeclaw-e2e-istio (context: kind-kubeclaw-e2e-istio)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup from racing this install)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const NS = 'kubeclaw-e2e-usersec';
const RELEASE = 'ke2e-usersec';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14095;
const HTTP_PORT = 4080; // channel pod's httpPort (default)

// Users
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';

// The group folder for alice via HTTP channel:
//   jidToFolder("http", "http:alice") → prefix "http", sanitize "http:alice" → "http-alice" → "http-http-alice"
const ALICE_GROUP_FOLDER = 'http-http-alice';

// The catalog entry declared in helm values
const CATALOG_ID = 'e2e-svc';

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
// Max time to wait for an SSE reply from the channel
const SSE_REPLY_TIMEOUT_MS = 20_000;

let portForwardProc: ChildProcess | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function kube(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(
      `kubectl --context ${CONTEXT} --namespace ${NS} ${args}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * POST a message to the channel via the forwarded port and return the HTTP status.
 */
async function postMessage(user: string, pass: string, text: string): Promise<number> {
  const res = await fetch(`http://localhost:${LOCAL_PORT}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/**
 * Open an SSE stream to /stream and collect data lines until `matcher` returns true
 * or the timeout expires. Returns all data lines collected.
 *
 * The caller must send the triggering POST *after* calling this function so the
 * SSE client is already registered when the reply arrives.
 */
async function collectSseReply(
  user: string,
  pass: string,
  matcher: (lines: string[]) => boolean,
  timeoutMs = SSE_REPLY_TIMEOUT_MS,
): Promise<string[]> {
  const controller = new AbortController();
  const sseLines: string[] = [];
  let done = false;

  const ssePromise = fetch(`http://localhost:${LOCAL_PORT}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200) return;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            sseLines.push(line.slice(6));
          }
        }
      }
    } catch {
      // AbortError expected on cleanup
    }
  });

  // Give the SSE connection time to establish before caller sends the POST
  await sleep(500);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher(sseLines)) break;
    await sleep(300);
  }

  done = true;
  controller.abort();
  await ssePromise.catch(() => {});

  return sseLines;
}

/**
 * Send a POST and wait for an SSE reply matching `matcher`.
 * Returns { status, replyLines }.
 */
async function sendAndCollect(
  user: string,
  pass: string,
  text: string,
  matcher: (lines: string[]) => boolean,
  timeoutMs = SSE_REPLY_TIMEOUT_MS,
): Promise<{ status: number; replyLines: string[] }> {
  const controller = new AbortController();
  const sseLines: string[] = [];
  let done = false;

  // Start SSE listener before POST so we do not miss the reply
  const ssePromise = fetch(`http://localhost:${LOCAL_PORT}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200) return;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            sseLines.push(line.slice(6));
          }
        }
      }
    } catch {
      // AbortError expected
    }
  });

  // Give SSE time to connect
  await sleep(500);

  // Send the message
  const status = await postMessage(user, pass, text);

  // Wait for matching reply
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher(sseLines)) break;
    await sleep(300);
  }

  done = true;
  controller.abort();
  await ssePromise.catch(() => {});

  return { status, replyLines: sseLines };
}

/**
 * Wait until the port-forward is accepting connections.
 */
async function waitForPortForward(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LOCAL_PORT}/`, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: basicAuth('probe', 'x') },
      });
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`);
}

/**
 * Kill any stale process on LOCAL_PORT, then start a fresh port-forward to the channel pod.
 */
async function startPortForward(): Promise<ChildProcess> {
  execSync(`fuser -k ${LOCAL_PORT}/tcp 2>/dev/null || true`, { shell: true });
  await sleep(1000);

  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const pf = spawn(
    'kubectl',
    [
      '--context', CONTEXT,
      '--namespace', NS,
      'port-forward',
      `pod/${channelPodName}`,
      `${LOCAL_PORT}:${HTTP_PORT}`,
    ],
    { stdio: 'ignore', detached: false },
  );

  await waitForPortForward(30_000);
  return pf;
}

// ── Skip guard ────────────────────────────────────────────────────────────────

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
  '/secret slash command end-to-end (Story 10)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, { stdio: 'pipe' });
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write a values file (avoid --set-json comma-separator ambiguity for catalog arrays).
      // Use credentialInjection.mode="off" so that the Envoy sidecar is NOT injected into
      // the channel pod. (The sidecar requires cert-manager and an egress CA, which are
      // unavailable in the kind cluster used for e2e tests.) The catalog ConfigMap is
      // injected manually after helm install so that the orchestrator's CatalogInformer
      // can serve catalog entries to the /secret slash command.
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-usersec-'));
      const valuesFile = path.join(valuesDir, 'values.yaml');
      writeFileSync(
        valuesFile,
        [
          `namespace: ${NS}`,
          `image:`,
          `  tag: e2e-test`,
          `  pullPolicy: IfNotPresent`,
          `credentialInjection:`,
          `  mode: "off"`,
          `  broker:`,
          `    image: kubeclaw-orchestrator:e2e-test`,
          `orchestrator:`,
          `  replicas: 1`,
          `channels:`,
          `  http:`,
          `    enabled: true`,
          `    type: http`,
          `    httpPort: ${HTTP_PORT}`,
          `    envVars:`,
          `      - name: HTTP_CHANNEL_USERS`,
          `        key: users`,
          `secrets:`,
          `  httpChannelUsers: "${ALICE_USER}:${ALICE_PASS}"`,
          `networkPolicy:`,
          `  enabled: false`,
        ].join('\n'),
      );

      try {
        execSync(
          [
            `helm --kube-context ${CONTEXT} upgrade --install ${RELEASE} ./helm/kubeclaw`,
            `--namespace ${NS} --create-namespace`,
            `-f ${valuesFile}`,
          ].join(' '),
          { stdio: 'inherit', timeout: 120_000 },
        );
      } finally {
        rmSync(valuesDir, { recursive: true, force: true });
      }
      installed = true;

      // Manually create the kubeclaw-credential-broker-config ConfigMap that the
      // orchestrator's CatalogInformer reads. Normally created by helm when
      // credentialInjection.mode != "off", but we use mode=off to avoid the Envoy
      // sidecar (which requires cert-manager). The ConfigMap format must match
      // what loadBrokerConfig() expects: a "config.yaml" key with a YAML document
      // containing a "catalog" array.
      const catalogConfigMap = [
        `apiVersion: v1`,
        `kind: ConfigMap`,
        `metadata:`,
        `  name: kubeclaw-credential-broker-config`,
        `  namespace: ${NS}`,
        `data:`,
        `  config.yaml: |`,
        `    mappings: []`,
        `    catalog:`,
        `      - id: "${CATALOG_ID}"`,
        `        host: "api.e2e.example.com"`,
        `        upstreamPort: 443`,
        `        credentialFields:`,
        `          - { name: "token", envVar: "E2E_TOKEN" }`,
        `        baseUrlEnvs: {}`,
        `        allowOperatorFallback: false`,
        `        allowedPositions: ["header", "body"]`,
      ].join('\n');
      execSync(
        `kubectl --context ${CONTEXT} apply -f - <<'YAML'\n${catalogConfigMap}\nYAML`,
        { shell: '/bin/bash', stdio: 'pipe' },
      );

      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      portForwardProc = await startPortForward();

      // Give the orchestrator's secret deps (Redis stream watchers) a moment to initialise
      await sleep(5000);
    }, INSTALL_TIMEOUT);

    afterAll(() => {
      if (portForwardProc) {
        portForwardProc.kill();
        portForwardProc = null;
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

    // ── AC1: /secret catalog lists at least one entry ─────────────────────────

    it(
      'AC1: /secret catalog returns reply with catalog entry id, host, and field names',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/secret catalog',
          (lines) => lines.some((l) => l.includes(CATALOG_ID)),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(
          replyText,
          `Reply must contain catalog id "${CATALOG_ID}"`,
        ).toContain(CATALOG_ID);
        expect(
          replyText,
          'Reply must contain the host "api.e2e.example.com"',
        ).toContain('api.e2e.example.com');
        expect(
          replyText,
          'Reply must mention field name "token"',
        ).toContain('token');
      },
      TEST_TIMEOUT,
    );

    // ── AC2: /secret add creates a K8s Secret ────────────────────────────────

    // Shared token value used across AC2 / AC3 / AC4
    const secretToken = `e2esecret-${Date.now()}`;

    it(
      'AC2: /secret add <catalogId> <value> confirms registration and creates K8s Secret',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/secret add ${CATALOG_ID} ${secretToken}`,
          // The success reply is "Got it — <id> is now configured for this group."
          (lines) => lines.some((l) => l.toLowerCase().includes('configured') || l.toLowerCase().includes('got it')),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n').toLowerCase(),
          'Reply must confirm credential was registered',
        ).toMatch(/configured|got it|registered|stored/i);

        // Verify K8s Secret exists
        const secretName = `kubeclaw-group-secrets-${ALICE_GROUP_FOLDER}`;
        const out = kube(
          `get secret ${secretName} -o name`,
          { allowFail: true },
        );
        expect(
          out,
          `K8s Secret ${secretName} must exist after /secret add`,
        ).toContain(secretName);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: /secret list shows catalogId + registeredAt, no raw value ────────

    it(
      'AC3: /secret list shows catalogId and registeredAt; raw credential value is absent',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/secret list',
          // Reply should contain the catalogId
          (lines) => lines.some((l) => l.includes(CATALOG_ID)),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(
          replyText,
          `Reply must contain catalog id "${CATALOG_ID}"`,
        ).toContain(CATALOG_ID);
        expect(
          replyText,
          'Reply must contain a registeredAt timestamp',
        ).toMatch(/registered\s/i);

        // The raw token must NOT appear in the reply
        expect(
          replyText,
          'Reply must NOT contain the raw credential value',
        ).not.toContain(secretToken);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: /secret remove deletes the K8s Secret ───────────────────────────

    it(
      'AC4: /secret remove <catalogId> confirms deletion and K8s Secret is gone',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/secret remove ${CATALOG_ID}`,
          // Reply: "Removed — credentials for '<id>' have been cleared for this group."
          (lines) => lines.some((l) => l.toLowerCase().includes('removed') || l.toLowerCase().includes('cleared')),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n').toLowerCase(),
          'Reply must confirm credential removal',
        ).toMatch(/removed|cleared|deleted/i);

        // K8s Secret must be gone
        const secretName = `kubeclaw-group-secrets-${ALICE_GROUP_FOLDER}`;
        const out = kube(
          `get secret ${secretName} 2>&1 || echo NOTFOUND`,
          { allowFail: true },
        );
        expect(
          out,
          `K8s Secret ${secretName} must not exist after /secret remove`,
        ).toMatch(/not found|NOTFOUND/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: /secret add with unknown catalogId is rejected ──────────────────

    it(
      'AC5: /secret add with unknown catalogId returns rejection; no K8s Secret created',
      async () => {
        const unknownId = 'no-such-provider-xyz';
        const dummyValue = `dummy-${Date.now()}`;

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/secret add ${unknownId} ${dummyValue}`,
          // Reply should contain "Unknown"
          (lines) => lines.some((l) => l.toLowerCase().includes('unknown')),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n'),
          'Reply must contain "Unknown" for unrecognised catalogId',
        ).toMatch(/unknown/i);

        // No K8s Secret should have been created for this group folder
        const secretName = `kubeclaw-group-secrets-${ALICE_GROUP_FOLDER}`;
        const out = kube(
          `get secret ${secretName} 2>&1 || echo NOTFOUND`,
          { allowFail: true },
        );
        expect(
          out,
          'No K8s Secret must exist after rejected /secret add',
        ).toMatch(/not found|NOTFOUND/i);
      },
      TEST_TIMEOUT,
    );
  },
);
