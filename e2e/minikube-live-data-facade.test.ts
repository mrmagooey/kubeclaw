/**
 * Minikube-live: data-facade HTTP endpoint coverage against a live channel pod.
 *
 * Gap closed: the data-facade endpoints (GET /history, /jobs, /schedule,
 * /search, /memory, /audit, /diag, /config-adjacent) were only covered by
 * in-process e2e tests (e.g. history-pagination.test.ts, jobs-http.test.ts,
 * schedule-http.test.ts, etc.). This file exercises them over a REAL live
 * channel pod via the port-forward that globalSetup provides.
 *
 * The bootstrapped HTTP channel (instance "e2e-http") is set up by the
 * global setup in e2e/minikube-live-setup.ts. It is port-forwarded to
 * localhost:KUBECLAW_LIVE_HTTP_LOCAL_PORT (14081), and authenticates with
 * HTTP Basic auth (alice:livepass / bob:bobpass).
 *
 * Strategy:
 *   1. beforeAll: verify port-forward is live; POST one message to create
 *      some conversation history and ensure the group is registered, so
 *      group-scoped endpoints return data rather than 404.
 *   2. Each test: assert HTTP status + JSON shape for one data-facade endpoint.
 *   3. Auth guard: verify that at least one endpoint returns 401 without creds.
 *
 * Endpoints covered:
 *   GET /history           → 200 { messages: [...] }
 *   GET /history?limit=1   → pagination param honoured
 *   GET /jobs              → 200 JSON array (sdk.jobs.recentForGroup)
 *   GET /schedule          → 200 JSON array (sdk.tasks.listForGroup)
 *   GET /search?q=hello    → 200 JSON array (sqlite FTS over conversation_history)
 *   GET /memory            → 200 { content: string }
 *   GET /audit             → 200 { entries: [...] }
 *   GET /diag              → 200 JSON with 7 required numeric fields
 *   GET /version           → 200 JSON with version/model fields (no auth needed)
 *   GET /whoami            → 200 { username, group, group_folder }
 *
 * Endpoints deliberately omitted:
 *   POST /message          — needs LLM round-trip to produce an assistant reply
 *   GET  /secrets          — returns 503 on pods where listSecretsFn was not injected;
 *                            covered by minikube-live-channel-http-bootstrap.test.ts AC5
 *   DELETE /history        — destructive; would invalidate the history assertion
 *   POST /schedule         — mutating; left to schedule-http.test.ts
 *   GET /stream            — SSE; not testable with a simple fetch
 *
 * Auth:
 *   Tests use alice:livepass (KUBECLAW_LIVE_USER / KUBECLAW_LIVE_PASS).
 *   One test asserts that GET /history returns 401 without credentials.
 *
 * Skip guard:
 *   beforeAll checks that the port-forward is live (nc probe via fetch). If
 *   the port-forward is not reachable (no cluster / globalSetup skipped) all
 *   assertions use console.warn + return, matching sibling minikube-live tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;
const SKIP_MSG =
  '[data-facade e2e] Port-forward not reachable — globalSetup may have failed. Skipping.';

// ── Helpers ────────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Minikube-live: data-facade endpoints against live channel pod', () => {
  let provisioned = false;
  const AUTH = basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

  beforeAll(async () => {
    // Check that the HTTP port-forward (started by globalSetup) is reachable.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // retry
      }
      await sleep(1_000);
    }

    if (!provisioned) {
      console.warn(SKIP_MSG);
      return;
    }

    // POST one text message so the channel registers alice's group and we have
    // at least one conversation_history row. Retry loop covers a channel pod
    // that is still starting up.
    for (let i = 0; i < 15; i++) {
      try {
        const r = await fetch(`${HTTP_URL}/message`, {
          method: 'POST',
          headers: {
            Authorization: AUTH,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'data-facade e2e probe hello' }),
          signal: AbortSignal.timeout(5_000),
        });
        if (r.status === 200) break;
      } catch {
        // retry
      }
      await sleep(2_000);
    }

    // Give the channel pod time to register the group with the orchestrator
    // via Redis IPC so group-scoped endpoints return data (not 404).
    await sleep(5_000);

    // Wait until GET /history returns 200 (group is registered in channel memory).
    for (let i = 0; i < 15; i++) {
      try {
        const probe = await fetch(`${HTTP_URL}/history?limit=1`, {
          headers: { Authorization: AUTH },
          signal: AbortSignal.timeout(5_000),
        });
        if (probe.status === 200) break;
      } catch {
        // ignore
      }
      await sleep(2_000);
    }
  }, 120_000);

  // ── Auth guard (baseline) ─────────────────────────────────────────────────

  it(
    'GET /history without credentials returns 401',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/history`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        res.status,
        `GET /history (no creds) must return 401, got ${res.status}`,
      ).toBe(401);
    },
    30_000,
  );

  it(
    'GET /history with wrong password returns 401',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/history`, {
        headers: { Authorization: basicAuth(KUBECLAW_LIVE_USER, 'wrongpass') },
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        res.status,
        `GET /history (wrong password) must return 401, got ${res.status}`,
      ).toBe(401);
    },
    30_000,
  );

  // ── GET /history ──────────────────────────────────────────────────────────

  it(
    'GET /history returns 200 with { messages: [...] } shape',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/history`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /history must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as { messages: unknown[] };
      expect(
        Array.isArray(body.messages),
        `GET /history body must have a 'messages' array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);

      // We seeded at least one message in beforeAll; assert shape of each row.
      for (const msg of body.messages as Record<string, unknown>[]) {
        expect(typeof msg.id, 'message.id must be a string').toBe('string');
        expect(
          ['user', 'assistant'].includes(msg.role as string),
          `message.role must be user or assistant. Got: ${msg.role}`,
        ).toBe(true);
        expect(typeof msg.content, 'message.content must be a string').toBe('string');
        expect(typeof msg.created_at, 'message.created_at must be a string').toBe('string');
      }
    },
    30_000,
  );

  it(
    'GET /history?limit=1 returns at most 1 message',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/history?limit=1`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /history?limit=1 must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as { messages: unknown[] };
      expect(
        Array.isArray(body.messages),
        'body.messages must be an array',
      ).toBe(true);
      expect(
        body.messages.length,
        'body.messages.length must be ≤1',
      ).toBeLessThanOrEqual(1);
    },
    30_000,
  );

  // ── GET /jobs ─────────────────────────────────────────────────────────────

  it(
    'GET /jobs returns 200 + JSON array (sdk data-facade wired)',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/jobs`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /jobs must return 200 (authenticated). Got ${res.status}. ` +
          'A 500/503 would indicate the sdk.jobs data-facade is not wired.',
      ).toBe(200);

      const body = (await res.json()) as unknown;
      expect(
        Array.isArray(body),
        `GET /jobs body must be a JSON array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);

      // If any jobs are present, validate their shape.
      for (const job of body as Record<string, unknown>[]) {
        expect(typeof job.job_id, 'job.job_id must be a string').toBe('string');
        expect(typeof job.status, 'job.status must be a string').toBe('string');
        expect(typeof job.created_at, 'job.created_at must be a string').toBe('string');
      }
    },
    30_000,
  );

  // ── GET /schedule ─────────────────────────────────────────────────────────

  it(
    'GET /schedule returns 200 + JSON array',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/schedule`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /schedule must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as unknown;
      expect(
        Array.isArray(body),
        `GET /schedule body must be a JSON array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);

      // Validate shape of any returned tasks.
      for (const task of body as Record<string, unknown>[]) {
        expect(typeof task.id, 'task.id must be a string').toBe('string');
        expect(typeof task.status, 'task.status must be a string').toBe('string');
        expect(typeof task.schedule_type, 'task.schedule_type must be a string').toBe('string');
        expect(typeof task.created_at, 'task.created_at must be a string').toBe('string');
      }
    },
    30_000,
  );

  // ── GET /search?q= ────────────────────────────────────────────────────────

  it(
    'GET /search?q=hello returns 200 + JSON array (FTS over conversation_history)',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(
        `${HTTP_URL}/search?q=${encodeURIComponent('hello')}`,
        {
          headers: { Authorization: AUTH },
          signal: AbortSignal.timeout(15_000),
        },
      );
      expect(
        res.status,
        `GET /search?q=hello must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as unknown;
      expect(
        Array.isArray(body),
        `GET /search body must be a JSON array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);

      // We seeded "data-facade e2e probe hello" in beforeAll, so we expect at
      // least one hit. Validate shape if rows are present.
      for (const row of body as Record<string, unknown>[]) {
        expect(typeof row.id, 'search row.id must be a string').toBe('string');
        expect(typeof row.role, 'search row.role must be a string').toBe('string');
        expect(typeof row.content, 'search row.content must be a string').toBe('string');
        expect(
          'timestamp' in row,
          `search row must have a 'timestamp' field. Got: ${JSON.stringify(row)}`,
        ).toBe(true);
      }
    },
    30_000,
  );

  it(
    'GET /search without q returns 400 with error body',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/search`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        res.status,
        `GET /search (missing q) must return 400. Got ${res.status}`,
      ).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(typeof body.error, '/search 400 body must have an error string').toBe('string');
    },
    15_000,
  );

  // ── GET /memory ───────────────────────────────────────────────────────────

  it(
    'GET /memory returns 200 + { content: string }',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/memory`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /memory must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as { content: string };
      expect(
        'content' in body,
        `GET /memory body must have a 'content' field. Got: ${JSON.stringify(body)}`,
      ).toBe(true);
      expect(
        typeof body.content,
        "GET /memory body.content must be a string ('' if file absent)",
      ).toBe('string');
    },
    30_000,
  );

  // ── GET /audit ────────────────────────────────────────────────────────────

  it(
    'GET /audit returns 200 + { entries: [...] }',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/audit`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /audit must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as { entries: unknown[] };
      expect(
        'entries' in body,
        `GET /audit body must have an 'entries' field. Got: ${JSON.stringify(body)}`,
      ).toBe(true);
      expect(
        Array.isArray(body.entries),
        'GET /audit body.entries must be an array',
      ).toBe(true);

      // Validate shape of any present audit entries.
      for (const entry of body.entries as Record<string, unknown>[]) {
        expect(
          'id' in entry,
          `audit entry must have 'id'. Got: ${JSON.stringify(entry)}`,
        ).toBe(true);
        expect(
          'action' in entry,
          `audit entry must have 'action'. Got: ${JSON.stringify(entry)}`,
        ).toBe(true);
        expect(
          'ts' in entry,
          `audit entry must have 'ts'. Got: ${JSON.stringify(entry)}`,
        ).toBe(true);
      }
    },
    30_000,
  );

  // ── GET /diag ─────────────────────────────────────────────────────────────

  it(
    'GET /diag returns 200 + JSON object with the 7 required numeric fields',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/diag`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /diag must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      const required = [
        'conversation_history_rows',
        'scheduled_tasks_active',
        'tool_jobs_recent_24h',
        'attachment_count',
        'attachment_bytes',
        'db_size_bytes',
        'uptime_seconds',
      ];
      for (const key of required) {
        expect(
          key in body,
          `GET /diag body must have '${key}'. Got: ${JSON.stringify(Object.keys(body))}`,
        ).toBe(true);
        const val = body[key];
        expect(
          val === null || typeof val === 'number',
          `GET /diag body.${key} must be number or null. Got: ${typeof val}`,
        ).toBe(true);
      }

      // uptime_seconds must be a non-negative integer (the channel is already up).
      expect(typeof body.uptime_seconds, 'uptime_seconds must be a number').toBe('number');
      expect(
        (body.uptime_seconds as number) >= 0,
        `uptime_seconds must be ≥0. Got: ${body.uptime_seconds}`,
      ).toBe(true);
    },
    30_000,
  );

  // ── GET /version (no auth) ────────────────────────────────────────────────

  it(
    'GET /version (no auth required) returns 200 + { version, model }',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/version`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        res.status,
        `GET /version must return 200 without auth. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(
        'version' in body,
        `GET /version body must have 'version'. Got: ${JSON.stringify(body)}`,
      ).toBe(true);
      expect(
        'model' in body,
        `GET /version body must have 'model'. Got: ${JSON.stringify(body)}`,
      ).toBe(true);
    },
    15_000,
  );

  // ── GET /whoami ───────────────────────────────────────────────────────────

  it(
    'GET /whoami returns 200 + { username, group, group_folder } for authenticated user',
    async (ctx) => {
      if (!provisioned) return ctx.skip();

      const res = await fetch(`${HTTP_URL}/whoami`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        res.status,
        `GET /whoami must return 200. Got ${res.status}`,
      ).toBe(200);

      const body = (await res.json()) as {
        username: string;
        group: string;
        group_folder: string;
      };
      expect(
        body.username,
        `GET /whoami body.username must equal '${KUBECLAW_LIVE_USER}'`,
      ).toBe(KUBECLAW_LIVE_USER);
      expect(
        body.group,
        `GET /whoami body.group must equal 'http:${KUBECLAW_LIVE_USER}'`,
      ).toBe(`http:${KUBECLAW_LIVE_USER}`);
      expect(
        typeof body.group_folder,
        'GET /whoami body.group_folder must be a string',
      ).toBe('string');
    },
    15_000,
  );
});
