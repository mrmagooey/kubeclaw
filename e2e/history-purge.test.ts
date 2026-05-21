/**
 * Story 78 End-to-End Tests
 *
 * Tests DELETE /history?before=<ISO-8601> for time-bounded bulk purge.
 * Namespace: kubeclaw-e2e-history-purge. Port: 14161.
 *
 * Exercises:
 *   AC1 — authenticated DELETE /history?before=<ISO> deletes older rows, returns { deleted: N }
 *   AC2 — no ?before param → full-clear (Story 26 behavior preserved)
 *   AC3 — unparseable before → 400 with ISO-8601 error message
 *   AC4 — future before → accepted (deletes everything up to now)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import {
  _initTestDatabase,
  db,
  appendConversationMessage,
  getConversationHistory,
  clearConversationHistory,
} from '../src/db.js';

const HTTP_PORT = 14161;
const TEST_USER = 'alice';
const TEST_PASS = 'purgepw';
const TEST_FOLDER = 'alice-purge';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Insert a conversation_history row with an explicit created_at timestamp. */
function insertHistoryAt(folder: string, role: 'user' | 'assistant', content: string, createdAt: Date): void {
  const id = `${folder}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.run(
    `INSERT INTO conversation_history (id, group_folder, session_key, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, folder, folder, role, content, createdAt.toISOString()],
  );
}

describe('Story 78 — DELETE /history?before= (history-purge e2e)', () => {
  let channel: HttpChannel | null = null;

  function createChannel(): HttpChannel {
    const opts: HttpChannelOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [TEST_JID]: {
          name: 'Alice Purge',
          folder: TEST_FOLDER,
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };
    return new HttpChannel(
      { port: HTTP_PORT, users: { [TEST_USER]: TEST_PASS } },
      opts,
    );
  }

  beforeAll(async () => {
    await _initTestDatabase();
    channel = createChannel();
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(() => {
    // Clean state before each test
    clearConversationHistory(TEST_FOLDER);
  });

  // ── AC1 — time-bounded delete ──────────────────────────────────────────────

  it('AC1: deletes rows older than before, returns { deleted: N }', async () => {
    const now = Date.now();
    // Insert rows: T-100s, T-50s (old), T-10s (recent)
    insertHistoryAt(TEST_FOLDER, 'user', 'oldest message', new Date(now - 100_000));
    insertHistoryAt(TEST_FOLDER, 'assistant', 'middle message', new Date(now - 50_000));
    insertHistoryAt(TEST_FOLDER, 'user', 'recent message', new Date(now - 10_000));

    const cutoff = new Date(now - 30_000).toISOString();
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history?before=${encodeURIComponent(cutoff)}`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: number };
    expect(body.deleted).toBe(2);

    // The recent message must still be present
    const remaining = getConversationHistory(TEST_FOLDER, 100);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('recent message');
  }, 10_000);

  it('AC1: no rows match → { deleted: 0 }', async () => {
    appendConversationMessage(TEST_FOLDER, 'user', 'fresh message');

    // Cutoff far in the past — nothing matches
    const cutoff = new Date(Date.now() - 999_000_000).toISOString();
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history?before=${encodeURIComponent(cutoff)}`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: number };
    expect(body.deleted).toBe(0);

    // Original message untouched
    expect(getConversationHistory(TEST_FOLDER, 100)).toHaveLength(1);
  }, 10_000);

  // ── AC2 — no ?before → full-clear (Story 26 behavior) ────────────────────

  it('AC2: no ?before param → full-clear returns 204', async () => {
    appendConversationMessage(TEST_FOLDER, 'user', 'will be cleared');
    appendConversationMessage(TEST_FOLDER, 'assistant', 'also cleared');

    const res = await fetch(`http://localhost:${HTTP_PORT}/history`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(res.status).toBe(204);
    expect(getConversationHistory(TEST_FOLDER, 100)).toHaveLength(0);
  }, 10_000);

  // ── AC3 — unparseable before → 400 ───────────────────────────────────────

  it('AC3: unparseable before returns 400 with ISO-8601 error message', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history?before=not-a-date`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('ISO-8601');
  }, 10_000);

  // ── AC4 — future before → accepted ───────────────────────────────────────

  it('AC4: before in the future deletes all rows', async () => {
    appendConversationMessage(TEST_FOLDER, 'user', 'message one');
    appendConversationMessage(TEST_FOLDER, 'assistant', 'message two');

    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history?before=${encodeURIComponent(futureIso)}`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: number };
    expect(body.deleted).toBe(2);
    expect(getConversationHistory(TEST_FOLDER, 100)).toHaveLength(0);
  }, 10_000);

  // ── Auth guard ────────────────────────────────────────────────────────────

  it('returns 401 without credentials', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history?before=2025-01-01T00:00:00.000Z`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(401);
  }, 5_000);
});
