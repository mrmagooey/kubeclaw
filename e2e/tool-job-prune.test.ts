/**
 * E2E tests for Story 55 — automatic pruning of resolved tool_jobs rows.
 *
 * Target: minikube cluster, namespace kubeclaw-e2e-job-prune,
 *         HTTP channel on port 14138.
 *
 * These tests exercise the full system: they use the HTTP channel API to
 * submit messages that trigger tool-job creation (or inject synthetic DB rows
 * via the debug endpoint), then wait for the prune interval to fire and verify
 * the rows are absent from subsequent /jobs output.
 *
 * The suite is gated on Kubernetes availability (describe.skipIf) so it skips
 * cleanly in environments without a cluster and runs automatically when one is
 * present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  setupTestCluster,
  type ClusterHandle,
} from './lib/per-test-cluster.js';
import { isKubernetesAvailable } from './setup.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NAMESPACE = 'kubeclaw-e2e-job-prune';
const HTTP_PORT = 14138;
const TEST_USER = 'alice';
const TEST_PASS = 'testpass';
const TEST_JID = `http:${TEST_USER}`;
const BASE_URL = process.env.E2E_HTTP_URL ?? `http://127.0.0.1:${HTTP_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const AUTH = basicAuth(TEST_USER, TEST_PASS);

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: AUTH,
    },
    body: JSON.stringify(body),
  });
}

/**
 * A single tool-job row as returned by GET /jobs.
 */
