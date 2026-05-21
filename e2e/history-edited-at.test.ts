/**
 * Story 84 — End-to-End Tests
 *
 * Tests the `edited_at` field on conversation_history:
 *   - GET /history returns rows with explicit `edited_at: null` when unedited
 *   - PATCH /history/:id response includes a non-null `edited_at` ISO string
 *   - Subsequent GET /history/:id returns the same `edited_at`
 *
 * Namespace: kubeclaw-e2e-history-edited-at  Port: 14167
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import {
  _initTestDatabase,
  appendConversationMessage,
} from '../src/db.js';

const E2E_PORT = 14167;
const TEST_USER = 'alice';
const TEST_PASS = 'e2e-secret';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

interface HistoryPageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  edited_at: string | null;
}

interface HistoryRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  edited_at: string | null;
}

describe('Story 84 — edited_at on conversation_history (e2e)', () => {
  let channel: HttpChannel | null = null;

  beforeAll(async () => {
    // Initialise in-process DB and seed a message for alice's group
    await _initTestDatabase();
    appendConversationMessage('alice-edited-at', 'user', 'original content');

    const opts: HttpChannelOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [`http:${TEST_USER}`]: {
          name: 'Alice',
          folder: 'alice-edited-at',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };

    channel = new HttpChannel({ port: E2E_PORT, users: { [TEST_USER]: TEST_PASS } }, opts);
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  it('GET /history list — all rows have explicit edited_at: null when unedited', async () => {
    const res = await fetch(`http://localhost:${E2E_PORT}/history`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: HistoryPageRow[] };
    expect(body.messages.length).toBeGreaterThan(0);

    for (const row of body.messages) {
      // edited_at must be a key in the object (not omitted)
      expect(Object.prototype.hasOwnProperty.call(row, 'edited_at')).toBe(true);
      expect(row.edited_at).toBeNull();
    }

    // Verify null is explicitly emitted in the JSON text (not stripped)
    const rawText = JSON.stringify(body.messages);
    expect(rawText).toContain('"edited_at":null');
  });

  it('GET /history/:id — unedited row returns edited_at: null explicitly', async () => {
    // Get the first row's id from the list endpoint
    const listRes = await fetch(`http://localhost:${E2E_PORT}/history`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const listBody = (await listRes.json()) as { messages: HistoryPageRow[] };
    expect(listBody.messages.length).toBeGreaterThan(0);
    const msgId = listBody.messages[0].id;

    const res = await fetch(`http://localhost:${E2E_PORT}/history/${encodeURIComponent(msgId)}`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const row = JSON.parse(raw) as HistoryRow;
    expect(Object.prototype.hasOwnProperty.call(row, 'edited_at')).toBe(true);
    expect(row.edited_at).toBeNull();
    expect(raw).toContain('"edited_at":null');
  });

  it('PATCH /history/:id — response contains non-null edited_at ISO string', async () => {
    // Get the first row's id
    const listRes = await fetch(`http://localhost:${E2E_PORT}/history`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const listBody = (await listRes.json()) as { messages: HistoryPageRow[] };
    const msgId = listBody.messages[0].id;

    const before = Date.now();
    const patchRes = await fetch(`http://localhost:${E2E_PORT}/history/${encodeURIComponent(msgId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'edited content' }),
    });
    const after = Date.now();

    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as HistoryRow;
    expect(patched.content).toBe('edited content');
    expect(patched.edited_at).not.toBeNull();
    const editedMs = new Date(patched.edited_at!).getTime();
    expect(editedMs).toBeGreaterThanOrEqual(before);
    expect(editedMs).toBeLessThanOrEqual(after + 100);
  });

  it('GET /history/:id after PATCH — returns same edited_at', async () => {
    // Get rows; find the edited row
    const listRes = await fetch(`http://localhost:${E2E_PORT}/history`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const listBody = (await listRes.json()) as { messages: HistoryPageRow[] };
    const editedRow = listBody.messages.find((r) => r.content === 'edited content');
    expect(editedRow).toBeDefined();
    const msgId = editedRow!.id;

    // PATCH again to get a fresh edited_at
    const patchRes = await fetch(`http://localhost:${E2E_PORT}/history/${encodeURIComponent(msgId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'edited again' }),
    });
    const patchedRow = (await patchRes.json()) as HistoryRow;
    const patchedEditedAt = patchedRow.edited_at;
    expect(patchedEditedAt).not.toBeNull();

    // Subsequent GET must return identical edited_at
    const getRes = await fetch(`http://localhost:${E2E_PORT}/history/${encodeURIComponent(msgId)}`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as HistoryRow;
    expect(fetched.edited_at).toBe(patchedEditedAt);
  });

  it('GET /history list — edited row has non-null edited_at', async () => {
    const res = await fetch(`http://localhost:${E2E_PORT}/history`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = (await res.json()) as { messages: HistoryPageRow[] };
    const editedRow = body.messages.find((r) => r.content === 'edited again');
    expect(editedRow).toBeDefined();
    expect(editedRow!.edited_at).not.toBeNull();
    // Verify the ISO string is syntactically valid
    expect(() => new Date(editedRow!.edited_at!)).not.toThrow();
  });
});
