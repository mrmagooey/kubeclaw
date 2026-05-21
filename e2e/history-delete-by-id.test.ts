/**
 * E2E tests for Story 56 — DELETE /history/<id>
 *
 * Verifies that an authenticated user can surgically remove a single message
 * from their conversation history without affecting other groups' messages.
 *
 * Namespace: kubeclaw-e2e-history-delete-id
 * Port: 14139
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import { _initTestDatabase, appendConversationMessage, getConversationHistory } from '../src/db.js';

const HTTP_PORT = 14139;
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';
const ALICE_JID = `http:${ALICE_USER}`;
const BOB_JID = `http:${BOB_USER}`;
const ALICE_FOLDER = 'alice-del-id';
const BOB_FOLDER = 'bob-del-id';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('DELETE /history/<id> — Story 56', () => {
  let channel: HttpChannel | null = null;

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
    channel = new HttpChannel(
      {
        port: HTTP_PORT,
        users: {
          [ALICE_USER]: ALICE_PASS,
          [BOB_USER]: BOB_PASS,
        },
      },
      createTestOpts(),
    );
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(async () => {
    // Re-init the in-process DB to start each test with a clean slate
    await _initTestDatabase();
  });

  // AC1: authenticated DELETE with matching id → 204; GET /history no longer includes it
  it('AC1: returns 204 and removes the message from history', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'Hello, this is Alice');
    appendConversationMessage(ALICE_FOLDER, 'assistant', 'Hi there!');

    // Retrieve history to get the id of the first message
    const history = getConversationHistory(ALICE_FOLDER);
    expect(history).toHaveLength(2);
    const targetId = history[0].id; // "Hello, this is Alice"

    // DELETE the message
    const delRes = await fetch(`http://localhost:${HTTP_PORT}/history/${targetId}`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(delRes.status).toBe(204);

    // GET /history should no longer include the deleted message
    const getRes = await fetch(`http://localhost:${HTTP_PORT}/history`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { messages: { id: string }[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).not.toContain(targetId);
    expect(ids).toHaveLength(1); // the assistant reply should still be there
  });

  // AC2: id exists but belongs to a different group → 403, row NOT deleted
  it('AC2: returns 403 when the message id belongs to a different group', async () => {
    // Insert a message for Bob's group
    appendConversationMessage(BOB_FOLDER, 'user', "Bob's private message");
    const bobHistory = getConversationHistory(BOB_FOLDER);
    expect(bobHistory).toHaveLength(1);
    const bobMsgId = bobHistory[0].id;

    // Alice attempts to delete Bob's message — should be forbidden
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${bobMsgId}`, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(res.status).toBe(403);

    // Bob's message must still exist
    const remaining = getConversationHistory(BOB_FOLDER);
    expect(remaining).toHaveLength(1);
  });

  // AC3: nonexistent id → 404
  it('AC3: returns 404 for a nonexistent message id', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history/completely-made-up-id`,
      {
        method: 'DELETE',
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
      },
    );
    expect(res.status).toBe(404);
  });

  // AC4: unauthenticated → 401
  it('AC4: returns 401 for unauthenticated request', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/some-id`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  // AC5: POST /history/<id> → 405 with Allow: GET, HEAD, DELETE (updated by Story 64)
  it('AC5: returns 405 with Allow: GET, HEAD, DELETE for POST /history/<id>', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/some-id`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, DELETE');
  });
});
