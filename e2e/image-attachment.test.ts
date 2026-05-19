/**
 * e2e tests for Story 15: Image attachment via HTTP channel.
 *
 * Acceptance criteria:
 *  AC1. Valid JPEG multipart POST → 200 + file written to disk inside the channel pod.
 *  AC2. Marker `[ImageAttachment: ...]` appears in conversation_history (LLM-independent).
 *  AC3. With a text caption, the marker includes `caption="..."`.
 *  AC4. Non-image bytes (e.g. plain text masquerading as image) → 415.
 *  AC5. Missing `image` field in multipart → 400.
 *
 * All assertions are LLM-independent (filesystem / DB checks via kubectl exec).
 *
 * Prerequisites:
 *  - kind cluster kubeclaw-e2e-istio (context: kind-kubeclaw-e2e-istio)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup racing this install)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const NS = 'kubeclaw-e2e-image';
const RELEASE = 'ke2e-image';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14099; // unique: no other e2e test uses this port
const HTTP_PORT = 4080; // channel pod's httpPort (default)

// Single user for this suite
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const HTTP_USERS = `${ALICE_USER}:${ALICE_PASS}`;

// DB path inside channel pod (channel type = "http")
const DB_PATH = '/app/store/messages-http.db';

// Groups directory inside channel pod — attachment files are written here
// GROUPS_DIR = process.cwd() + '/groups' = /app/groups
const ATTACH_BASE = '/app/groups';

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

// ── Minimal valid JPEG bytes ─────────────────────────────────────────────────
// A JPEG starts with the SOI marker (FF D8) followed by any FF-prefixed segment.
// FF D8 FF E0 is the JFIF APP0 marker — recognized by the server's magic check.
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, // SOI + APP0 header length
  0x4a, 0x46, 0x49, 0x46, 0x00,       // "JFIF\0" identifier
  0x01, 0x01,                          // version 1.1
  0x00,                                // aspect-ratio units
  0x00, 0x01, 0x00, 0x01,             // X/Y density
  0x00, 0x00,                          // thumbnail dimensions
  0xff, 0xd9,                          // EOI
]);

// ── Non-image bytes ───────────────────────────────────────────────────────────
// Plain ASCII text — no magic bytes recognised by detectMediaType().
const NON_IMAGE_BYTES = Buffer.from('this is definitely not an image file\n');

let portForwardProc: ChildProcess | null = null;

// ── Skip guard ───────────────────────────────────────────────────────────────

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
 * Wait until the port-forward is accepting connections (any HTTP response).
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
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(
    `Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`,
  );
}

/**
 * Kill any stale process on LOCAL_PORT and start a fresh port-forward to the
 * channel pod.
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

/**
 * Build a multipart/form-data body manually.
 *
 * @param boundary - the multipart boundary string (without leading --)
 * @param parts    - array of { name, filename?, contentType?, data } descriptors
 * @returns { body: Buffer, contentType: string }
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
 * POST a multipart image to /message. Returns the HTTP response.
 */
async function postImage(
  user: string,
  pass: string,
  imageData: Buffer,
  caption?: string,
): Promise<Response> {
  const boundary = `ke2e-boundary-${Date.now()}`;
  const parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer;
  }> = [
    {
      name: 'image',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      data: imageData,
    },
  ];

  if (caption !== undefined) {
    parts.push({ name: 'text', data: Buffer.from(caption, 'utf8') });
  }

  const { body, contentType } = buildMultipart(boundary, parts);

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
 * POST a multipart body that has no `image` field — only a `text` field.
 */
