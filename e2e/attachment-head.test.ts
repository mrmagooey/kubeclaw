/**
 * e2e tests for Story 30: HEAD /attachments/raw/<filename> via HTTP channel.
 *
 * Acceptance criteria:
 *  AC1. Authenticated HEAD of existing file → 200 + Content-Type + Content-Length, empty body.
 *  AC2. HEAD of nonexistent filename → 404, no body.
 *  AC3. Unauthenticated HEAD → 401, no body.
 *  AC4. HEAD with path traversal `../etc/passwd` → 400, no body.
 *
 * LLM-independent.
 *
 * Prerequisites:
 *  - kind cluster kubeclaw-e2e-istio (context: kind-kubeclaw-e2e-istio)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup racing this install)
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const NS = 'kubeclaw-e2e-head-attach';
const RELEASE = 'ke2e-head-attach';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14115; // unique: no other e2e test uses this port
const HTTP_PORT = 4080; // channel pod's httpPort (default)

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const HTTP_USERS = `${ALICE_USER}:${ALICE_PASS}`;

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

// Minimal valid JPEG bytes (SOI + JFIF APP0 + EOI)
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let portForwardProc: ChildProcess | null = null;

// ── Skip guard ──────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
 * Send a raw HTTP request using Node's http.request, which does NOT
 * normalise the path (unlike fetch / URL). Used to deliver literal `..`
 * path-traversal sequences to the server.
 *
 * Returns an object with status code, headers, and collected body chunks.
 */
function rawRequest(
  method: string,
  rawPath: string,
  authHeader?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; bodyLength: number }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: 'localhost',
      port: LOCAL_PORT,
      path: rawPath,
      method,
      headers: authHeader ? { Authorization: authHeader } : {},
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bodyLength: Buffer.concat(chunks).length,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(
    `Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`,
  );
}

async function startPortForward(timeoutMs = 240_000): Promise<ChildProcess> {
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

  await waitForPortForward(timeoutMs);
  return pf;
}

/**
 * Build a multipart/form-data body manually.
 */
function buildMultipart(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer;
  }>,
): { body: Buffer; contentType: string } {
  const pieces: Buffer[] = [];
  const CRLF = '\r\n';
  const sep = `--${boundary}`;

  for (const part of parts) {
    let header = `${sep}${CRLF}`;
    header += `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += CRLF;
    if (part.contentType) {
      header += `Content-Type: ${part.contentType}${CRLF}`;
    }
    header += CRLF;

    pieces.push(Buffer.from(header, 'ascii'));
    pieces.push(part.data);
    pieces.push(Buffer.from(CRLF, 'ascii'));
  }

  pieces.push(Buffer.from(`${sep}--${CRLF}`, 'ascii'));

  return {
    body: Buffer.concat(pieces),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * POST a minimal JPEG as the given user. Returns the HTTP Response.
 */
async function postImage(user: string, pass: string): Promise<Response> {
  const boundary = `ke2e-boundary-${Date.now()}`;
  const { body, contentType } = buildMultipart(boundary, [
    {
      name: 'image',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      data: MINIMAL_JPEG,
    },
  ]);

  return fetch(`http://localhost:${LOCAL_PORT}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: basicAuth(user, pass),
    },
    body,
  });
}

/**
 * Wait until a [ImageAttachment: ...] SSE event is echoed in conversation_history
 * for the given user's JID, then extract the filename from the marker.
 *
 * Returns the filename (e.g. "img-1234567-abcd.jpg") or null on timeout.
 */
