/**
 * e2e tests for Story 19: Attachment download via HTTP channel.
 *
 * Acceptance criteria:
 *  AC1. Authenticated GET of valid filename → 200 + correct Content-Type + byte-exact body.
 *  AC2. No auth → 401.
 *  AC3. Nonexistent filename → 404.
 *  AC4. Path traversal `../etc/passwd` → 400.
 *  AC5. Cross-user filename (bob's file fetched as alice) → 404.
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

const NS = 'kubeclaw-e2e-attach';
const RELEASE = 'ke2e-attach';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14104; // unique: no other e2e test uses this port
const HTTP_PORT = 4080; // channel pod's httpPort (default)

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpw';
const HTTP_USERS = `${ALICE_USER}:${ALICE_PASS},${BOB_USER}:${BOB_PASS}`;

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
 * Send a raw HTTP GET request using Node's http.request, which does NOT
 * normalise the path (unlike fetch / URL). Used to deliver literal `..`
 * path-traversal sequences to the server.
 *
 * Returns the HTTP status code.
 */
function rawGet(rawPath: string, authHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: 'localhost',
      port: LOCAL_PORT,
      path: rawPath,
      method: 'GET',
      headers: authHeader ? { Authorization: authHeader } : {},
    };
    const req = http.request(options, (res) => {
      res.resume(); // drain body
      resolve(res.statusCode ?? 0);
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
  'attachment download via HTTP channel (Story 19)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;
    let aliceFilename: string | null = null;
    let bobFilename: string | null = null;

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
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-attach-'));
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

      portForwardProc = await startPortForward();
      await sleep(2000);

      // Upload one image as alice and one as bob to use across ACs
      await postImage(ALICE_USER, ALICE_PASS);
      aliceFilename = await extractFilenameFromConvHistory(ALICE_USER, 15_000);

      await postImage(BOB_USER, BOB_PASS);
      bobFilename = await extractFilenameFromConvHistory(BOB_USER, 15_000);
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

    // ── AC1: Authenticated GET returns 200 + correct Content-Type + byte-exact body

    it(
      'AC1: authenticated GET of uploaded file returns 200 + image/jpeg + byte-exact body',
      async () => {
        expect(
          aliceFilename,
          'Setup must have produced a filename for alice',
        ).not.toBeNull();

        const res = await fetch(
          `http://localhost:${LOCAL_PORT}/attachments/raw/${aliceFilename}`,
          { headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) } },
        );

        expect(res.status, 'GET with valid auth+filename must return 200').toBe(
          200,
        );

        const ct = res.headers.get('content-type') ?? '';
        expect(ct, 'Content-Type must be image/jpeg').toContain('image/jpeg');

        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(MINIMAL_JPEG), 'Body must be byte-exact match').toBe(
          true,
        );
      },
      TEST_TIMEOUT,
    );

    // ── AC2: No auth → 401

    it(
      'AC2: GET without Authorization header returns 401',
      async () => {
        expect(aliceFilename, 'Setup must have produced a filename').not.toBeNull();

        const res = await fetch(
          `http://localhost:${LOCAL_PORT}/attachments/raw/${aliceFilename}`,
        );

        expect(res.status, 'Unauthenticated GET must return 401').toBe(401);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: Nonexistent filename → 404

    it(
      'AC3: GET of nonexistent filename returns 404',
      async () => {
        const res = await fetch(
          `http://localhost:${LOCAL_PORT}/attachments/raw/nonexistent.jpg`,
          { headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) } },
        );

        expect(res.status, 'GET of nonexistent file must return 404').toBe(404);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: Path traversal → 400
    // fetch() normalises URLs before sending, so we use http.request directly
    // to deliver the literal `..` sequence to the server.

    it(
      'AC4: GET with path-traversal filename returns 400',
      async () => {
        const status = await rawGet(
          '/attachments/raw/../etc/passwd',
          basicAuth(ALICE_USER, ALICE_PASS),
        );

        expect(status, 'GET with path-traversal must return 400').toBe(400);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: Cross-user access → 404 (route scopes to authenticated user's folder)

    it(
      'AC5: alice cannot download a file uploaded by bob (returns 404)',
      async () => {
        expect(
          bobFilename,
          'Setup must have produced a filename for bob',
        ).not.toBeNull();

        // Alice is authenticated but requests bob's filename — the route
        // resolves to alice's folder, so the file does not exist there.
        const res = await fetch(
          `http://localhost:${LOCAL_PORT}/attachments/raw/${bobFilename}`,
          { headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) } },
        );

        expect(
          res.status,
          "GET of bob's file as alice must return 404",
        ).toBe(404);
      },
      TEST_TIMEOUT,
    );
  },
);
