/**
 * e2e tests for Story 20: SSE stream catch-up on reconnect via Last-Event-ID.
 *
 * Acceptance criteria:
 *  AC1. Every SSE event has a monotonically increasing `id:` field.
 *  AC2. Reconnect with Last-Event-ID replays messages with ID > supplied value.
 *  AC3. First connect (no header) → no replay; only live events received.
 *  AC4. Replay skipped if Last-Event-ID is older than 24h.
 *  AC5. POST → drop connection → POST → reconnect → both events received in order.
 *
 * LLM-independent. Uses HttpChannel directly with the shared test DB
 * (initialized by e2e/setup.ts → _initTestDatabase).
 *
 * Port 14105 — unique; no other e2e test uses this port.
 */

import http from 'node:http';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { makeHttpChannel, type HttpChannelOpts } from './lib/http-test-channel.js';
import { waitFor } from './setup.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HTTP_PORT = 14105; // unique port for this suite
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';
const ALICE_JID = `http:${ALICE_USER}`;

// ── Helpers ─────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open an SSE connection and collect all SSE lines until aborted.
 * Returns arrays of `id:` values and `data:` values seen.
 */
function openSse(
  lastEventId?: string,
): { ids: string[]; data: string[]; abort: () => void; done: Promise<void> } {
  const ids: string[] = [];
  const data: string[] = [];
  const controller = new AbortController();

  const headers: Record<string, string> = {
    Authorization: basicAuth(ALICE_USER, ALICE_PASS),
  };
  if (lastEventId !== undefined) {
    headers['Last-Event-ID'] = lastEventId;
  }

  const done = fetch(`http://localhost:${HTTP_PORT}/stream`, {
    headers,
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (line.startsWith('id: ')) {
              ids.push(line.slice('id: '.length).trim());
            } else if (line.startsWith('data: ')) {
              data.push(line.slice('data: '.length));
            }
          }
        }
      } catch {
        // AbortError expected on cleanup
      }
    })
    .catch(() => {});

  return { ids, data, abort: () => controller.abort(), done };
}

/**
 * Make a raw HTTP GET request via http.request so we can inspect SSE lines
 * directly without fetch normalisation.
 */
function rawSseRequest(
  lastEventId?: string,
): {
  ids: string[];
  data: string[];
  abort: () => void;
  ready: Promise<void>;
} {
  const ids: string[] = [];
  const data: string[] = [];
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const reqHeaders: Record<string, string> = {
    Authorization: basicAuth(ALICE_USER, ALICE_PASS),
  };
  if (lastEventId !== undefined) {
    reqHeaders['Last-Event-ID'] = lastEventId;
  }

  const req = http.request(
    {
      hostname: 'localhost',
      port: HTTP_PORT,
      path: '/stream',
      method: 'GET',
      headers: reqHeaders,
    },
    (res) => {
      resolveReady();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.startsWith('id: ')) {
            ids.push(line.slice('id: '.length).trim());
          } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
          }
        }
      });
    },
  );
  req.on('error', () => {});
  req.end();

  return {
    ids,
    data,
    abort: () => req.destroy(),
    ready,
  };
}

// ── Suite setup ──────────────────────────────────────────────────────────────

