/**
 * E2E: Per-user Attachment Quota (Story 48)
 *
 * Target cluster : minikube (kind)
 * Namespace      : kubeclaw-e2e-attach-quota
 * Channel port   : 14132 (port-forwarded from svc/kubeclaw-channel-http)
 *
 * Helm values used for this suite (set via --set flags or a dedicated
 * values-attach-quota.yaml):
 *
 *   channels:
 *     http:
 *       enabled: true
 *       httpPort: 14132
 *       envVars:
 *         - name: HTTP_CHANNEL_USERS
 *           key: users            # "alice:alicepass,bob:bobpass"
 *   httpChannel:
 *     attachments:
 *       maxCountPerUser: 3        # → HTTP_CHANNEL_MAX_ATTACHMENT_COUNT_PER_USER=3
 *       maxSizeBytesPerUser: 50000 # → HTTP_CHANNEL_MAX_ATTACHMENT_BYTES_PER_USER=50000
 *
 * Prerequisites (verified in beforeAll):
 *   - kubectl context points at minikube
 *   - namespace kubeclaw-e2e-attach-quota exists and helm release is deployed
 *   - port-forward from svc/kubeclaw-channel-http :14132 is active
 *
 * NOTE: This file is intentionally NOT executed in CI because it requires a
 * live kind cluster.  Run manually with:
 *   npx vitest run --config vitest.minikube-live.config.ts e2e/attachment-quota.test.ts
 *
 * The test is marked `describe.skip` so it does not break the e2e suite when
 * executed without the cluster prerequisite.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';

// ── Configuration ────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-attach-quota';
const HTTP_PORT = 14132;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER   = 'bob';
const BOB_PASS   = 'bobpass';

const MAX_COUNT = 3;
const MAX_BYTES = 50_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Minimal JPEG magic bytes that pass the server-side media-type detection. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/**
 * Build a multipart/form-data body with a single "image" part.
 * `sizeBytes` controls the total image payload size (padded with zeros
 * after the JPEG magic bytes).
 */
