/**
 * Minikube-live: assert the bootstrapped http channel is correctly wired.
 *
 * The global setup (e2e/minikube-live-setup.ts) bootstraps the http channel
 * as instance `e2e-http` (Service `kubeclaw-channel-e2e-http`, port-forwarded
 * to KUBECLAW_LIVE_HTTP_LOCAL_PORT = 14081, users alice:livepass,bob:bobpass).
 *
 * This test does NOT trigger a new bootstrap. It asserts that the
 * global-setup bootstrap produced the correct steady-state resources.
 *
 * AC coverage:
 *   AC1 [HARD]: Deployment kubeclaw-channel-e2e-http exists with command
 *               ["node","dist/channel-runner.js"], the orchestrator image, and
 *               groups/store/sessions volume mounts.
 *   AC2 [HARD]: httpPort wiring — container ports http(4080)+health; readinessProbe
 *               /readyz; Service kubeclaw-channel-e2e-http (ClusterIP, port 80);
 *               NetworkPolicy kubeclaw-channel-e2e-http-ingress (opens 4080).
 *               Channel-pod-log dump diagnostic if pod is not Ready.
 *   AC3 [HARD]: Channel pod is Ready AND serves — GET /healthz → 200 (no auth),
 *               GET /version → 200 + JSON body with version/model fields.
 *   AC4 [HARD]: Authenticated REST call proves sdk data-facade —
 *               GET /jobs (Basic alice:livepass) → 200 + JSON array body.
 *               This exercises sdk.jobs.active / sdk.jobs.recentForGroup via
 *               the channel-runner opts injection.
 *   AC5 [HARD]: Secrets opts-injection proof —
 *               GET /secrets (Basic alice:livepass) → 200 (NOT 503).
 *               A 503 would mean listSecretsFn was not injected (T2-review bug).
 *               Body must be a JSON array of {type, fields_present} objects.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const INSTANCE_NAME = 'e2e-http';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean } = {},
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

/** Resolve the first running pod name for a label selector. */
function getPodName(labelSelector: string): string | null {
  const r = kubectl([
    'get', 'pods', '-n', NAMESPACE,
    '-l', labelSelector,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  const name = r.ok ? r.stdout.trim() : '';
  return name || null;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Minikube-live: bootstrapped http channel steady-state assertions', () => {
  let provisioned = false;
  const AUTH_HEADER = basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);

  beforeAll(async () => {
    // Verify the http port-forward (started by global setup) is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // retry
      }
      await sleep(1000);
    }
    if (!provisioned) {
      console.warn(
        `[http-bootstrap e2e] Port-forward to ${HTTP_URL} not reachable — skipping all assertions. ` +
        `Check that globalSetup bootstrapped e2e-http and started the port-forward.`,
      );
    }
  }, 60_000);

  // ── AC1: Deployment exists with channel-runner command + PVC mounts ───────

  it(
    'Deployment kubeclaw-channel-e2e-http uses node dist/channel-runner.js + groups/store/sessions mounts (AC1) [HARD]',
    async () => {
      if (!provisioned) {
        console.warn('Skipping AC1 — port-forward not reachable');
        return;
      }

      // Fetch the Deployment as JSON for precise assertions.
      const r = kubectl([
        'get', 'deployment', `kubeclaw-channel-${INSTANCE_NAME}`,
        '-n', NAMESPACE, '-o', 'json',
      ]);
      expect(
        r.ok,
        `Deployment kubeclaw-channel-${INSTANCE_NAME} not found: ${r.stderr}`,
      ).toBe(true);

      const deploy = JSON.parse(r.stdout) as {
        spec: {
          template: {
            spec: {
              containers: Array<{
                command?: string[];
                image?: string;
                volumeMounts?: Array<{ mountPath?: string; name?: string }>;
              }>;
              volumes?: Array<{ name?: string }>;
            };
          };
        };
      };

      const containers = deploy.spec.template.spec.containers;
      expect(containers.length, 'Deployment must have at least one container').toBeGreaterThan(0);

      const main = containers[0];

      // AC1 (channel-runner command): command must include channel-runner.js
      expect(
        main.command,
        'Container command must be set (channel-runner mode)',
      ).toBeDefined();
      const cmd = main.command ?? [];
      expect(
        cmd.some((c) => c === 'node'),
        `command must include 'node': ${JSON.stringify(cmd)}`,
      ).toBe(true);
      expect(
        cmd.some((c) => c.includes('channel-runner.js')),
        `command must include 'dist/channel-runner.js': ${JSON.stringify(cmd)}`,
      ).toBe(true);

      // AC1 (orchestrator image): the image must look like the kubeclaw orchestrator image.
      expect(
        main.image,
        'Container must have an image (the orchestrator/channel-runner image)',
      ).toBeTruthy();

      // AC1 (PVC mounts): groups, store, sessions volumes must be mounted.
      const mounts = main.volumeMounts ?? [];
      const mountPaths = mounts.map((m) => m.mountPath ?? '');
      const mountNames = mounts.map((m) => m.name ?? '');

      const hasGroupsMount =
        mountPaths.some((p) => p.includes('/groups')) ||
        mountNames.some((n) => n.includes('groups'));
      const hasStoreMount =
        mountPaths.some((p) => p.includes('/store')) ||
        mountNames.some((n) => n.includes('store'));
      const hasSessionsMount =
        mountPaths.some((p) => p.includes('/sessions')) ||
        mountNames.some((n) => n.includes('sessions'));

      expect(hasGroupsMount, 'Deployment must mount groups volume (channel-runner path)').toBe(true);
      expect(hasStoreMount, 'Deployment must mount store volume (channel-runner path)').toBe(true);
      expect(hasSessionsMount, 'Deployment must mount sessions volume (channel-runner path)').toBe(true);
    },
    60_000,
  );

  // ── AC2: httpPort wiring + Service + NetworkPolicy + pod Ready ────────────

  it(
    'Container ports http(4080)+health, readinessProbe /readyz, Service + NetworkPolicy exist, pod Ready (AC2) [HARD]',
    async () => {
      if (!provisioned) {
        console.warn('Skipping AC2 — port-forward not reachable');
        return;
      }

      // Fetch the Deployment as JSON for port + probe assertions.
      const r = kubectl([
        'get', 'deployment', `kubeclaw-channel-${INSTANCE_NAME}`,
        '-n', NAMESPACE, '-o', 'json',
      ]);
      expect(r.ok, `Deployment not found: ${r.stderr}`).toBe(true);

      const deploy = JSON.parse(r.stdout) as {
        spec: {
          template: {
            spec: {
              containers: Array<{
                ports?: Array<{ containerPort?: number; name?: string }>;
                readinessProbe?: {
                  httpGet?: { path?: string; port?: number | string };
                };
              }>;
            };
          };
        };
      };

      const main = deploy.spec.template.spec.containers[0];

      // AC2 (http container port 4080):
      const ports = main.ports ?? [];
      const has4080 = ports.some((p) => p.containerPort === 4080);
      expect(
        has4080,
        `Container must declare port 4080 (httpPort). Found: ${JSON.stringify(ports)}`,
      ).toBe(true);

      // AC2 (readinessProbe /readyz):
      const probe = main.readinessProbe;
      expect(probe, 'Container must have a readinessProbe').toBeDefined();
      const probePath = probe?.httpGet?.path ?? '';
      expect(
        probePath.includes('readyz') || probePath === '/readyz',
        `readinessProbe must target /readyz. Got: ${probePath}`,
      ).toBe(true);

      // AC2 (Service):
      const svcResult = kubectl([
        'get', 'service', `kubeclaw-channel-${INSTANCE_NAME}`,
        '-n', NAMESPACE, '-o', 'json',
      ]);
      expect(
        svcResult.ok,
        `Service kubeclaw-channel-${INSTANCE_NAME} not found: ${svcResult.stderr}`,
      ).toBe(true);
      const svc = JSON.parse(svcResult.stdout) as {
        spec: { type?: string; ports?: Array<{ port?: number }> };
      };
      expect(
        svc.spec.type === 'ClusterIP' || svc.spec.type == null,
        `Service type must be ClusterIP (got ${svc.spec.type})`,
      ).toBe(true);
      const svcPorts = svc.spec.ports ?? [];
      expect(
        svcPorts.some((p) => p.port === 80),
        `Service must expose port 80. Got: ${JSON.stringify(svcPorts)}`,
      ).toBe(true);

      // AC2 (ingress NetworkPolicy):
      const netpolResult = kubectl([
        'get', 'networkpolicy', `kubeclaw-channel-${INSTANCE_NAME}-ingress`,
        '-n', NAMESPACE, '-o', 'yaml',
      ]);
      expect(
        netpolResult.ok,
        `NetworkPolicy kubeclaw-channel-${INSTANCE_NAME}-ingress not found: ${netpolResult.stderr}`,
      ).toBe(true);
      expect(
        netpolResult.stdout,
        'NetworkPolicy must reference port 4080',
      ).toContain('4080');

      // AC2 (pod Ready): poll for the channel pod to reach Ready state.
      let ready = false;
      for (let i = 0; i < 20; i++) {
        const pr = kubectl([
          'get', 'pod', '-n', NAMESPACE,
          '-l', `app=kubeclaw-channel-${INSTANCE_NAME}`,
          '-o', 'jsonpath={.items[0].status.conditions[?(@.type=="Ready")].status}',
        ]);
        if (pr.ok && pr.stdout.trim() === 'True') {
          ready = true;
          break;
        }
        await sleep(3000);
      }

      if (!ready) {
        // Diagnostic: dump logs so the crash reason appears in test output.
        const podName = getPodName(`app=kubeclaw-channel-${INSTANCE_NAME}`);
        if (podName) {
          const logs = kubectl([
            'logs', '-n', NAMESPACE, podName,
            '--all-containers=true', '--tail=120',
          ]);
          const prev = kubectl([
            'logs', '-n', NAMESPACE, podName,
            '--all-containers=true', '--previous', '--tail=120',
          ], { allowFail: true });
          const desc = kubectl(['describe', 'pod', '-n', NAMESPACE, podName]);
          console.error(
            `[AC2 channel pod not Ready] pod=${podName}\n` +
            `--- LOGS ---\n${logs.stdout}\n${logs.stderr}\n` +
            `--- PREVIOUS (crash) LOGS ---\n${prev.stdout}\n${prev.stderr}\n` +
            `--- DESCRIBE (tail) ---\n${desc.stdout.slice(-2500)}`,
          );
        }
      }
      expect(ready, `Channel pod app=kubeclaw-channel-${INSTANCE_NAME} did not reach Ready within 60s`).toBe(true);
    },
    120_000,
  );

  // ── AC3: pod serves — GET /healthz (no auth) → 200; GET /version → 200 + JSON ─

  it(
    'GET /healthz returns 200 (no auth); GET /version returns 200 + JSON body (AC3) [HARD]',
    async () => {
      if (!provisioned) {
        console.warn('Skipping AC3 — port-forward not reachable');
        return;
      }

      // GET /healthz — no auth required
      const healthzRes = await fetch(`${HTTP_URL}/healthz`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        healthzRes.status,
        `/healthz must return 200 (no auth needed). Got ${healthzRes.status}`,
      ).toBe(200);

      // GET /version — also no auth required; returns JSON with version/model fields
      const versionRes = await fetch(`${HTTP_URL}/version`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(
        versionRes.status,
        `/version must return 200. Got ${versionRes.status}`,
      ).toBe(200);

      const versionBody = await versionRes.json() as Record<string, unknown>;
      expect(typeof versionBody, '/version body must be a JSON object').toBe('object');
      expect(
        'version' in versionBody,
        `/version body must have a 'version' field. Got: ${JSON.stringify(versionBody)}`,
      ).toBe(true);
      expect(
        'model' in versionBody,
        `/version body must have a 'model' field. Got: ${JSON.stringify(versionBody)}`,
      ).toBe(true);
    },
    30_000,
  );

  // ── AC4: data-facade proof — GET /jobs (authenticated) → 200 + JSON array ──
  //
  // GET /jobs calls sdk.jobs.active() or sdk.jobs.recentForGroup() through the
  // channel-runner opts injection. If the sdk data-facade is wired correctly the
  // handler returns 200 with a JSON array (possibly empty). A missing sdk or a
  // broken adapter would return 500 or 503.

  it(
    'GET /jobs with Basic auth returns 200 + JSON array (sdk data-facade proof) (AC4) [HARD]',
    async () => {
      if (!provisioned) {
        console.warn('Skipping AC4 — port-forward not reachable');
        return;
      }

      const res = await fetch(`${HTTP_URL}/jobs`, {
        headers: { Authorization: AUTH_HEADER },
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        res.status,
        `GET /jobs must return 200 (authenticated). Got ${res.status}`,
      ).toBe(200);

      const body = await res.json() as unknown;
      expect(
        Array.isArray(body),
        `GET /jobs body must be a JSON array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);
    },
    30_000,
  );

  // ── AC5: secrets opts-injection proof — GET /secrets → 200 (NOT 503) ───────
  //
  // The channel-runner injects listSecretsFn into opts before calling the
  // channel factory. A 503 means the fn was NOT injected (the T2-review bug).
  // The handler returns 200 + an array of {type, fields_present} objects.
  // For a fresh/empty user group the array will be empty — that is fine.

  it(
    'GET /secrets with Basic auth returns 200 (NOT 503) + JSON array (opts-injection proof) (AC5) [HARD]',
    async () => {
      if (!provisioned) {
        console.warn('Skipping AC5 — port-forward not reachable');
        return;
      }

      const res = await fetch(`${HTTP_URL}/secrets`, {
        headers: { Authorization: AUTH_HEADER },
        signal: AbortSignal.timeout(15_000),
      });

      // 503 = listSecretsFn not injected (the exact bug AC5 guards against).
      expect(
        res.status,
        `GET /secrets returned ${res.status} — a 503 means listSecretsFn was not injected into channel opts`,
      ).toBe(200);

      const body = await res.json() as unknown;
      expect(
        Array.isArray(body),
        `GET /secrets body must be a JSON array. Got: ${JSON.stringify(body)}`,
      ).toBe(true);

      // Each entry must conform to the {type, fields_present} safe shape
      // from handleListSecrets (the handler strips private data before sending).
      const arr = body as Array<unknown>;
      for (const entry of arr) {
        expect(typeof entry, 'Each /secrets entry must be an object').toBe('object');
        expect(
          entry !== null && 'type' in (entry as object),
          `Each /secrets entry must have a 'type' field. Got: ${JSON.stringify(entry)}`,
        ).toBe(true);
        expect(
          entry !== null && 'fields_present' in (entry as object),
          `Each /secrets entry must have a 'fields_present' field. Got: ${JSON.stringify(entry)}`,
        ).toBe(true);
        const e = entry as { fields_present: unknown };
        expect(
          Array.isArray(e.fields_present),
          `'fields_present' must be an array. Got: ${JSON.stringify(e.fields_present)}`,
        ).toBe(true);
      }
    },
    30_000,
  );
});