interface JobRow {
  job_id: string;
  specialist_name: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Fetch tool-job rows for the authenticated user via GET /jobs.
 *
 * With no `status` argument this returns the non-active rows
 * (completed/interrupted/timeout/oomkill) — the set the prune logic operates
 * on. Pass `'active'` to fetch the active rows, which are never pruned.
 *
 * The HTTP channel scopes /jobs to the caller's group folder, which for an
 * unregistered HTTP user is `http:<user>` — the same value the tests inject
 * rows under (TEST_JID).
 */
async function getJobs(status?: 'active'): Promise<JobRow[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await fetch(`${BASE_URL}/jobs${qs}`, {
    headers: { Authorization: AUTH },
  });
  if (res.status !== 200) {
    throw new Error(`GET /jobs${qs} returned ${res.status}`);
  }
  return (await res.json()) as JobRow[];
}

/** True if a job with the given id is present in the row set. */
function hasJob(rows: JobRow[], jobId: string): boolean {
  return rows.some((r) => r.job_id === jobId);
}

// ── Suite (cluster-gated) ────────────────────────────────────────────────────

describe.skipIf(!isKubernetesAvailable())(
  'tool-job prune E2E (Story 55)',
  () => {
    let clusterHandle: ClusterHandle;

    beforeAll(
      async () => {
        // Bring up an isolated kubeclaw release with:
        //   - HTTP channel enabled, accessible on localhost:14138
        //   - alice:testpass as the only authenticated user
        //   - debug endpoints ON (required for /debug/tool-jobs/inject)
        //   - toolJobsRetentionDays=1 so rows >1 day old are eligible for pruning
        //   - toolJobsPruneIntervalMs=5000 so the prune tick fires every 5 s in e2e
        clusterHandle = await setupTestCluster({
          namespace: NAMESPACE,
          httpChannel: {
            localPort: HTTP_PORT,
            users: `${TEST_USER}:${TEST_PASS}`,
          },
          extraSet: [
            'httpChannel.debugEndpointsEnabled=true',
            'httpChannel.toolJobsRetentionDays=1',
            // toolJobsPruneIntervalMs is a string value in values.yaml; use
            // --set (not --set-string) here — helm coerces it correctly because
            // the chart receives it as an env var string, but the integer form
            // is fine; per-test-cluster passes all extraSet via --set.
            'httpChannel.toolJobsPruneIntervalMs=5000',
            // Point the orchestrator at a dummy LLM base URL so helm install
            // does not fail on a missing secret — the prune tests don't invoke
            // the LLM at all.
            'secrets.openaiBaseUrl=http://localhost:11434/v1',
          ],
          quiet: true,
        });
      },
      10 * 60 * 1000,
    ); // 10 min: lock wait + helm install + rollout

    afterAll(async () => {
      if (clusterHandle) {
        await clusterHandle.teardown();
      }
    });

    // ── AC1: rows older than toolJobsRetentionDays are absent after prune ──────

    it('AC1: resolved rows older than retention window are absent after prune interval fires', async () => {
      // The cluster is deployed with TOOL_JOBS_RETENTION_DAYS=1 (1 day).
      // Inject a resolved row with resolved_at = 2 days ago via the debug endpoint.
      const injectRes = await post('/debug/tool-jobs/inject', {
        job_id: 'prune-test-old-job',
        group_folder: TEST_JID,
        status: 'completed',
        resolved_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
      });
      expect(injectRes.status).toBe(200);

      // The row is eligible immediately (resolved_at is 2 days old > 1 day
      // retention) and must be present before the prune tick fires.
      expect(hasJob(await getJobs(), 'prune-test-old-job')).toBe(true);

      // Wait for the prune interval to run (up to 70 min in real deployment;
      // for e2e the interval is overridden via TOOL_JOBS_PRUNE_INTERVAL_MS=5000).
      await new Promise((r) => setTimeout(r, 8000));

      // GET /jobs must no longer list the pruned job.
      expect(hasJob(await getJobs(), 'prune-test-old-job')).toBe(false);
    }, 30_000);

    // ── AC2: active rows are never pruned ─────────────────────────────────────

    it('AC2: active rows are never pruned even when created_at is old', async () => {
      // Inject an active job with a very old created_at.
      const injectRes = await post('/debug/tool-jobs/inject', {
        job_id: 'prune-test-active-ancient',
        group_folder: TEST_JID,
        status: 'active',
        created_at: new Date(Date.now() - 30 * 86400_000).toISOString(),
      });
      expect(injectRes.status).toBe(200);

      // Wait for prune interval to fire at least once.
      await new Promise((r) => setTimeout(r, 8000));

      // Active job must still appear under GET /jobs?status=active — the prune
      // logic only deletes rows whose status != 'active'.
      expect(hasJob(await getJobs('active'), 'prune-test-active-ancient')).toBe(
        true,
      );
    }, 30_000);

    // ── AC3: /jobs still returns correct output for remaining recent jobs ──────

    it('AC3: /jobs returns correctly formatted output for recent jobs after prune', async () => {
      // Inject one old row (to be pruned) and one recent row (to be kept).
      await post('/debug/tool-jobs/inject', {
        job_id: 'prune-test-stale',
        group_folder: TEST_JID,
        status: 'completed',
        resolved_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
      });
      await post('/debug/tool-jobs/inject', {
        job_id: 'prune-test-keeper',
        group_folder: TEST_JID,
        status: 'completed',
        resolved_at: new Date(Date.now() - 3600_000).toISOString(),
      });

      // Wait for prune.
      await new Promise((r) => setTimeout(r, 8000));

      const rows = await getJobs();

      // Recent job must remain and be well-formed.
      const keeper = rows.find((r) => r.job_id === 'prune-test-keeper');
      expect(keeper).toBeDefined();
      expect(keeper).toMatchObject({
        job_id: 'prune-test-keeper',
        status: 'completed',
      });
      expect(typeof keeper?.created_at).toBe('string');
      expect(typeof keeper?.resolved_at).toBe('string');

      // Stale job must be pruned.
      expect(hasJob(rows, 'prune-test-stale')).toBe(false);
    }, 30_000);

    // ── AC4: prune interval fires on schedule ─────────────────────────────────

    it('AC4: prune runs on the configured interval and deletes eligible rows', async () => {
      // With TOOL_JOBS_PRUNE_INTERVAL_MS=5000, inject an old row and wait for
      // two interval ticks to confirm the scheduler is wired up.
      const injectRes = await post('/debug/tool-jobs/inject', {
        job_id: 'prune-interval-check',
        group_folder: TEST_JID,
        status: 'completed',
        resolved_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
      });
      expect(injectRes.status).toBe(200);
      expect(hasJob(await getJobs(), 'prune-interval-check')).toBe(true);

      await new Promise((r) => setTimeout(r, 12000)); // wait for 2 ticks

      // The scheduler must have removed the eligible row on its own.
      expect(hasJob(await getJobs(), 'prune-interval-check')).toBe(false);
    }, 30_000);

    // ── AC5: retention=0 disables pruning ─────────────────────────────────────

    // AC5 (retention=0 disables pruning) is verified at the unit and integration
    // levels, not here. A true e2e of this AC needs a channel deployed with
    // TOOL_JOBS_RETENTION_DAYS=0, but this suite's single shared cluster holds
    // the per-PID cluster lock for its whole lifetime, so a second in-file
    // cluster would deadlock, and reconfiguring the running release mid-suite
    // would tear down the port-forward the other ACs depend on. The disable
    // behaviour is covered by:
    //   - src/db.test.ts: "returns 0 when retentionDays=0 (disabled) without
    //     deleting anything"
    //   - src/k8s/tool-job-prune.integration.test.ts
    it.skip('AC5: when TOOL_JOBS_RETENTION_DAYS=0, no rows are deleted (covered by unit + integration tests)', () => {});
  },
);