async function extractFilenameFromConvHistory(
  user: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  const jid = `http:${user}`;
  const DB_PATH = '/app/store/messages-http.db';

  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const script = `
(async () => {
  const fs = require('node:fs');
  const initSqlJs = require('/app/node_modules/sql.js');
  const SQL = await initSqlJs({
    locateFile: () => '/app/node_modules/sql.js/dist/sql-wasm.wasm',
  });
  const dbPath = '${DB_PATH}';
  if (!fs.existsSync(dbPath)) { console.log(''); return; }
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(data));
  const res = db.exec(
    "SELECT content FROM conversation_history WHERE group_folder LIKE '%${jid.replace(/:/g, '-')}%' ORDER BY created_at DESC LIMIT 20"
  );
  db.close();
  if (!res[0]) { console.log(''); return; }
  for (const row of res[0].values) {
    const s = String(row[0] ?? '');
    const m = s.match(/\\[ImageAttachment: attachments\\/raw\\/([^\\]]+)/);
    if (m) { console.log(m[1]); return; }
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

    const result = spawnSync(
      'kubectl',
      [
        '--context', CONTEXT,
        '-n', NS,
        'exec',
        `pod/${channelPodName}`,
        '--',
        'node', '-e', script,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
    );

    const found = result.stdout?.trim() ?? '';
    if (found.length > 0) return found;
    await sleep(500);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  'HEAD /attachments/raw/<filename> via HTTP channel (Story 30)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;
    let aliceFilename: string | null = null;

    beforeAll(async () => {
      // Clean up any previous run of this namespace
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for namespace to fully terminate
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, {
            stdio: 'pipe',
          });
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write values file — avoids helm --set comma parsing issues
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-head-attach-'));
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
          `  httpChannelUsers: "${HTTP_USERS}"`,
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

      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      portForwardProc = await startPortForward(240_000);
      await sleep(2000);

      // Upload one image as alice to use in the HEAD tests
      await postImage(ALICE_USER, ALICE_PASS);
      aliceFilename = await extractFilenameFromConvHistory(ALICE_USER, 15_000);
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

    // ── AC1: Authenticated HEAD → 200 + Content-Type + Content-Length, empty body

    it(
      'AC1: authenticated HEAD of existing file returns 200, Content-Type, Content-Length, and empty body',
      async () => {
        expect(
          aliceFilename,
          'Setup must have produced a filename for alice',
        ).not.toBeNull();

        const result = await rawRequest(
          'HEAD',
          `/attachments/raw/${aliceFilename}`,
          basicAuth(ALICE_USER, ALICE_PASS),
        );

        expect(result.status, 'HEAD must return 200').toBe(200);

        const ct = result.headers['content-type'] ?? '';
        expect(ct, 'Content-Type must be image/jpeg').toContain('image/jpeg');

        const cl = result.headers['content-length'];
        expect(cl, 'Content-Length must be present').toBeDefined();
        expect(Number(cl), 'Content-Length must be > 0').toBeGreaterThan(0);

        expect(result.bodyLength, 'HEAD response body must be empty').toBe(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC2: HEAD nonexistent → 404, no body

    it(
      'AC2: HEAD of nonexistent filename returns 404 with empty body',
      async () => {
        const result = await rawRequest(
          'HEAD',
          '/attachments/raw/nonexistent.jpg',
          basicAuth(ALICE_USER, ALICE_PASS),
        );

        expect(result.status, 'HEAD of nonexistent file must return 404').toBe(404);
        expect(result.bodyLength, 'HEAD 404 response body must be empty').toBe(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: Unauthenticated HEAD → 401, no body

    it(
      'AC3: unauthenticated HEAD returns 401 with empty body',
      async () => {
        expect(aliceFilename, 'Setup must have produced a filename').not.toBeNull();

        const result = await rawRequest(
          'HEAD',
          `/attachments/raw/${aliceFilename}`,
          // no auth header
        );

        expect(result.status, 'Unauthenticated HEAD must return 401').toBe(401);
        expect(result.bodyLength, 'HEAD 401 response body must be empty').toBe(0);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: HEAD with path traversal → 400, no body
    // Node's http.request preserves literal `..` in the path, unlike fetch.

    it(
      'AC4: HEAD with path-traversal filename returns 400 with empty body',
      async () => {
        const result = await rawRequest(
          'HEAD',
          '/attachments/raw/../etc/passwd',
          basicAuth(ALICE_USER, ALICE_PASS),
        );

        expect(result.status, 'HEAD with path-traversal must return 400').toBe(400);
        expect(result.bodyLength, 'HEAD 400 response body must be empty').toBe(0);
      },
      TEST_TIMEOUT,
    );
  },
);
