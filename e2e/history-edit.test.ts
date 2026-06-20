/**
 * E2E tests for Story 82 — PATCH /history/<id>
 *
 * Verifies that an authenticated user can redact/edit a single conversation
 * message via PATCH, with correct 200/400/404/401/405 behavior, body size cap,
 * and FTS index coherence.
 *
 * Namespace: kubeclaw-e2e-history-edit
 * Port: 14165
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { makeHttpChannel, type HttpChannelOpts } from './lib/http-test-channel.js';
import {
  _initTestDatabase,
  appendConversationMessage,
  getConversationHistory,
  db,
  updateConversationMessage,
} from '../src/db.js';

const HTTP_PORT = 14165;
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';
const ALICE_JID = `http:${ALICE_USER}`;
const BOB_JID = `http:${BOB_USER}`;
const ALICE_FOLDER = 'alice-history-edit';
const BOB_FOLDER = 'bob-history-edit';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('PATCH /history/<id> — Story 82', () => {
  let channel: ReturnType<typeof makeHttpChannel> | null = null;

  function createTestOpts(): HttpChannelOpts {
    return {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [ALICE_JID]: {
          name: 'Alice',
          folder: ALICE_FOLDER,
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
        [BOB_JID]: {
          name: 'Bob',
          folder: BOB_FOLDER,
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };
  }

  beforeAll(async () => {
    await _initTestDatabase();
    const config = {
      port: HTTP_PORT,
      users: {
        [ALICE_USER]: ALICE_PASS,
        [BOB_USER]: BOB_PASS,
      },
    };
    channel = makeHttpChannel(config, createTestOpts());
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(async () => {
    // Clear history between tests
    db.run(`DELETE FROM conversation_history WHERE group_folder IN (?, ?)`, [
      ALICE_FOLDER,
      BOB_FOLDER,
    ]);
    db.run(`DELETE FROM conversation_history_fts`);
  });

  // AC1: successful edit
  it('AC1: PATCH with valid content returns 200 with updated message JSON', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'original message content');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'redacted content' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; role: string; content: string; created_at: string };
    expect(body.id).toBe(id);
    expect(body.content).toBe('redacted content');
    expect(body.role).toBe('user');
    expect(typeof body.created_at).toBe('string');
  });

  it('AC1: subsequent GET /history/<id> returns the new content', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'before redaction');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    // PATCH to update
    await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'after redaction' }),
    });

    // GET to verify
    const getRes = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { content: string };
    expect(body.content).toBe('after redaction');
  });

  it('AC1: empty string content is permitted', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'will be emptied');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toBe('');
  });

  // AC2: missing/non-string content
  it('AC2: missing content field → 400 with correct error', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ other: 'field' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('content must be a string');
  });

  it('AC2: non-string content → 400 with correct error', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('content must be a string');
  });

  // AC3: unknown id or cross-group → 404 (identical wording)
  it('AC3: unknown id → 404', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/nonexistent-id`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'new' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
  });

  it('AC3: id from another group → 404 (same wording as unknown)', async () => {
    appendConversationMessage(BOB_FOLDER, 'user', 'bob message');
    const bobHistory = getConversationHistory(BOB_FOLDER);
    const bobId = bobHistory[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${bobId}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'alice trying to edit bob message' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not found');
    // Bob's message must be unchanged
    const bobHistory2 = getConversationHistory(BOB_FOLDER);
    expect(bobHistory2[0].content).toBe('bob message');
  });

  // AC4: unauthenticated, wrong method
  it('AC4: unauthenticated PATCH → 401', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'redacted' }),
    });
    expect(res.status).toBe(401);
  });

  it('AC4: PUT /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'new' }),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD, DELETE, PATCH');
  });

  it('AC4: HEAD /history/<id> still works (Story 64 regression)', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'head test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  // AC5: body cap 256 KiB + 1 → 413
  it('AC5: body larger than 256 KiB → 413', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'test');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    // Build a body slightly over 256 KiB
    const largeContent = 'x'.repeat(256 * 1024 + 1);
    const body = JSON.stringify({ content: largeContent });

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  // FTS coherence
  it('FTS coherence: PATCH removes old tokens and indexes new ones', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'secret abcdef leaked token');
    const history = getConversationHistory(ALICE_FOLDER);
    const id = history[0].id;

    await fetch(`http://localhost:${HTTP_PORT}/history/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'redacted xyz safe' }),
    });

    // Old token must be gone from FTS
    const oldResult = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'abcdef'`,
    );
    expect(oldResult.length).toBe(0);

    // New token must be in FTS
    const newResult = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xyz'`,
    );
    expect(newResult[0].values.length).toBe(1);
  });
});
