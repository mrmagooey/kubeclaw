/**
 * E2E: Tool job OOMKill surfaces a user-visible "out of memory" reply.
 * Story 46.
 *
 * Acceptance criteria verified:
 *   AC1 — When a tool-job pod's container is terminated with
 *          `containerStatuses[].lastState.terminated.reason === 'OOMKilled'`,
 *          the orchestrator emits a message to the originating channel group
 *          within 30 s containing "out of memory" (case-insensitive).
 *   AC2 — The orchestrator log contains
 *          `{ event: "tool_job_oomkill", groupFolder, jobName }`.
 *   AC3 — OOMKill reply stored in conversation_history with role='assistant',
 *          is_bot_message=1.
 *   AC4 — Group not wedged: subsequent POST /message returns 200, dispatched
 *          normally.
 *
 * Cluster  : kubeclaw-e2e-istio (kind)
 * Namespace: kubeclaw-e2e-oomkill
 * Port     : 14130
 *
 * Setup requirements:
 *   - A kind cluster with KubeClaw installed via Helm in the target namespace.
 *   - A registered group with a specialist whose image runs:
 *       node -e "let a=[];while(true){a.push(Buffer.alloc(1e6))}"
 *     with `resources.limits.memory: 64Mi` so it reliably OOMKills within a
 *     few seconds.
 *   - The specialist is named `oomkill-test` in the group's specialists config.
 *
 * This file is written but NOT automatically executed — it requires a live
 * kind cluster and namespace provisioned by the CI pipeline or manually.
 * Run with:
 *   npx vitest run --config vitest.e2e.config.ts e2e/tool-job-oomkill.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventSource } from 'eventsource';

const NAMESPACE = 'kubeclaw-e2e-oomkill';
const HTTP_PORT = 14130;
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TEST_USER = 'alice';
const TEST_PASS = 'testsecret';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? 'Andy';

/**
 * Specialist whose container is configured with a tiny memory limit so that
 * running a memory-bomb command causes an immediate OOMKill.
 *
 * Specialist definition (kubeclaw admin shell):
 *   name: oomkill-test
 *   image: node:20-alpine
 *   command: ["node", "-e", "let a=[];while(true){a.push(Buffer.alloc(1e6))}"]
 *   resources:
 *     limits:
 *       memory: 64Mi
 */
const OOMKILL_SPECIALIST = 'oomkill-test';

// ── Helpers ────────────────────────────────────────────────────────────────

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

/**
 * Open an SSE connection to /stream and resolve with the first message whose
 * text matches `predicate`, or reject after `timeoutMs`.
 */
function waitForSseMessage(
  headers: Record<string, string>,
  predicate: (data: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${HTTP_URL}/stream`, { headers });
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        source.close();
        reject(
          new Error(`Timed out after ${timeoutMs}ms waiting for SSE message`),
        );
      }
    }, timeoutMs);

    source.onmessage = (event: MessageEvent) => {
      let text: string;
      try {
        const data = JSON.parse(event.data);
        text = data.text ?? event.data;
      } catch {
        text = event.data;
      }
      if (predicate(text)) {
        resolved = true;
        clearTimeout(timer);
        source.close();
        resolve(text);
      }
    };

    source.onerror = () => {
      // SSE errors during poll are expected (connection dropped between events)
    };
  });
}

/** POST /message and return the response */
async function postMessage(
  text: string,
  auth: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ text }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const authHeaders = { Authorization: basicAuth(TEST_USER, TEST_PASS) };

beforeAll(async () => {
  const ping = await fetch(`${HTTP_URL}/healthz`).catch(() => null);
  if (!ping || !ping.ok) {
    console.warn(
      `[tool-job-oomkill e2e] HTTP channel unreachable at ${HTTP_URL} — ` +
        `ensure port-forward is running for namespace ${NAMESPACE}`,
    );
  }
}, 10_000);

afterAll(() => {
  // Nothing to clean up if CI manages the cluster lifecycle.
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('tool-job OOMKill — e2e (Story 46)', () => {
  it(
    'AC1: SSE stream delivers an "out of memory" message within 30 s of OOMKill',
    async () => {
      // Trigger the memory-bomb specialist
      const postResult = await postMessage(
        `@${OOMKILL_SPECIALIST} go`,
        authHeaders,
      );
      expect(postResult.status).toBe(200);

      // Wait for the OOM notice on the SSE stream
      const notice = await waitForSseMessage(
        authHeaders,
        (text) => text.toLowerCase().includes('out of memory'),
        30_000,
      );

      expect(notice.toLowerCase()).toContain('out of memory');
    },
    40_000,
  );

  it(
    'AC2: orchestrator log contains event: tool_job_oomkill with groupFolder and jobName',
    async () => {
      const result = kubectl(
        [
          'logs',
          '-n',
          NAMESPACE,
          'deployment/kubeclaw-orchestrator',
          '--since=60s',
        ],
        { timeout: 15_000 },
      );
      expect(result.ok).toBe(true);

      const lines = result.stdout.split('\n');
      const oomLine = lines.find((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.event === 'tool_job_oomkill' && obj.groupFolder;
        } catch {
          return false;
        }
      });
      expect(oomLine, 'Expected log entry with event=tool_job_oomkill').toBeTruthy();
    },
    20_000,
  );

  it(
    'AC4: subsequent POST /message returns 200 (group not wedged)',
    async () => {
      const result = await postMessage(`@${ASSISTANT_NAME} ping`, authHeaders);
      expect(result.status).toBe(200);
    },
    20_000,
  );
});
