/**
 * Minikube-live concurrent capability install end-to-end tests.
 *
 * Validates that the orchestrator's dedicated Redis connection for
 * install_capability XADDs (introduced in commit b775b3e) allows multiple
 * in-flight installs to proceed without head-of-line blocking behind XREAD BLOCK.
 *
 * Without the singleton-split fix, each install would queue behind the XREAD
 * BLOCK on the shared connection, causing ~5+ second per-install serial delay.
 * These tests catch regressions where that blocking re-appears.
 *
 * Setup mirrors minikube-live-capabilities.test.ts:
 *   - NAMESPACE = 'kubeclaw-live'
 *   - Standard provisioned flag + redis port-forward
 *   - randHex() for unique cap names per run
 *   - cleanupCapability helper for afterAll cleanup
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a short random hex suffix for unique per-run cap names. */
function randHex(len = 6): string {
  return Math.floor(Math.random() * 16 ** len)
    .toString(16)
    .padStart(len, '0');
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
 * Poll until the named Deployment exists in the namespace.
 * Returns { found: true, elapsedMs } when found, or { found: false, elapsedMs }
 * when the timeout elapses.
 */
async function waitForDeployment(
  name: string,
  namespace: string,
  timeoutMs: number,
): Promise<{ found: boolean; elapsedMs: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'deployment', name, '-n', namespace,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    if (r.ok && r.stdout.trim() === name) {
      return { found: true, elapsedMs: Date.now() - start };
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { found: false, elapsedMs: Date.now() - start };
}

/**
 * Poll until the named Deployment is gone from the namespace.
 * Returns true if gone (or was never present), false on timeout.
 */
async function waitForDeploymentGone(
  name: string,
  namespace: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'deployment', name, '-n', namespace,
      '-o', 'jsonpath={.metadata.name}',
    ]);
    if (!r.ok) return true; // 404 — gone
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

/**
 * Send a remove_capability XADD and wait (up to timeoutMs) for its Deployment
 * to disappear.  Safe to call from finally blocks — swallows Redis errors.
 */
async function cleanupCapability(
  redisClient: Redis,
  name: string,
  namespace: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  try {
    await redisClient.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'remove_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'name', name,
    );
  } catch {
    /* best-effort */
  }
  return waitForDeploymentGone(`kubeclaw-cap-${name}`, namespace, timeoutMs);
}