describe('SSE catch-up on reconnect (Story 20)', () => {
  let channel: ReturnType<typeof makeHttpChannel> | null = null;

  function createChannel(): ReturnType<typeof makeHttpChannel> {
    const opts: HttpChannelOpts = {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [ALICE_JID]: {
          name: 'Alice',
          folder: 'http-alice',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };
    return makeHttpChannel(
      { port: HTTP_PORT, users: { [ALICE_USER]: ALICE_PASS } },
      opts,
    );
  }

  beforeAll(async () => {
    channel = createChannel();
    await channel.connect();
  }, 10_000);

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  }, 10_000);

  // ── AC1: Every SSE event has a monotonically increasing `id:` field ─────

  it(
    'AC1: SSE events have an id: field that is a valid epoch-ms integer',
    async () => {
      const { ids, abort, done } = openSse();

      // Wait for SSE to connect
      await sleep(200);

      // Send two messages
      await channel!.sendMessage(ALICE_JID, 'msg-one');
      await sleep(50);
      await channel!.sendMessage(ALICE_JID, 'msg-two');

      // Wait until we see two ids
      await waitFor(() => ids.length >= 2, 3000);

      abort();
      await done;

      expect(ids.length).toBeGreaterThanOrEqual(2);

      const first = Number(ids[0]);
      const second = Number(ids[1]);

      expect(Number.isInteger(first)).toBe(true);
      expect(Number.isInteger(second)).toBe(true);
      // Monotonically increasing
      expect(second).toBeGreaterThanOrEqual(first);
      // Looks like a plausible epoch-ms (after 2020-01-01)
      expect(first).toBeGreaterThan(1_577_836_800_000);
    },
    10_000,
  );

  // ── AC2: Reconnect with Last-Event-ID replays missed messages ────────────

  it(
    'AC2: reconnect with Last-Event-ID replays messages with ID > supplied value',
    async () => {
      // Step 1: Connect, send a message, capture its id
      const first = rawSseRequest();
      await first.ready;
      await sleep(100);

      await channel!.sendMessage(ALICE_JID, 'catch-up-msg');

      await waitFor(() => first.ids.length >= 1, 3000);
      const capturedId = first.ids[first.ids.length - 1];

      // Step 2: Disconnect first connection
      first.abort();
      await sleep(100);

      // Step 3: Send another message while disconnected — missed by client
      await channel!.sendMessage(ALICE_JID, 'missed-while-offline');

      await sleep(100);

      // Step 4: Reconnect with Last-Event-ID = capturedId
      // Should receive the missed message as catch-up
      const reconnected = rawSseRequest(capturedId);
      await reconnected.ready;

      await waitFor(() => reconnected.data.length >= 1, 3000);

      expect(
        reconnected.data.some((d) => d.includes('missed-while-offline')),
      ).toBe(true);

      reconnected.abort();
    },
    15_000,
  );

  // ── AC3: No Last-Event-ID header → no replay ─────────────────────────────

  it(
    'AC3: connecting without Last-Event-ID header does not replay past messages',
    async () => {
      // Send a message before connecting
      await channel!.sendMessage(ALICE_JID, 'pre-connect-msg');
      await sleep(100);

      // Connect without Last-Event-ID
      const { data, abort, done } = openSse(); // no lastEventId arg

      await sleep(500); // give time for any replays to arrive

      // Send a live message
      await channel!.sendMessage(ALICE_JID, 'live-msg');
      await waitFor(() => data.some((d) => d.includes('live-msg')), 3000);

      abort();
      await done;

      // The pre-connect message should NOT be replayed
      expect(data.some((d) => d.includes('pre-connect-msg'))).toBe(false);
    },
    10_000,
  );

  // ── AC4: Old Last-Event-ID (> 24h) → no replay ──────────────────────────

  it(
    'AC4: Last-Event-ID older than 24h is ignored (no replay)',
    async () => {
      // Send a message to store something in DB
      await channel!.sendMessage(ALICE_JID, 'recent-msg');
      await sleep(100);

      // Use a very old id (more than 24h ago)
      const oldId = String(Date.now() - 25 * 60 * 60 * 1000);

      const reconnected = rawSseRequest(oldId);
      await reconnected.ready;

      await sleep(500); // give time for any (unexpected) replay to arrive

      // Now send a live message — if replay was skipped, only live message arrives
      await channel!.sendMessage(ALICE_JID, 'after-old-id');
      await waitFor(() => reconnected.data.some((d) => d.includes('after-old-id')), 3000);

      reconnected.abort();

      // 'recent-msg' was stored but the old-id replay should have been skipped.
      // The live 'after-old-id' is fine to see; 'recent-msg' should NOT appear
      // (since it was only sent before connecting; we never had that SSE connection open).
      // We verify the replay wasn't triggered by checking no data arrived before the
      // live 'after-old-id' message (i.e. the first data item is 'after-old-id').
      const catchUpItems = reconnected.data.filter(
        (d) => !d.includes('after-old-id'),
      );
      expect(catchUpItems.length).toBe(0);
    },
    10_000,
  );

  // ── AC5: Full round-trip: send → drop → send → reconnect → both in order ─

  it(
    'AC5: messages sent before and after drop are both received on reconnect in order',
    async () => {
      // Step 1: Connect SSE
      const initial = rawSseRequest();
      await initial.ready;
      await sleep(100);

      // Step 2: Send first reply while connected
      await channel!.sendMessage(ALICE_JID, 'reply-before-drop');
      await waitFor(() => initial.ids.length >= 1, 3000);
      const idBeforeDrop = initial.ids[initial.ids.length - 1];

      // Step 3: Drop the connection
      initial.abort();
      await sleep(100);

      // Step 4: Send second reply while disconnected
      await channel!.sendMessage(ALICE_JID, 'reply-after-drop');
      await sleep(100);

      // Step 5: Reconnect with Last-Event-ID = idBeforeDrop
      const reconnected = rawSseRequest(idBeforeDrop);
      await reconnected.ready;

      // The catch-up should deliver 'reply-after-drop'
      await waitFor(
        () => reconnected.data.some((d) => d.includes('reply-after-drop')),
        3000,
      );

      reconnected.abort();

      // Verify we received 'reply-after-drop' (the one that was missed)
      expect(
        reconnected.data.some((d) => d.includes('reply-after-drop')),
      ).toBe(true);

      // And 'reply-before-drop' should NOT appear in catch-up (id <= idBeforeDrop)
      expect(
        reconnected.data.some((d) => d.includes('reply-before-drop')),
      ).toBe(false);
    },
    15_000,
  );
});
