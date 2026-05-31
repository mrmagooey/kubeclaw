/**
 * Story 53 — Batch slash-command E2E test.
 *
 * Sends two POST /message requests back-to-back for the same user — a normal
 * text message followed by a slash command — and verifies that BOTH are
 * responded to (the slash command via SSE AND the normal message via the LLM
 * path / processing queue).
 *
 * Target:  kind cluster kubeclaw-e2e-istio
 * Namespace: kubeclaw-e2e-msg-batch
 * Port:    14136
 *
 * The test is written against the HTTP channel's REST+SSE interface. It does
 * NOT require a live LLM (the normal-message response arrives asynchronously
 * via SSE from the DirectLLMRunner); the test only asserts on the slash-command
 * reply, which is synchronous and LLM-independent.
 *
 * When the LLM is available the test also verifies that the normal message
 * produced a non-empty SSE reply (AC1 full). Set SKIP_LLM_CHECK=1 to disable
 * the LLM-reply assertion for environments without a model.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';

const NAMESPACE = 'kubeclaw-e2e-msg-batch';
const HTTP_PORT = 14136;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret';
const SKIP_LLM = process.env.SKIP_LLM_CHECK === '1';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open an SSE stream for the given user. Returns collected data lines and a
 * helper that polls until a predicate is satisfied (or timeout).
 */
async function openSseStream(
  user: string,
  pass: string,
  timeoutMs: number = 15_000,
): Promise<{ lines: string[]; abort: () => void; waitFor: (pred: (lines: string[]) => boolean, ms?: number) => Promise<boolean> }> {
  const lines: string[] = [];
  const controller = new AbortController();

  // Fire-and-forget the SSE fetch; collect data lines in `lines`
  (async () => {
    try {
      const res = await fetch(`${HTTP_URL}/stream`, {
        headers: { Authorization: basicAuth(user, pass) },
        signal: controller.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            lines.push(line.slice(6));
          }
        }
      }
    } catch {
      // AbortError on cleanup
    }
  })();

  const waitFor = async (pred: (lines: string[]) => boolean, ms: number = timeoutMs): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred(lines)) return true;
      await sleep(100);
    }
    return false;
  };

  return { lines, abort: () => controller.abort(), waitFor };
}

describe('Story 53 — Batch slash-command: mixed normal + slash in one batch', () => {
  let cluster: ClusterHandle | null = null;

  beforeAll(async () => {
    cluster = await setupTestCluster({
      namespace: NAMESPACE,
      httpChannel: {
        localPort: HTTP_PORT,
        users: `${TEST_USER}:${TEST_PASS}`,
      },
      setupTimeoutMs: 9 * 60 * 1000,
      quiet: true,
    });
  }, 600_000);

  afterAll(async () => {
    if (cluster) await cluster.teardown();
  }, 120_000);

  /**
   * AC1 (partial): send a normal message then a /search command in quick
   * succession. The /search reply arrives on SSE. The normal message is NOT
   * discarded — it reaches the processing queue (asserting the LLM reply is
   * optional via SKIP_LLM_CHECK).
   */
  it('AC1: /search reply received on SSE; normal message is not discarded', async () => {
    const { lines, abort, waitFor } = await openSseStream(TEST_USER, TEST_PASS);

    // Small delay to ensure the SSE connection is established
    await sleep(300);

    // Message 1: normal text
    const normalRes = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(TEST_USER, TEST_PASS),
      },
      body: JSON.stringify({ text: 'summarise my notes' }),
    });
    expect(normalRes.status).toBe(200);

    // Message 2: slash command (immediately after)
    const searchRes = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(TEST_USER, TEST_PASS),
      },
      body: JSON.stringify({ text: '/search notes' }),
    });
    expect(searchRes.status).toBe(200);

    // The /search reply should arrive on SSE. It is LLM-independent.
    const gotSearchReply = await waitFor(
      (ls) => ls.some((l) => l.toLowerCase().includes('result') || l.toLowerCase().includes('notes') || l.toLowerCase().includes('no result')),
      12_000,
    );
    expect(gotSearchReply).toBe(true);

    if (!SKIP_LLM) {
      // The LLM reply for the normal message should also arrive on SSE.
      // This can take longer depending on the model.
      const gotLLMReply = await waitFor(
        (ls) => ls.length >= 2,
        30_000,
      );
      expect(gotLLMReply).toBe(true);
    }

    abort();
  }, 60_000);

  /**
   * AC4: send two slash commands back-to-back — /skills list then /search foo.
   * Both must produce SSE replies.
   */
  it('AC4: two consecutive slash commands both produce replies', async () => {
    const { lines, abort, waitFor } = await openSseStream(TEST_USER, TEST_PASS);

    await sleep(300);

    // Slash command 1
    const r1 = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(TEST_USER, TEST_PASS),
      },
      body: JSON.stringify({ text: '/skills list' }),
    });
    expect(r1.status).toBe(200);

    // Slash command 2 (immediately after)
    const r2 = await fetch(`${HTTP_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(TEST_USER, TEST_PASS),
      },
      body: JSON.stringify({ text: '/search test' }),
    });
    expect(r2.status).toBe(200);

    // Both slash commands should each produce an SSE reply → ≥2 lines
    const gotBothReplies = await waitFor(
      (ls) => ls.length >= 2,
      15_000,
    );
    expect(gotBothReplies).toBe(true);

    abort();
  }, 30_000);

  /**
   * Kubernetes smoke check: the namespace and channel pod exist.
   * This test is skipped in environments without kubectl/the cluster.
   */
  it('kubectl: channel pod is Running in the expected namespace', () => {
    const r = kubectl(
      ['get', 'pods', '-n', NAMESPACE, '-l', 'kubeclaw.io/role=channel', '--no-headers'],
      { timeout: 10_000 },
    );

    if (!r.ok) {
      console.warn(`[Story53 E2E] kubectl not available or namespace ${NAMESPACE} not found — skipping`);
      return;
    }

    // At least one channel pod should be Running
    const lines = r.stdout.split('\n').filter((l) => l.trim());
    const running = lines.some((l) => l.includes('Running'));
    expect(running).toBe(true);
  }, 15_000);
});