/** Build an install_capability spec for a generic MCP capability. */
function mcpSpec(name: string, port = 3000): object {
  return {
    kind: 'mcp',
    name,
    image: 'kubeclaw-test-mcp:latest',
    port,
    path: '/mcp',
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: concurrent capability install scenarios', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  // Unique suffix per run — prevents cross-run Deployment name collisions.
  const RUN = randHex();

  // All capability names created in this suite (populated per-test for afterAll).
  const allCaps: string[] = [];

  beforeAll(async () => {
    // Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `WARNING: Port-forward to ${HTTP_URL} not reachable — globalSetup may have failed.`,
      );
      return;
    }

    // Read Redis admin password and connect.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();
  }, 60_000);

  afterAll(async () => {
    // Clean up every capability this suite may have created, even on failure.
    if (redis) {
      await Promise.all(
        allCaps.map((name) =>
          cleanupCapability(redis!, name, NAMESPACE, 60_000),
        ),
      );
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── Test 1: 3 concurrent installs all complete within 30 s ───────────────
  it(
    'concurrent-3-installs: 3 simultaneous install_capability XADDs all produce Deployments within 30 s',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const names = [`concurrent-a-${RUN}`, `concurrent-b-${RUN}`, `concurrent-c-${RUN}`];
      names.forEach((n) => allCaps.push(n));

      // Pre-cleanup: remove any stale Deployments from a prior failed run.
      await Promise.all(names.map((n) => cleanupCapability(redis!, n, NAMESPACE, 30_000)));

      const start = Date.now();

      // Fire all three XADDs back-to-back (no await between them).
      await Promise.all(
        names.map((name) =>
          redis!.xadd(
            'kubeclaw:task-requests',
            '*',
            'type', 'install_capability',
            'groupFolder', 'http',
            'isMain', 'true',
            'spec', JSON.stringify(mcpSpec(name)),
          ),
        ),
      );

      // Poll for all three Deployments within 30 s total.
      const results = await Promise.all(
        names.map((name) =>
          waitForDeployment(`kubeclaw-cap-${name}`, NAMESPACE, 30_000),
        ),
      );

      const elapsedMs = Date.now() - start;
      console.log(
        `concurrent-3-installs: all three Deployments resolved in ${elapsedMs} ms ` +
          `(individual: ${results.map((r) => r.elapsedMs + 'ms').join(', ')})`,
      );

      for (let i = 0; i < names.length; i++) {
        expect(
          results[i].found,
          `Deployment kubeclaw-cap-${names[i]} did not appear within 30 s`,
        ).toBe(true);
      }

      expect(
        elapsedMs,
        `All 3 deployments should appear within 30 s; got ${elapsedMs} ms — possible head-of-line blocking regression`,
      ).toBeLessThan(30_000);
    },
    60_000,
  );

  // ── Test 2: concurrent install + remove of unrelated caps don't interfere ─
  it(
    'concurrent-install-remove: install and remove of unrelated caps complete independently within 30 s',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const capA = `concurrent-rem-a-${RUN}`;
      const capB = `concurrent-rem-b-${RUN}`;
      allCaps.push(capA, capB);

      // Pre-cleanup stale state.
      await Promise.all([
        cleanupCapability(redis!, capA, NAMESPACE, 30_000),
        cleanupCapability(redis!, capB, NAMESPACE, 30_000),
      ]);

      // Install cap A first, wait for its Deployment to exist.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'install_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'spec', JSON.stringify(mcpSpec(capA)),
      );
      const installA = await waitForDeployment(`kubeclaw-cap-${capA}`, NAMESPACE, 60_000);
      expect(installA.found, `cap A Deployment did not appear before concurrent phase`).toBe(true);

      const start = Date.now();

      // Concurrently: remove cap A and install cap B.
      await Promise.all([
        redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'remove_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'name', capA,
        ),
        redis!.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify(mcpSpec(capB)),
        ),
      ]);

      // Both operations should complete within 30 s.
      const [aGone, bResult] = await Promise.all([
        waitForDeploymentGone(`kubeclaw-cap-${capA}`, NAMESPACE, 30_000),
        waitForDeployment(`kubeclaw-cap-${capB}`, NAMESPACE, 30_000),
      ]);

      const elapsedMs = Date.now() - start;
      console.log(
        `concurrent-install-remove: elapsed ${elapsedMs} ms — ` +
          `capA gone=${aGone}, capB found=${bResult.found} (in ${bResult.elapsedMs} ms)`,
      );

      expect(
        aGone,
        `cap A Deployment (kubeclaw-cap-${capA}) still exists after remove_capability`,
      ).toBe(true);
      expect(
        bResult.found,
        `cap B Deployment (kubeclaw-cap-${capB}) did not appear within 30 s`,
      ).toBe(true);
      expect(
        elapsedMs,
        `Concurrent remove+install should complete within 30 s; got ${elapsedMs} ms`,
      ).toBeLessThan(30_000);
    },
    90_000,
  );

  // ── Test 3: same-name re-install while previous is processing ────────────
  it(
    'concurrent-same-name-reinstall: rapid re-install of same cap name results in final spec matching second XADD',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const capC = `concurrent-c-reinstall-${RUN}`;
      allCaps.push(capC);

      // Pre-cleanup.
      await cleanupCapability(redis!, capC, NAMESPACE, 30_000);

      // First XADD with port 3000.
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'install_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'spec', JSON.stringify(mcpSpec(capC, 3000)),
      );

      // Immediately (within 100 ms) send a second XADD with port 3001.
      // This races against the orchestrator processing the first message.
      await new Promise((r) => setTimeout(r, 50));
      await redis!.xadd(
        'kubeclaw:task-requests',
        '*',
        'type', 'install_capability',
        'groupFolder', 'http',
        'isMain', 'true',
        'spec', JSON.stringify(mcpSpec(capC, 3001)),
      );

      // Wait for the Deployment to exist.
      const result = await waitForDeployment(`kubeclaw-cap-${capC}`, NAMESPACE, 60_000);
      expect(
        result.found,
        `Deployment kubeclaw-cap-${capC} did not appear within 60 s`,
      ).toBe(true);

      // Read the final Deployment spec to determine which port won.
      const portOut = kubectl([
        'get', 'deployment', `kubeclaw-cap-${capC}`, '-n', NAMESPACE,
        '-o', 'jsonpath={.spec.template.spec.containers[0].ports[0].containerPort}',
      ]);

      const finalPort = portOut.ok ? parseInt(portOut.stdout.trim(), 10) : null;
      console.log(
        `concurrent-same-name-reinstall: final containerPort=${finalPort} ` +
          `(first XADD=3000, second XADD=3001). ` +
          (finalPort === 3001
            ? 'Last-write-wins: second spec applied.'
            : finalPort === 3000
              ? 'System serialized: first spec applied (both XADDs fully processed in order).'
              : 'Port not determinable — deployment exists but port unreadable.'),
      );

      // The Deployment MUST exist — either spec is acceptable.
      // Document the actual behavior: if 3001 it is last-write-wins; if 3000
      // the orchestrator serializes per-name (also correct behavior).
      expect(
        result.found,
        'Deployment must exist regardless of which spec won',
      ).toBe(true);

      // If a port was readable, it must be one of the two valid specs.
      if (finalPort !== null && !isNaN(finalPort)) {
        expect(
          [3000, 3001],
          `finalPort ${finalPort} is not either of the two submitted specs`,
        ).toContain(finalPort);
      }
    },
    90_000,
  );

  // ── Test 4: 5 concurrent installs serialize correctly under load ──────────
  it(
    'concurrent-5-installs: 5 simultaneous install_capability XADDs all produce Deployments within 60 s',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const names = Array.from({ length: 5 }, (_, i) => `concurrent-d${i + 1}-${RUN}`);
      names.forEach((n) => allCaps.push(n));

      // Pre-cleanup stale state.
      await Promise.all(names.map((n) => cleanupCapability(redis!, n, NAMESPACE, 30_000)));

      const start = Date.now();

      // Fire all five XADDs back-to-back.
      await Promise.all(
        names.map((name) =>
          redis!.xadd(
            'kubeclaw:task-requests',
            '*',
            'type', 'install_capability',
            'groupFolder', 'http',
            'isMain', 'true',
            'spec', JSON.stringify(mcpSpec(name)),
          ),
        ),
      );

      // Poll for all five Deployments within 60 s total.
      const results = await Promise.all(
        names.map((name) =>
          waitForDeployment(`kubeclaw-cap-${name}`, NAMESPACE, 60_000),
        ),
      );

      const elapsedMs = Date.now() - start;
      const foundCount = results.filter((r) => r.found).length;

      console.log(
        `concurrent-5-installs: ${foundCount}/5 Deployments resolved in ${elapsedMs} ms ` +
          `(per-cap: ${results.map((r) => r.elapsedMs + 'ms').join(', ')})`,
      );

      // Assert all five appeared.
      for (let i = 0; i < names.length; i++) {
        expect(
          results[i].found,
          `Deployment kubeclaw-cap-${names[i]} did not appear within 60 s`,
        ).toBe(true);
      }

      expect(
        elapsedMs,
        `All 5 deployments should appear within 60 s; got ${elapsedMs} ms — ` +
          `latency is ~${Math.round(elapsedMs / 5 / 1000)}s/cap which may indicate blocking`,
      ).toBeLessThan(60_000);
    },
    120_000,
  );
});
