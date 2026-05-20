/**
 * HTTP Channel — Integration Tests: Per-user Attachment Quota
 *
 * Exercises Acceptance Criteria 1–4 from Story 48 against a real HTTP server
 * (no mocked node:http) binding localhost on an ephemeral port.  A real tmpdir
 * acts as GROUPS_DIR so getAttachmentUsage() reads actual files from disk.
 *
 * AC1: 4th upload from alice → 413 "Attachment limit reached (max 3)"
 * AC2: Upload that would push bytes over limit → 413 "Attachment storage limit reached"
 * AC3: bob can still upload when alice's quota is full (per-user isolation)
 * AC4: After deleting alice's file, next upload succeeds (live directory re-read)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Module mocks (must be hoisted above imports that trigger side effects) ───

// Stub registry so registering the channel at module-load time doesn't fail.
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../db.js', () => ({ appendConversationMessage: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// We will patch GROUPS_DIR after creating tmpdir (see beforeAll).
// We set it to a placeholder here; the real value is injected below.
let tmpGroupsDir = '';

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  get GROUPS_DIR() { return tmpGroupsDir; },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { HttpChannel, type HttpChannelOpts } from './http.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Minimal JPEG magic bytes that pass detectMediaType(). */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/**
 * Build a multipart/form-data body with a single "image" part.
 * `sizeBytes` controls total image buffer size; defaults to JPEG_MAGIC.length.
 */
function buildImageFormData(sizeBytes: number = JPEG_MAGIC.length): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `integ-${Date.now()}`;
  const imageData = Buffer.concat([
    JPEG_MAGIC,
    Buffer.alloc(Math.max(0, sizeBytes - JPEG_MAGIC.length)),
  ]);
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    imageData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('HttpChannel — attachment quota integration', () => {
  const PORT = 14132; // matches Story 48 spec port
  const ALICE = 'alice';
  const ALICE_PASS = 'alicepass';
  const ALICE_JID = `http:${ALICE}`;
  const BOB = 'bob';
  const BOB_PASS = 'bobpass';
  const BOB_JID = `http:${BOB}`;

  let channel: HttpChannel | null = null;
  let aliceAttachDir: string;
  let bobAttachDir: string;

  function aliceDir() { return aliceAttachDir; }
  function bobDir() { return bobAttachDir; }

  function clearDir(dir: string): void {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  }

  function writeFiles(dir: string, count: number, sizeEach: number = 100): string[] {
    const paths: string[] = [];
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const fp = path.join(dir, `file-${i}-${Date.now()}.jpg`);
      fs.writeFileSync(fp, Buffer.alloc(sizeEach));
      paths.push(fp);
    }
    return paths;
  }

  beforeAll(async () => {
    // Create isolated tmpdir used as GROUPS_DIR for this suite.
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-http-integ-'));

    aliceAttachDir = path.join(tmpGroupsDir, ALICE_JID, 'attachments', 'raw');
    bobAttachDir   = path.join(tmpGroupsDir, BOB_JID,   'attachments', 'raw');
    fs.mkdirSync(aliceAttachDir, { recursive: true });
    fs.mkdirSync(bobAttachDir,   { recursive: true });

    const opts: HttpChannelOpts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({
        [ALICE_JID]: { name: ALICE, folder: ALICE_JID, trigger: '', added_at: '' },
        [BOB_JID]:   { name: BOB,   folder: BOB_JID,   trigger: '', added_at: '' },
      }),
      // Count limit: 3 per user; byte limit: 50 KB per user
      maxAttachmentCount: 3,
      maxAttachmentBytes: 50_000,
    };

    channel = new HttpChannel(
      {
        port: PORT,
        users: { [ALICE]: ALICE_PASS, [BOB]: BOB_PASS },
        // Disable Story 34 rate limit so the quota check (Story 48) is what
        // actually gates the upload responses in this test.
        perUserMessagesPerMinute: 0,
      },
      opts,
    );
    await channel.connect();
  }, 15_000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    try { fs.rmSync(tmpGroupsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10_000);

  // Clean each user's directory before each test so tests are independent.
  beforeEach(() => { clearDir(aliceDir()); clearDir(bobDir()); });

  async function post(auth: string, formData: ReturnType<typeof buildImageFormData>) {
    return fetch(`http://localhost:${PORT}/message`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': formData.contentType },
      body: formData.body,
    });
  }

  // ── AC1: count limit ───────────────────────────────────────────────────────

  it('AC1: 4th upload returns 413 with count body; no file written', async () => {
    // Pre-populate 3 files — alice is at the limit
    writeFiles(aliceDir(), 3);

    const { body, contentType } = buildImageFormData();
    const res = await post(basicAuth(ALICE, ALICE_PASS), { body, contentType });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Attachment limit reached (max 3)');
    // Still only 3 files on disk
    expect(fs.readdirSync(aliceDir()).length).toBe(3);
  }, 10_000);

  // ── AC2: byte limit ────────────────────────────────────────────────────────

  it('AC2: upload that would exceed byte quota returns 413 with size body; no file written', async () => {
    // 46 KB already stored; limit is 50 KB. New file is ~10 KB → 56 KB total.
    writeFiles(aliceDir(), 1, 46_080);

    const { body, contentType } = buildImageFormData(10 * 1024);
    const res = await post(basicAuth(ALICE, ALICE_PASS), { body, contentType });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Attachment storage limit reached');
    // Still only 1 file on disk
    expect(fs.readdirSync(aliceDir()).length).toBe(1);
  }, 10_000);

  // ── AC3: per-user isolation ────────────────────────────────────────────────

  it('AC3: bob can upload when alice is at the count limit', async () => {
    // Fill alice to the limit
    writeFiles(aliceDir(), 3);
    // Bob has nothing

    const fd = buildImageFormData();
    const res = await post(basicAuth(BOB, BOB_PASS), fd);
    expect(res.status).toBe(200);
    // Bob's directory received the new file
    expect(fs.readdirSync(bobDir()).length).toBe(1);
  }, 10_000);

  // ── AC4: quota re-reads live directory ────────────────────────────────────

  it('AC4: after deleting one of alice\'s files she can upload again', async () => {
    // Fill alice to 3 (at the limit)
    const filePaths = writeFiles(aliceDir(), 3);

    // Confirm 413
    const fd1 = buildImageFormData();
    const r1 = await post(basicAuth(ALICE, ALICE_PASS), fd1);
    expect(r1.status).toBe(413);

    // Simulate DELETE /attachments/raw/<filename>
    fs.unlinkSync(filePaths[0]);
    expect(fs.readdirSync(aliceDir()).length).toBe(2);

    // Now she is below the limit — upload must succeed
    const fd2 = buildImageFormData();
    const r2 = await post(basicAuth(ALICE, ALICE_PASS), fd2);
    expect(r2.status).toBe(200);
    expect(fs.readdirSync(aliceDir()).length).toBe(3);
  }, 10_000);

  // ── Sanity: upload succeeds when no quota configured ──────────────────────

  it('upload succeeds when no files exist yet (well below limit)', async () => {
    const fd = buildImageFormData();
    const res = await post(basicAuth(ALICE, ALICE_PASS), fd);
    expect(res.status).toBe(200);
    expect(fs.readdirSync(aliceDir()).length).toBe(1);
  }, 10_000);
});