async function postMultipartTextOnly(
  user: string,
  pass: string,
): Promise<Response> {
  const boundary = `ke2e-boundary-${Date.now()}`;
  const { body, contentType } = buildMultipart(boundary, [
    { name: 'text', data: Buffer.from('hello from text only', 'utf8') },
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
 * Poll conversation_history inside the channel pod for a row whose content
 * includes the given fragment. Uses a Node.js sql.js snippet to query the DB.
 *
 * Returns the matched content string or null if not found within the timeout.
 */
async function waitForConvHistoryContent(
  fragment: string,
  jid: string,
  timeoutMs = 8_000,
): Promise<string | null> {
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
    if (row[0] && String(row[0]).includes('${fragment}')) {
      console.log(String(row[0]));
      return;
    }
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

/**
 * Check whether a file matching a glob pattern exists in the channel pod.
 * Uses `ls` inside the pod; returns the filename or null.
 */
function findFileInPod(dir: string, pattern: string): string | null {
  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );
  const result = kube(
    `exec ${channelPodName} -- sh -c "ls ${dir}/${pattern} 2>/dev/null | head -1"`,
    { allowFail: true },
  ).trim();
  return result || null;
}

/**
 * Poll until a file matching the pattern exists in the channel pod or timeout.
 */
async function waitForFile(
  dir: string,
  pattern: string,
  timeoutMs = 8_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = findFileInPod(dir, pattern);
    if (f) return f;
    await sleep(500);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  'image attachment via HTTP channel (Story 15)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    // JID for alice in the HTTP channel: "http:alice"
    // Group folder derived by jidToFolder("http", "http:alice") →
    //   prefix "http", sanitize "http:alice" → "http-alice" → "http-http-alice"
    const ALICE_JID = 'http:alice';
    const ALICE_ATTACH_DIR = `${ATTACH_BASE}/${ALICE_JID}/attachments/raw`;

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
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-image-'));
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

    // ── AC1: Valid JPEG → 200 + file on disk ─────────────────────────────────

    it(
      'AC1: valid JPEG multipart POST returns 200 and writes file to disk',
      async () => {
        const res = await postImage(ALICE_USER, ALICE_PASS, MINIMAL_JPEG);
        expect(res.status, 'POST with valid JPEG must return 200').toBe(200);

        // Poll until the file appears in the attachments directory
        const file = await waitForFile(ALICE_ATTACH_DIR, 'img-*.jpg', 8_000);
        expect(
          file,
          `Attachment file must appear in ${ALICE_ATTACH_DIR} within 8 s`,
        ).not.toBeNull();
      },
      TEST_TIMEOUT,
    );

    // ── AC2: SSE / conversation_history shows [ImageAttachment: ...] marker ──
    // "LLM-independent" — verified by querying conversation_history directly.

    it(
      'AC2: [ImageAttachment: ...] marker appears in conversation_history after upload',
      async () => {
        const res = await postImage(ALICE_USER, ALICE_PASS, MINIMAL_JPEG);
        expect(res.status, 'POST with valid JPEG must return 200').toBe(200);

        // appendConversationMessage is called synchronously inside the request
        // handler, so the row should be visible almost immediately.
        const content = await waitForConvHistoryContent(
          '[ImageAttachment:',
          ALICE_JID,
          8_000,
        );
        expect(
          content,
          'conversation_history must contain a row with [ImageAttachment: ...] marker',
        ).not.toBeNull();
        expect(content, 'Marker must contain [ImageAttachment:').toContain(
          '[ImageAttachment:',
        );
        expect(
          content,
          'Marker must reference attachments/raw/ path',
        ).toContain('attachments/raw/');
      },
      TEST_TIMEOUT,
    );

    // ── AC3: With caption, marker includes caption="..." ─────────────────────

    it(
      'AC3: caption text is embedded in the [ImageAttachment: ...] marker',
      async () => {
        const caption = `story15-caption-${Date.now()}`;
        const res = await postImage(ALICE_USER, ALICE_PASS, MINIMAL_JPEG, caption);
        expect(res.status, 'POST with caption must return 200').toBe(200);

        const content = await waitForConvHistoryContent(caption, ALICE_JID, 8_000);
        expect(
          content,
          `conversation_history must contain the caption text "${caption}"`,
        ).not.toBeNull();
        expect(
          content,
          'Marker must include caption="..." attribute',
        ).toContain(`caption="${caption}"`);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: Non-image bytes → 415 ────────────────────────────────────────────

    it(
      'AC4: non-image bytes in the image field return 415',
      async () => {
        const boundary = `ke2e-boundary-${Date.now()}`;
        const { body, contentType } = buildMultipart(boundary, [
          {
            name: 'image',
            filename: 'fake.jpg',
            contentType: 'image/jpeg',
            data: NON_IMAGE_BYTES,
          },
        ]);

        const res = await fetch(`http://localhost:${LOCAL_PORT}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            Authorization: basicAuth(ALICE_USER, ALICE_PASS),
          },
          body,
        });

        expect(
          res.status,
          'Non-image bytes must produce 415 Unsupported Media Type',
        ).toBe(415);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: Missing image part → 400 ────────────────────────────────────────

    it(
      'AC5: multipart POST without image field returns 400',
      async () => {
        const res = await postMultipartTextOnly(ALICE_USER, ALICE_PASS);
        expect(
          res.status,
          'Multipart body without image field must return 400',
        ).toBe(400);
      },
      TEST_TIMEOUT,
    );
  },
);
