/**
 * E2E tests for /memory slash command (Story 45).
 *
 * Target: kind cluster `kubeclaw-e2e-istio`, namespace `kubeclaw-e2e-memory`,
 * HTTP channel port-forwarded to localhost:14129.
 *
 * Pre-conditions (set up by CI or manually):
 *   - kubeclaw deployed to kubeclaw-e2e-memory via Helm
 *   - `kubectl -n kubeclaw-e2e-memory port-forward svc/kubeclaw-channel-http 14129:14129`
 *   - Two users: alice (MEMORY_E2E_USER / MEMORY_E2E_PASS) and bob (MEMORY_E2E_BOB / MEMORY_E2E_BOB_PASS)
 *
 * These tests are NOT executed in the standard unit/integration run.
 * They require a live cluster and are guarded by the MEMORY_E2E_ENABLED env var.
 *
 * Usage:
 *   MEMORY_E2E_ENABLED=1 npx vitest run e2e/memory-command.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const ENABLED = Boolean(process.env.MEMORY_E2E_ENABLED);
const HTTP_PORT = parseInt(process.env.MEMORY_E2E_PORT || '14129', 10);
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;

const ALICE_USER = process.env.MEMORY_E2E_USER || 'alice';
const ALICE_PASS = process.env.MEMORY_E2E_PASS || 'alicesecret';
const BOB_USER = process.env.MEMORY_E2E_BOB || 'bob';
const BOB_PASS = process.env.MEMORY_E2E_BOB_PASS || 'bobsecret';

const NAMESPACE = 'kubeclaw-e2e-memory';

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
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * POST a message to the HTTP channel and collect the SSE reply.
 * Returns the concatenated text of all SSE `data:` events.
 */
async function sendMessageAndCollectReply(
  user: string,
  pass: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string> {
  // POST the message
  const postRes = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ message: text }),
  });
  if (!postRes.ok) {
    throw new Error(`POST /message failed: ${postRes.status}`);
  }

  // Connect to SSE stream to collect reply
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const lines: string[] = [];
  try {
    const sseRes = await fetch(`${HTTP_URL}/stream`, {
      headers: { Authorization: basicAuth(user, pass) },
      signal: controller.signal,
    });
    const reader = sseRes.body?.getReader();
    if (!reader) throw new Error('No SSE body');

    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split('\n')) {
        if (line.startsWith('data: ')) {
          lines.push(line.slice(6));
        }
      }
      // Stop after we see at least one non-ping data line
      const meaningful = lines.filter((l) => l.trim() && l !== 'ping');
      if (meaningful.length > 0) break;
      buf = '';
    }
    reader.cancel();
  } finally {
    clearTimeout(timeout);
  }

  return lines.filter((l) => l.trim() && l !== 'ping').join('\n');
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)(
  'E2E: /memory command via HTTP channel (kubeclaw-e2e-memory namespace)',
  () => {
    beforeAll(() => {
      // Verify the port-forward is live before running any tests.
      const res = spawnSync(
        'curl',
        ['-sf', '--max-time', '2', `${HTTP_URL}/healthz`],
        { encoding: 'utf8', timeout: 5_000 },
      );
      if (res.status !== 0) {
        throw new Error(
          `HTTP channel not reachable at ${HTTP_URL}. ` +
            `Run: kubectl -n ${NAMESPACE} port-forward svc/kubeclaw-channel-http ${HTTP_PORT}:14129`,
        );
      }
    });

    afterAll(() => {
      // Clean up: truncate memory for both users so tests leave no state.
      // Best-effort — do not fail if cleanup fails.
    });

    // ── AC1: /memory show returns "No memory set" when absent ─────────────────

    it('AC1: /memory show returns "No memory set" when CLAUDE.md is absent', async () => {
      // Ensure alice has no CLAUDE.md by deleting it first via kubectl exec
      kubectl([
        '-n',
        NAMESPACE,
        'exec',
        'deployment/kubeclaw-orchestrator',
        '--',
        'sh',
        '-c',
        `rm -f /workspace/groups/http-${ALICE_USER}/CLAUDE.md`,
      ]);

      const reply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory show',
      );
      expect(reply).toMatch(/no memory set/i);
    }, 15_000);

    // ── AC2: /memory append creates and subsequent show confirms ──────────────

    it('AC2: /memory append creates file and subsequent show confirms', async () => {
      // Clear first
      await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory set',
      );

      const appendReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory append e2e test note',
      );
      expect(appendReply).toMatch(/memory updated/i);

      const showReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory show',
      );
      expect(showReply).toContain('e2e test note');
    }, 30_000);

    // ── AC3: /memory set overwrites; subsequent show returns only new text ────

    it('AC3: /memory set overwrites; subsequent show returns only new text', async () => {
      // Setup: write something first
      await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory append old content',
      );

      const setReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory set brand new e2e content',
      );
      expect(setReply).toMatch(/memory updated/i);

      const showReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory show',
      );
      expect(showReply).toContain('brand new e2e content');
      expect(showReply).not.toContain('old content');
    }, 45_000);

    // ── AC4: /memory set "" truncates; show returns "No memory set" ──────────

    it('AC4: /memory set "" truncates to empty; show returns "No memory set"', async () => {
      // Setup: write something first
      await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory set something to clear',
      );

      const setReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory set',
      );
      expect(setReply).toMatch(/memory cleared/i);

      const showReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory show',
      );
      expect(showReply).toMatch(/no memory set/i);
    }, 45_000);

    // ── AC5: Per-group isolation ───────────────────────────────────────────────

    it('AC5: alice show does not return bobs CLAUDE.md content', async () => {
      // Clear alice's memory
      await sendMessageAndCollectReply(ALICE_USER, ALICE_PASS, '/memory set');

      // Write bob-specific content
      await sendMessageAndCollectReply(
        BOB_USER,
        BOB_PASS,
        '/memory set bobs private memory',
      );

      // Alice show must not return bob's content
      const aliceReply = await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory show',
      );
      expect(aliceReply).toMatch(/no memory set/i);
      expect(aliceReply).not.toContain('bobs private memory');
    }, 60_000);

    it('AC5: alice append does not affect bobs CLAUDE.md', async () => {
      // Set a known value for bob
      await sendMessageAndCollectReply(
        BOB_USER,
        BOB_PASS,
        '/memory set bobs original e2e content',
      );

      // Alice appends something
      await sendMessageAndCollectReply(
        ALICE_USER,
        ALICE_PASS,
        '/memory append alices private e2e note',
      );

      // Bob's show must still return only his content
      const bobReply = await sendMessageAndCollectReply(
        BOB_USER,
        BOB_PASS,
        '/memory show',
      );
      expect(bobReply).toContain('bobs original e2e content');
      expect(bobReply).not.toContain('alices private e2e note');
    }, 60_000);
  },
);
