/**
 * E2E tests for Story 64 — GET /history/<id>
 *
 * Verifies that an authenticated user can fetch a single conversation message
 * by id, with correct 200/404 behavior and no cross-group enumeration.
 *
 * Namespace: kubeclaw-e2e-history-id
 * Port: 14147
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

const HTTP_PORT = 14147;
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';
const ALICE_JID = `http:${ALICE_USER}`;
const BOB_JID = `http:${BOB_USER}`;
const ALICE_FOLDER = 'alice-get-id';
const BOB_FOLDER = 'bob-get-id';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('GET /history/<id> — Story 64', () => {
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

  // AC1: authenticated GET with matching id → 200 + JSON body with required fields
  it('AC1: returns 200 with JSON body containing id, role, content, created_at', async () => {
    appendConversationMessage(ALICE_FOLDER, 'user', 'Hello, this is Alice');

    const history = getConversationHistory(ALICE_FOLDER);
    expect(history).toHaveLength(1);
    const targetId = history[0].id;

    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${targetId}`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      id: string;
      role: string;
      content: string;
      created_at: string;
    };
    expect(body.id).toBe(targetId);
    expect(body.role).toBe('user');
    expect(body.content).toBe('Hello, this is Alice');
    expect(typeof body.created_at).toBe('string');
  });

  // AC2: unknown id → 404
  it('AC2: returns 404 for an id that does not exist', async () => {
    const res = await fetch(
      `http://localhost:${HTTP_PORT}/history/completely-made-up-id`,
      {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
  });

  // AC3: id from another group → 404 (same wording, no enumeration)
  it('AC3: returns 404 for an id that belongs to a different group (no enumeration)', async () => {
    appendConversationMessage(BOB_FOLDER, 'user', "Bob's private message");
    const bobHistory = getConversationHistory(BOB_FOLDER);
    expect(bobHistory).toHaveLength(1);
    const bobMsgId = bobHistory[0].id;

    // Alice attempts to GET Bob's message
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/${bobMsgId}`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
    // Same error text as AC2 — no enumeration
    expect(body.error).toBe('Not found');
  });

  // AC2 and AC3 wording must be identical (security: no enumeration)
  it('AC2+AC3: unknown-id and cross-group return identical 404 wording', async () => {
    // Cross-group id
    appendConversationMessage(BOB_FOLDER, 'user', 'another message');
    const bobHistory = getConversationHistory(BOB_FOLDER);
    const bobId = bobHistory[0].id;

    const crossGroupRes = await fetch(`http://localhost:${HTTP_PORT}/history/${bobId}`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });
    const crossGroupBody = (await crossGroupRes.json()) as { error: string };

    // Truly unknown id
    const unknownRes = await fetch(
      `http://localhost:${HTTP_PORT}/history/nonexistent-id-xyz`,
      {
        headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
      },
    );
    const unknownBody = (await unknownRes.json()) as { error: string };

    expect(crossGroupRes.status).toBe(404);
    expect(unknownRes.status).toBe(404);
    expect(crossGroupBody.error).toBe(unknownBody.error);
  });

  // AC4: unauthenticated → 401
  it('AC4: returns 401 for unauthenticated request', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/some-id`);
    expect(res.status).toBe(401);
  });

  // AC5: POST /history/<id> → 405 with Allow: GET, HEAD, DELETE, PATCH (updated by Story 82)
  it('AC5: POST returns 405 with Allow: GET, HEAD, DELETE, PATCH', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/history/some-id`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(ALICE_USER, ALICE_PASS),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, DELETE, PATCH');
  });

  // AC5: HEAD /history/<id> — same headers as GET but no body
  it('AC5: HEAD returns same status and headers as GET but no body', async () => {
    appendConversationMessage(ALICE_FOLDER, 'assistant', 'A reply');
    const history = getConversationHistory(ALICE_FOLDER);
    const targetId = history[0].id;

    const getRes = await fetch(`http://localhost:${HTTP_PORT}/history/${targetId}`, {
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });

    const headRes = await fetch(`http://localhost:${HTTP_PORT}/history/${targetId}`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(ALICE_USER, ALICE_PASS) },
    });

    expect(headRes.status).toBe(getRes.status);
    expect(headRes.headers.get('content-type')).toBe(
      getRes.headers.get('content-type'),
    );
    // HEAD body must be empty
    const headText = await headRes.text();
    expect(headText).toBe('');
  });
});