function buildImageFormData(sizeBytes: number = JPEG_MAGIC.length): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `e2e-boundary-${Date.now()}`;
  const imageData = Buffer.concat([
    JPEG_MAGIC,
    Buffer.alloc(Math.max(0, sizeBytes - JPEG_MAGIC.length)),
  ]);
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="test.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`,
    ),
    imageData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return {
    body:        Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** POST a multipart image to /message. */
async function postImage(
  user: string,
  pass: string,
  sizeBytes?: number,
): Promise<Response> {
  const { body, contentType } = buildImageFormData(sizeBytes);
  return fetch(`${HTTP_URL}/message`, {
    method:  'POST',
    headers: { Authorization: basicAuth(user, pass), 'Content-Type': contentType },
    body,
  });
}

/**
 * Delete all attachments for a user by exec-ing into the channel pod and
 * removing files from the PVC-backed attachments directory.
 * JID format: http:<username>
 */
function deleteAllAttachments(username: string): void {
  const attachPath = `/app/groups/http:${username}/attachments/raw`;
  const podResult = spawnSync(
    'kubectl',
    ['get', 'pods', '-n', NAMESPACE, '-l', 'kubeclaw/channel=http',
     '-o', 'jsonpath={.items[0].metadata.name}'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
  const podName = podResult.stdout.trim();
  if (!podName) throw new Error('Could not find channel pod');

  spawnSync(
    'kubectl',
    ['exec', '-n', NAMESPACE, podName, '--', 'sh', '-c',
     `find ${attachPath} -type f -delete 2>/dev/null || true`],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
}

/** Count attachment files on the PVC for a given user. */
function countAttachments(username: string): number {
  const attachPath = `/app/groups/http:${username}/attachments/raw`;
  const podResult = spawnSync(
    'kubectl',
    ['get', 'pods', '-n', NAMESPACE, '-l', 'kubeclaw/channel=http',
     '-o', 'jsonpath={.items[0].metadata.name}'],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
  const podName = podResult.stdout.trim();
  if (!podName) return -1;

  const countResult = spawnSync(
    'kubectl',
    ['exec', '-n', NAMESPACE, podName, '--', 'sh', '-c',
     `find ${attachPath} -type f 2>/dev/null | wc -l`],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
  return parseInt(countResult.stdout.trim(), 10) || 0;
}

// ── Suite ────────────────────────────────────────────────────────────────────

// Wrap in describe.skip so `npx vitest run --config vitest.e2e.config.ts` does
// not fail when the cluster is unavailable.  Remove the .skip to run live.
describe.skip('E2E: HTTP channel per-user attachment quota', () => {
  beforeAll(async () => {
    // Verify the HTTP channel is reachable before running any tests.
    let reachable = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
          signal: AbortSignal.timeout(3_000),
        });
        if (res.status < 500) { reachable = true; break; }
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (!reachable) {
      throw new Error(
        `HTTP channel not reachable at ${HTTP_URL}. ` +
        `Ensure the port-forward is active:\n` +
        `  kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${HTTP_PORT}:80`,
      );
    }
  }, 30_000);

  // Clean attachment directories before each test.
  beforeEach(() => {
    deleteAllAttachments(ALICE_USER);
    deleteAllAttachments(BOB_USER);
  });

  afterAll(() => {
    deleteAllAttachments(ALICE_USER);
    deleteAllAttachments(BOB_USER);
  });

  // ── AC1: count limit ─────────────────────────────────────────────────────

  it('AC1: 4th upload from alice returns 413 with count message; no file written', async () => {
    // Upload 3 images — all should succeed
    for (let i = 0; i < MAX_COUNT; i++) {
      const res = await postImage(ALICE_USER, ALICE_PASS);
      expect(res.status).toBe(200);
    }

    // 4th upload must be rejected
    const r4 = await postImage(ALICE_USER, ALICE_PASS);
    expect(r4.status).toBe(413);
    expect(await r4.text()).toBe(`Attachment limit reached (max ${MAX_COUNT})`);

    // Verify the count on the PVC has not grown beyond the limit
    expect(countAttachments(ALICE_USER)).toBe(MAX_COUNT);
  }, 60_000);

  // ── AC2: byte limit ──────────────────────────────────────────────────────

  it('AC2: upload that would exceed cumulative byte quota returns 413', async () => {
    // Upload one file that consumes 46 KB (stays under the 50 KB limit)
    const r1 = await postImage(ALICE_USER, ALICE_PASS, 46_080);
    expect(r1.status).toBe(200);

    // Upload a ~10 KB file → 46 080 + 10 240 = 56 320 > 50 000
    const r2 = await postImage(ALICE_USER, ALICE_PASS, 10 * 1024);
    expect(r2.status).toBe(413);
    expect(await r2.text()).toBe('Attachment storage limit reached');

    // Only 1 file should be on disk
    expect(countAttachments(ALICE_USER)).toBe(1);
  }, 60_000);

  // ── AC3: per-user isolation ──────────────────────────────────────────────

  it('AC3: bob can upload normally when alice\'s count quota is full', async () => {
    // Fill alice to the limit
    for (let i = 0; i < MAX_COUNT; i++) {
      await postImage(ALICE_USER, ALICE_PASS);
    }
    const aliceFull = await postImage(ALICE_USER, ALICE_PASS);
    expect(aliceFull.status).toBe(413);

    // Bob has an empty quota — upload must succeed
    const bobRes = await postImage(BOB_USER, BOB_PASS);
    expect(bobRes.status).toBe(200);
    expect(countAttachments(BOB_USER)).toBe(1);
  }, 60_000);

  // ── AC4: live directory re-read after DELETE ──────────────────────────────

  it('AC4: after DELETE removes one of alice\'s files, a subsequent upload succeeds', async () => {
    // Fill alice to the limit
    for (let i = 0; i < MAX_COUNT; i++) {
      await postImage(ALICE_USER, ALICE_PASS);
    }

    // Confirm limit reached
    const overLimit = await postImage(ALICE_USER, ALICE_PASS);
    expect(overLimit.status).toBe(413);

    // Simulate the operator calling DELETE /attachments/raw/<filename>.
    // We do this via kubectl exec to match what the real DELETE endpoint does.
    const podResult = spawnSync(
      'kubectl',
      ['get', 'pods', '-n', NAMESPACE, '-l', 'kubeclaw/channel=http',
       '-o', 'jsonpath={.items[0].metadata.name}'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );
    const podName = podResult.stdout.trim();
    const attachPath = `/app/groups/http:${ALICE_USER}/attachments/raw`;
    // Remove just the first file found
    spawnSync(
      'kubectl',
      ['exec', '-n', NAMESPACE, podName, '--', 'sh', '-c',
       `f=$(find ${attachPath} -type f | head -1) && rm -f "$f"`],
      { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    );

    expect(countAttachments(ALICE_USER)).toBe(MAX_COUNT - 1);

    // Now alice should be able to upload again
    const afterDelete = await postImage(ALICE_USER, ALICE_PASS);
    expect(afterDelete.status).toBe(200);
    expect(countAttachments(ALICE_USER)).toBe(MAX_COUNT);
  }, 60_000);
});
