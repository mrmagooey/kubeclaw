/**
 * End-to-end test for Story 54: /capabilities tools <type>
 *
 * Target cluster: kubeclaw-e2e-istio
 * Namespace: kubeclaw-e2e-cap-tools
 * HTTP channel port: 14137
 *
 * This test requires:
 *   1. A running kubeclaw deployment in the namespace above.
 *   2. A per-group MCP capability named 'echo' installed with scope=group.
 *      The orchestrator's schema-scraper must have run and cached the echo
 *      server's tool schemas.
 *   3. Port-forward: kubectl port-forward -n kubeclaw-e2e-cap-tools
 *        svc/kubeclaw-http 14137:80
 *
 * The test sends POST /message with body "/capabilities tools echo" and
 * asserts that the SSE response contains at least one tool name.
 *
 * AC1: schema available → SSE reply lists tool names.
 * AC2: not provisioned  → SSE reply contains "not provisioned".
 * AC3: pending-schema   → SSE reply contains "schema not yet available".
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PORT = parseInt(process.env.CAP_TOOLS_HTTP_PORT ?? '14137', 10);
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const TEST_USER = process.env.CAP_TOOLS_USER ?? 'e2e';
const TEST_PASS = process.env.CAP_TOOLS_PASS ?? 'e2e-secret';
const CAP_TYPE = process.env.CAP_TOOLS_TYPE ?? 'echo';
// Set to '1' to run these tests; they require a live cluster.
const RUN_E2E = process.env.CAP_TOOLS_E2E === '1';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Send a chat message via POST /message and collect SSE output lines until
 * the stream closes or the predicate matches.  Times out after timeoutMs.
 */
async function sendAndCollect(text: string, timeoutMs = 30_000): Promise<string[]> {
  const auth = basicAuth(TEST_USER, TEST_PASS);

  // Open SSE stream first so we don't miss the reply.
  const controller = new AbortController();
  const streamRes = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: auth },
    signal: controller.signal,
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`SSE /stream failed: HTTP ${streamRes.status}`);
  }

  const lines: string[] = [];
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const readerLoop = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // aborted or stream ended
    }
  })();

  // Post the message.
  const msgRes = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: text }),
  });
  if (!msgRes.ok) {
    controller.abort();
    throw new Error(`POST /message failed: HTTP ${msgRes.status}`);
  }

  // Wait for reply to appear (heuristic: wait until lines stop arriving or timeout).
  const deadline = Date.now() + timeoutMs;
  let lastLen = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (lines.length > lastLen) {
      lastLen = lines.length;
    } else if (lines.length > 0) {
      // Lines have stabilised; give one more tick then break.
      await new Promise((r) => setTimeout(r, 600));
      break;
    }
  }

  controller.abort();
  await readerLoop.catch(() => {});
  return lines;
}

describe.skipIf(!RUN_E2E)('/capabilities tools — e2e', () => {
  beforeAll(async () => {
    // Verify the HTTP channel is reachable.
    const res = await fetch(`${HTTP_URL}/healthz`).catch(() => null);
    if (!res?.ok) {
      throw new Error(
        `HTTP channel not reachable at ${HTTP_URL}/healthz — is the port-forward running?`,
      );
    }
  }, 10_000);

  it('AC1: /capabilities tools <type> lists MCP tools when schema is available', async () => {
    const lines = await sendAndCollect(`/capabilities tools ${CAP_TYPE}`);
    const combined = lines.join('\n');
    // The reply should contain at least one tool line (name — description pattern).
    expect(combined).toMatch(/Tools for/i);
    // At least one tool line should be present (format: "  <name> — <desc>")
    expect(combined).toMatch(/\s+\S+ — /);
  }, 60_000);

  it('AC2: /capabilities tools <nonexistent> → "not provisioned"', async () => {
    const lines = await sendAndCollect('/capabilities tools __nonexistent_cap__');
    const combined = lines.join('\n');
    expect(combined).toMatch(/not provisioned/i);
  }, 30_000);

  it('AC4: /capabilities tools (no type) → usage help, no crash', async () => {
    const lines = await sendAndCollect('/capabilities tools');
    const combined = lines.join('\n');
    expect(combined).toMatch(/Usage:/i);
    expect(combined).toContain('/capabilities tools <type>');
  }, 30_000);
});

// Smoke test that runs without a live cluster: verify the HTTP channel guard
// is present and the test infrastructure doesn't throw at import time.
describe('/capabilities tools — e2e infra smoke', () => {
  it('test constants are set', () => {
    expect(HTTP_URL).toMatch(/^http:\/\//);
    expect(CAP_TYPE).toBeTruthy();
  });
});
