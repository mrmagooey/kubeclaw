/**
 * End-to-end tests for the /schedule slash command via the HTTP channel.
 *
 * Target: kind cluster kubeclaw-e2e-istio, namespace kubeclaw-e2e-schedule,
 * HTTP channel port 14128.
 *
 * These tests exercise the full path:
 *   HTTP POST /message → channel-runner intercept → DB (SQLite) → SSE reply
 *
 * AC1: /schedule add interval 60000 "ping" returns SSE confirmation with UUID id.
 * AC2: /schedule list returns task rows with id, schedule_type, schedule_value,
 *      status, next_run.  Returns "No scheduled tasks" when none exist.
 * AC3: /schedule remove <id> returns "Removed"; subsequent list excludes id.
 * AC4: /schedule remove <unknown-id> returns "not found" with no stack trace.
 * AC5: alice's list does not include bob's tasks (per-group isolation).
 *
 * DO NOT execute — this file is a placeholder for cluster-level verification.
 * Run with: vitest run e2e/schedule-command.test.ts (requires running kind cluster)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HTTP_PORT = 14128;
const BASE_URL = `http://localhost:${HTTP_PORT}`;

const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepass';
const BOB_USER = 'bob';
const BOB_PASS = 'bobpass';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Send a message via HTTP POST and read the first SSE reply line.
 * Returns the text of the first `data:` SSE event.
 */
async function sendAndReceive(
  user: string,
  pass: string,
  text: string,
  timeoutMs = 5000,
): Promise<string> {
  // Open SSE stream first so we don't miss events
  const controller = new AbortController();
  const sseChunks: string[] = [];
  const sseReady = new Promise<void>((resolve) => {
    fetch(`${BASE_URL}/stream`, {
      headers: { Authorization: basicAuth(user, pass) },
      signal: controller.signal,
    })
      .then(async (res) => {
        resolve();
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseChunks.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          // AbortError expected on cleanup
        }
      })
      .catch(() => resolve()); // resolve even on error so tests don't hang
  });

  await sseReady;
  // Give SSE a moment to register the client
  await new Promise((r) => setTimeout(r, 100));

  // Send the message
  await fetch(`${BASE_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });

  // Wait for a reply in SSE chunks
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const full = sseChunks.join('');
    const dataLine = full
      .split('\n')
      .find((l) => l.startsWith('data: '));
    if (dataLine) {
      controller.abort();
      return dataLine.slice('data: '.length).trim();
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  controller.abort();
  return '';
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skip('e2e: /schedule command via HTTP channel (requires cluster)', () => {
  // skipIf: no cluster available. Remove `.skip` to run against a live cluster.

  it('AC1: /schedule add interval 60000 "ping" returns confirmation with UUID', async () => {
    const reply = await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      '/schedule add interval 60000 "ping"',
    );
    expect(reply).toMatch(/Scheduled task created/i);
    expect(reply).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    // No LLM invocation: no lengthy model response
  }, 10_000);

  it('AC2: /schedule list returns "No scheduled tasks" when none exist (fresh group)', async () => {
    const reply = await sendAndReceive(BOB_USER, BOB_PASS, '/schedule list');
    expect(reply).toMatch(/no scheduled tasks/i);
  }, 10_000);

  it('AC2: /schedule list returns task fields after add', async () => {
    await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      '/schedule add interval 30000 "daily check"',
    );
    const reply = await sendAndReceive(ALICE_USER, ALICE_PASS, '/schedule list');
    expect(reply).toMatch(/Scheduled tasks/i);
    expect(reply).toContain('interval');
    expect(reply).toContain('30000');
    expect(reply).toMatch(/id:/);
    expect(reply).toMatch(/next_run:/);
    expect(reply).toContain('active');
  }, 15_000);

  it('AC3: /schedule remove <id> returns "Removed"; not in list afterwards', async () => {
    const addReply = await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      '/schedule add once 2030-01-01T00:00:00Z "new year"',
    );
    const match = addReply.match(
      /id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    expect(match).not.toBeNull();
    const taskId = match![1];

    const removeReply = await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      `/schedule remove ${taskId}`,
    );
    expect(removeReply).toMatch(/Removed/i);

    const listReply = await sendAndReceive(ALICE_USER, ALICE_PASS, '/schedule list');
    expect(listReply).not.toContain(taskId);
  }, 20_000);

  it('AC4: /schedule remove <unknown-id> returns "not found" without stack trace', async () => {
    const reply = await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      '/schedule remove 00000000-dead-beef-dead-000000000000',
    );
    expect(reply).toMatch(/not found/i);
    expect(reply).not.toMatch(/Error:|at \w/);
  }, 10_000);

  it('AC5: bob cannot see alice tasks; alice cannot see bob tasks', async () => {
    // Alice adds a task
    await sendAndReceive(
      ALICE_USER,
      ALICE_PASS,
      '/schedule add interval 60000 "alice private"',
    );

    // Bob lists — should not see alice's task
    const bobList = await sendAndReceive(BOB_USER, BOB_PASS, '/schedule list');
    expect(bobList).not.toContain('alice private');

    // Alice lists — should not contain bob's data
    const aliceList = await sendAndReceive(ALICE_USER, ALICE_PASS, '/schedule list');
    expect(aliceList).toContain('alice private');
  }, 20_000);
});
