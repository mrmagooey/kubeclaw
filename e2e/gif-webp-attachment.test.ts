/**
 * E2E tests — GIF and WebP attachment round-trip (Story 42).
 *
 * These tests require a running kind/minikube cluster with kubeclaw deployed
 * and the HTTP channel port-forwarded (see e2e/minikube-live-setup.ts).
 *
 * Topology:
 *   - HTTP channel exposed at http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}
 *   - Credentials: KUBECLAW_LIVE_USER / KUBECLAW_LIVE_PASS (alice / livepass)
 *
 * What each test does:
 *   1. POST multipart/form-data with a GIF/WebP payload to /message (200 expected).
 *   2. Probe the channel pod's filesystem to confirm a file with the correct
 *      extension landed in /app/groups/http:<user>/attachments/raw/.
 *   3. GET /attachments/raw/<filename> via the port-forward and confirm:
 *        - HTTP 200
 *        - Content-Type matches the uploaded format
 *        - Response body is byte-for-byte identical to the uploaded payload
 *   4. (AC5) POST a RIFF WAV file — 52 49 46 46 … 57 41 56 45 — and confirm
 *        HTTP 415 is returned (the tightened WebP check must not accept it).
 *
 * These tests are minikube-live so they are excluded from the default e2e run
 * (see e2e/vitest.e2e.config.ts exclude list for minikube-live*.test.ts).
 * Run them with: KUBECLAW_LIVE=1 npm run test:e2e -- gif-webp-attachment
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';

// Self-contained namespace + port-forward — no longer piggybacks on the
// minikube-live suite. Credentials kept identical to the live suite's
// `alice`/`livepass` for compatibility with existing assertions and
// log-greps.
const NAMESPACE = 'kubeclaw-e2e-gifwebp';
const HTTP_PORT = 14140;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;
const KUBECLAW_LIVE_USER = 'alice';
const KUBECLAW_LIVE_PASS = 'livepass';

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function buildMultipart(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header));
    chunks.push(part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('GIF and WebP attachment round-trip (Story 42)', () => {
  let cluster: ClusterHandle | null = null;
  let provisioned = false;
  let channelPodName = '';

  beforeAll(async () => {
    cluster = await setupTestCluster({
      namespace: NAMESPACE,
      httpChannel: {
        localPort: HTTP_PORT,
        users: `${KUBECLAW_LIVE_USER}:${KUBECLAW_LIVE_PASS}`,
      },
      quiet: true,
    });
    provisioned = true;

    // Resolve channel pod name once.
    const podsR = kubectl([
      'get', 'pods', '-n', NAMESPACE,
      '-l', 'app=kubeclaw-channel-http',
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    if (podsR.ok) channelPodName = podsR.stdout.trim();

    // Prime: send a plain text message so alice's group is registered before
    // the image uploads arrive.  The multipart handler checks registeredGroups()
    // and silently drops uploads from groups that haven't been auto-registered yet.
    const primeRes = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'gif-webp-e2e-primer' }),
    });
    if (!primeRes.ok) {
      console.warn(`Primer POST failed with status ${primeRes.status}`);
    }
    // Give the channel a moment to register the group.
    await new Promise((r) => setTimeout(r, 2000));
  }, 600_000);

  afterAll(async () => {
    if (cluster) await cluster.teardown();
  }, 120_000);

  // ── AC1 — GIF round-trip ──────────────────────────────────────────────────

  it(
    'AC1: POST GIF → 200, file appears on PVC, GET returns image/gif with identical bytes',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Minimal GIF89a payload: 6-byte magic + minimal header continuation.
      const gifBytes = Buffer.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
        0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // width=1, height=1, flags
        0xff, 0xff, 0xff, 0x00, 0x00, 0x00, // color table (white + black)
        0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
        0x02, 0x02, 0x4c, 0x01, 0x00, // image data
        0x3b, // GIF trailer
      ]);

      // (a) POST
      const boundary = 'gif-e2e-boundary';
      const body = buildMultipart(boundary, [
        {
          name: 'image',
          filename: 'test-e2e.gif',
          contentType: 'image/gif',
          data: gifBytes,
        },
        { name: 'text', data: Buffer.from('gif-e2e-caption') },
      ]);

      const postRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      expect(
        postRes.status,
        `POST /message expected 200, got ${postRes.status}`,
      ).toBe(200);

      // Give the channel pod time to write the file.
      await new Promise((r) => setTimeout(r, 2000));

      // (b) Verify file on PVC via kubectl exec.
      const dir = `/app/groups/http:${KUBECLAW_LIVE_USER}/attachments/raw`;
      const lsScript = `
        const fs = require('node:fs');
        if (!fs.existsSync('${dir}')) { console.error('dir-missing'); process.exit(1); }
        const files = fs.readdirSync('${dir}').filter((f) => f.endsWith('.gif'));
        if (!files.length) { console.error('no-gif-files'); process.exit(1); }
        // Read the last written GIF and print it as hex + the filename.
        const latest = files.sort().at(-1);
        const data = fs.readFileSync('${dir}/' + latest);
        console.log('gif-ok:' + latest + ':' + data.toString('hex'));
      `;
      const lsExec = kubectl(
        ['exec', '-n', NAMESPACE, channelPodName, '-c', 'channel', '--', 'node', '-e', lsScript],
        { timeout: 15_000 },
      );
      expect(
        lsExec.ok,
        `PVC probe failed:\nstdout: ${lsExec.stdout}\nstderr: ${lsExec.stderr}`,
      ).toBe(true);
      expect(lsExec.stdout).toMatch(/^gif-ok:/m);

      // Extract the filename from the probe output so we can do a GET.
      const match = lsExec.stdout.match(/^gif-ok:([^:]+):/m);
      expect(match, 'Could not parse filename from probe output').toBeTruthy();
      const filename = match![1];

      // (c) GET /attachments/raw/<filename> and verify Content-Type + bytes.
      const getRes = await fetch(`${HTTP_URL}/attachments/raw/${filename}`, {
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        },
      });
      expect(
        getRes.status,
        `GET /attachments/raw/${filename} expected 200, got ${getRes.status}`,
      ).toBe(200);
      expect(getRes.headers.get('content-type')).toBe('image/gif');
      const respBody = Buffer.from(await getRes.arrayBuffer());
      expect(respBody).toEqual(gifBytes);
    },
    60_000,
  );

  // ── AC2 — WebP round-trip ─────────────────────────────────────────────────

  it(
    'AC2: POST WebP → 200, file appears on PVC, GET returns image/webp with identical bytes',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Minimal RIFF????WEBP payload.
      const webpBytes = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x04, 0x00, 0x00, 0x00, // file size (8 bytes follow)
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);

      const boundary = 'webp-e2e-boundary';
      const body = buildMultipart(boundary, [
        {
          name: 'image',
          filename: 'test-e2e.webp',
          contentType: 'image/webp',
          data: webpBytes,
        },
      ]);

      const postRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      expect(
        postRes.status,
        `POST /message expected 200, got ${postRes.status}`,
      ).toBe(200);

      await new Promise((r) => setTimeout(r, 2000));

      // Verify file on PVC.
      const dir = `/app/groups/http:${KUBECLAW_LIVE_USER}/attachments/raw`;
      const lsScript = `
        const fs = require('node:fs');
        if (!fs.existsSync('${dir}')) { console.error('dir-missing'); process.exit(1); }
        const files = fs.readdirSync('${dir}').filter((f) => f.endsWith('.webp'));
        if (!files.length) { console.error('no-webp-files'); process.exit(1); }
        const latest = files.sort().at(-1);
        const data = fs.readFileSync('${dir}/' + latest);
        console.log('webp-ok:' + latest + ':' + data.toString('hex'));
      `;
      const lsExec = kubectl(
        ['exec', '-n', NAMESPACE, channelPodName, '-c', 'channel', '--', 'node', '-e', lsScript],
        { timeout: 15_000 },
      );
      expect(
        lsExec.ok,
        `PVC probe failed:\nstdout: ${lsExec.stdout}\nstderr: ${lsExec.stderr}`,
      ).toBe(true);
      expect(lsExec.stdout).toMatch(/^webp-ok:/m);

      const match = lsExec.stdout.match(/^webp-ok:([^:]+):/m);
      expect(match, 'Could not parse filename from probe output').toBeTruthy();
      const filename = match![1];

      // GET and verify.
      const getRes = await fetch(`${HTTP_URL}/attachments/raw/${filename}`, {
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        },
      });
      expect(
        getRes.status,
        `GET /attachments/raw/${filename} expected 200, got ${getRes.status}`,
      ).toBe(200);
      expect(getRes.headers.get('content-type')).toBe('image/webp');
      const respBody = Buffer.from(await getRes.arrayBuffer());
      expect(respBody).toEqual(webpBytes);
    },
    60_000,
  );

  // ── AC5 — RIFF-but-not-WebP rejected ──────────────────────────────────────

  it(
    'AC5: POST a RIFF WAV file (bytes 8-11 = WAVE, not WEBP) returns 415',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // WAV: RIFF header with "WAVE" fourCC at [8-11].
      const wavBytes = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x24, 0x00, 0x00, 0x00, // file size
        0x57, 0x41, 0x56, 0x45, // WAVE  ← not WEBP
        0x66, 0x6d, 0x74, 0x20, // "fmt " chunk
      ]);

      const boundary = 'wav-e2e-boundary';
      const body = buildMultipart(boundary, [
        {
          name: 'image',
          filename: 'audio.wav',
          data: wavBytes,
        },
      ]);

      const postRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      expect(
        postRes.status,
        `POST of WAV (RIFF-not-WebP) expected 415, got ${postRes.status}`,
      ).toBe(415);
    },
    30_000,
  );
});
