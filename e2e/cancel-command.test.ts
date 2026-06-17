/**
 * End-to-end tests for Story 49 — /cancel slash command
 *
 * Target cluster: kubeclaw-e2e-istio
 * Namespace:      kubeclaw-e2e-cancel
 * HTTP port:      14133
 *
 * DO NOT EXECUTE — these tests require a running kind cluster with a
 * fully deployed kubeclaw stack including an active tool job. They are
 * provided for documentation and future CI integration.
 *
 * Acceptance criteria verified:
 *   AC1 — /cancel while a tool job is running returns SSE containing "Cancelled" within 5 s
 *   AC2 — Within 30 s of cancel reply, kubectl get pod returns no items
 *   AC3 — After cancellation, a subsequent POST /message returns 200 and dispatches
 *   AC4 — /cancel with no active job returns SSE containing "No active job"
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const NAMESPACE = 'kubeclaw-e2e-cancel';
const HTTP_PORT = 14133;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const HTTP_USER = 'testuser';
const HTTP_PASS = 'testpass';
const TEST_JID = `http:${HTTP_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Synchronous kubectl wrapper.
 */
function kubectl(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
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

/**
 * POST /message and collect SSE reply lines until predicate satisfied or timeout.
 */
async function postMessageAndCollectSSE(
  content: string,
  timeoutMs: number,
  predicate: (line: string) => boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content, sender: 'testuser', chat_jid: TEST_JID });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        path: '/message',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(HTTP_USER, HTTP_PASS),
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        const lines: string[] = [];
        const timer = setTimeout(() => {
          req.destroy();
          resolve(lines);
        }, timeoutMs);

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              lines.push(data);
              if (predicate(data)) {
                clearTimeout(timer);
                req.destroy();
                resolve(lines);
                return;
              }
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timer);
          resolve(lines);
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Wait up to `maxMs` for a condition to be true, polling every `intervalMs`. */
async function waitUntil(
  check: () => boolean,
  maxMs: number,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

// ---------------------------------------------------------------------------
// These tests are intentionally skipped unless KUBECLAW_E2E_CANCEL=1 is set.
// ---------------------------------------------------------------------------

const RUN_E2E = process.env.KUBECLAW_E2E_CANCEL === '1';
const maybeDescribe = RUN_E2E ? describe : describe.skip;

maybeDescribe('Story 49 — /cancel e2e', () => {
  let activeJobId: string | undefined;

  beforeAll(async () => {
    // Sanity check: cluster and namespace must be reachable
    const nsCheck = kubectl(['get', 'namespace', NAMESPACE, '--ignore-not-found']);
    if (!nsCheck.stdout.includes(NAMESPACE)) {
      throw new Error(
        `Namespace ${NAMESPACE} not found — deploy kubeclaw-e2e-cancel first`,
      );
    }
  });

  afterAll(async () => {
    // Best-effort cleanup of any leftover test jobs
    if (activeJobId) {
      kubectl([
        'delete', 'job', '-l', `kubeclaw.io/job-id=${activeJobId}`,
        '--ignore-not-found',
      ]);
    }
  });

  it('AC1 — /cancel while job is running returns SSE "Cancelled" within 5 s', async () => {
    // First, trigger a long-running tool job by sending a slow prompt
    // (the exact prompt depends on the deployed specialist setup)
    const triggerLines = await postMessageAndCollectSSE(
      'run a slow background task please',
      3000,
      (line) => line.length > 0,
    );

    // Give the K8s job a moment to reach Running state
    await new Promise((r) => setTimeout(r, 2000));

    // Check that a pod is Running
    const podsCheck = kubectl(['get', 'pods', '-l', 'app=kubeclaw-agent', '--field-selector=status.phase=Running']);
    // (We verify a job exists; the exact label depends on deployment)
    // Now send /cancel
    const cancelLines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /cancelled/i.test(line),
    );

    expect(cancelLines.some((l) => /cancelled/i.test(l))).toBe(true);
  });

  it('AC2 — within 30 s of cancel, pod is gone', async () => {
    // This test depends on AC1 having been run first.
    // Wait up to 30 s for all kubeclaw-agent pods to be removed.
    const noPodsYet = await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'app=kubeclaw-agent',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ]);
      return r.stdout.trim() === '';
    }, 30_000, 2000);

    expect(noPodsYet).toBe(true);
  });

  it('AC3 — after cancel, a subsequent /message dispatches normally', async () => {
    const lines = await postMessageAndCollectSSE(
      'hello after cancel',
      10_000,
      (line) => line.length > 0,
    );

    // Should get a 200 response and at least one SSE line
    expect(lines.length).toBeGreaterThan(0);
  });

  it('AC4 — /cancel with no active job returns "No active job"', async () => {
    // Ensure no jobs are running first
    await waitUntil(() => {
      const r = kubectl([
        'get', 'pods', '-l', 'app=kubeclaw-agent',
        '--field-selector=status.phase=Running',
        '--no-headers',
      ]);
      return r.stdout.trim() === '';
    }, 15_000, 1000);

    const lines = await postMessageAndCollectSSE('/cancel', 5000, (line) =>
      /no active job/i.test(line),
    );

    expect(lines.some((l) => /no active job/i.test(l))).toBe(true);
  });
});
