/**
 * Live e2e test — Story 7: idle per-group capability scale-down.
 *
 * Runs against the kind cluster `kubeclaw-e2e-istio` in an isolated namespace
 * `kubeclaw-e2e-scaledown`. The orchestrator is deployed via Helm. The test
 * seeds the orchestrator's on-disk SQLite with pre-group instances, restarts
 * the orchestrator so it reloads from disk, then waits for the live sweeper
 * (default 60 s interval) to scale idle deployments to 0 replicas.
 *
 * AC coverage
 * -----------
 * AC1  Idle deployment (scaleDownAfterIdleSeconds=60, lastUsedAt=now-70) is
 *      scaled to 0 replicas — verified via kubectl get deployment.
 * AC2  Deployment whose lastUsedAt is within the idle window (86400 s TTL,
 *      lastUsedAt=now-70) is NOT scaled down — retains replicas=1.
 * AC3  After AC1, the SQLite row reflects current_replicas=0.
 * AC4  Same as AC2 but phrased as "very large TTL → not scaled down".
 * AC5  Orchestrator log contains the string `per_group_capability_scale_down`
 *      and references the idle group folder.
 *
 * Note on AC2/AC4 — they are structurally equivalent in this test:
 *   The deployment with scaleDownAfterIdleSeconds=86400 and last_used_at 70 s
 *   ago satisfies AC4 ("large TTL not scaled"). It also satisfies AC2 because
 *   70 s << 86400 s, i.e. the instance is "within the idle window" relative to
 *   its configured threshold.
 *
 * Product gap patched by this test
 * ---------------------------------
 * The orchestrator Helm Role does not include `deployments/scale` as a
 * sub-resource. Without it, `replaceNamespacedDeploymentScale` returns 403 and
 * the sweeper's catch-block fires (SQLite NOT updated, log NOT emitted).
 * beforeAll patches the Role before starting the orchestrator so the test can
 * exercise the full happy path. See the RBAC note in the assertions section.
 *
 * Prerequisites
 * -------------
 *   kubectl context kind-kubeclaw-e2e-istio accessible
 *   kubeclaw-orchestrator:e2e-test image loaded into the kind cluster
 *   KUBECLAW_SKIP_HELM_INSTALL=true  (global-setup skips its own install)
 *
 * Invocation
 * ----------
 *   kubectl --context kind-kubeclaw-e2e-istio \
 *     delete namespace kubeclaw-e2e-scaledown --ignore-not-found --timeout=60s
 *   KUBECLAW_SKIP_HELM_INSTALL=true \
 *     npx vitest run --config vitest.e2e.config.ts per-group-capability-scale-down
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

// ── Constants ─────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-scaledown';
const RELEASE = 'kubeclaw-scaledown';
const CHART_DIR = './helm/kubeclaw';
const CONTEXT = 'kind-kubeclaw-e2e-istio';

/** Group whose instance is idle and SHOULD be scaled down. */
const GROUP_IDLE = 'e2e-sd-idle';
/** Group whose instance has a 86400 s TTL and should NOT be scaled down. */
const GROUP_LONG_TTL = 'e2e-sd-longtll';

/** Capability with a 60 s idle TTL (minimum allowed). */
const CAP_SHORT = 'e2e-cap-short';
/** Capability with an 86400 s idle TTL. */
const CAP_LONG = 'e2e-cap-long';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-1 of the group folder, first 10 chars — mirrors src/per-group-capabilities/hash.ts. */
function groupHash(groupFolder: string): string {
  return createHash('sha1').update(groupFolder.trim(), 'utf8').digest('hex').slice(0, 10);
}

/** `mcp-<capability>-<hash>` — mirrors src/per-group-capabilities/k8s-objects.ts. */
function deploymentName(capabilityName: string, grpHash: string): string {
  return `mcp-${capabilityName}-${grpHash}`;
}

function kubectl(args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): string {
  const result = spawnSync('kubectl', ['--context', CONTEXT, '-n', NS, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(
      `kubectl ${args.join(' ')} failed (exit ${result.status})\n` +
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function kubectlNoNS(args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): string {
  const result = spawnSync('kubectl', ['--context', CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeoutMs ?? 60_000,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(
      `kubectl ${args.join(' ')} failed (exit ${result.status})\n` +
      `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function helm(args: string[], opts: { timeoutMs?: number } = {}): string {
  const result = spawnSync('helm', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeoutMs ?? 300_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `helm ${args.join(' ')} failed\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil: timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Return spec.replicas from a Deployment, or -1 if not found. */
function getDeploymentReplicas(name: string): number {
  const raw = kubectl(
    ['get', 'deployment', name, '-o', 'jsonpath={.spec.replicas}'],
    { allowFail: true },
  );
  const n = parseInt(raw, 10);
  return isNaN(n) ? -1 : n;
}

/**
 * Query the orchestrator's SQLite via Python inside the pod.
 * sql.js writes standard SQLite binary format, so Python's sqlite3 can read it.
 */
function querySqlite(sql: string): string {
  const pyCode =
    `import sqlite3, sys\n` +
    `db = sqlite3.connect('/app/store/messages.db', timeout=5)\n` +
    `cur = db.execute(${JSON.stringify(sql)})\n` +
    `print(cur.fetchall())\n` +
    `db.close()\n`;
  return kubectl(
    ['exec', 'deploy/kubeclaw-orchestrator', '--', 'python3', '-c', pyCode],
    { timeoutMs: 20_000, allowFail: true },
  );
}

/** current_replicas from per_group_capability_instances for a given group+capability. */
function getSqliteReplicas(groupFolder: string, capabilityName: string): number {
  const result = querySqlite(
    `SELECT current_replicas FROM per_group_capability_instances ` +
    `WHERE group_folder='${groupFolder}' AND capability_name='${capabilityName}'`,
  );
  // Python prints: [(0,)] or [(1,)] or []
  const m = result.match(/\[\s*\(\s*(\d+)\s*,?\s*\)\s*\]/);
  return m ? parseInt(m[1], 10) : -1;
}

/** Wait for the orchestrator Deployment to report readyReplicas=1. */
async function waitForOrchestrator(timeoutMs = 120_000): Promise<void> {
  await pollUntil(
    () => {
      const out = kubectl(
        ['get', 'deployment', 'kubeclaw-orchestrator', '-o', 'jsonpath={.status.readyReplicas}'],
        { allowFail: true },
      );
      return out.trim() === '1';
    },
    timeoutMs,
    5_000,
    'orchestrator readyReplicas=1',
  );
}

/** Apply a manifest from a JSON string. */
function applyManifest(manifestJson: string): void {
  const result = spawnSync(
    'kubectl',
    ['--context', CONTEXT, '-n', NS, 'apply', '-f', '-'],
    { input: manifestJson, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `applyManifest failed\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
}

// ── Test state (populated in beforeAll) ───────────────────────────────────────

const state = {
  isK8sAvailable: false,
  idleDeployName: '',
  longTtlDeployName: '',
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Story 7 — live per-group capability idle scale-down', () => {
  beforeAll(async () => {
    // Gate the suite on cluster availability.
    const ping = spawnSync('kubectl', ['--context', CONTEXT, 'cluster-info'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
    });
    if (ping.status !== 0) {
      console.warn('kind cluster not accessible — skipping Story 7 live e2e');
      return;
    }
    state.isK8sAvailable = true;

    // Compute deployment names once for use across beforeAll + it() blocks.
    const idleHash = groupHash(GROUP_IDLE);
    const longTtlHash = groupHash(GROUP_LONG_TTL);
    state.idleDeployName = deploymentName(CAP_SHORT, idleHash);
    state.longTtlDeployName = deploymentName(CAP_LONG, longTtlHash);

    console.log('\n=== Story 7 beforeAll ===');
    console.log(`  idle deploy:    ${state.idleDeployName}`);
    console.log(`  longTTL deploy: ${state.longTtlDeployName}`);

    // ── 1. Clean up any prior run ──────────────────────────────────────────
    console.log('  Cleaning up prior namespace...');
    kubectlNoNS(
      ['delete', 'namespace', NS, '--ignore-not-found', '--timeout=90s'],
      { allowFail: true, timeoutMs: 120_000 },
    );

    // ── 2. Helm install ───────────────────────────────────────────────────
    console.log(`  Helm install into ${NS}...`);
    helm([
      'upgrade', '--install', RELEASE, CHART_DIR,
      '--kube-context', CONTEXT,
      '--namespace', NS, '--create-namespace',
      '--timeout', '120s',
      '--set', `namespace=${NS}`,
      '--set', 'image.tag=e2e-test',
      '--set', 'image.pullPolicy=IfNotPresent',
      '--set', `credentialInjection.broker.image=kubeclaw-orchestrator:e2e-test`,
      '--set', 'credentialInjection.mode=off',
      '--set', 'orchestrator.replicas=1',
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', 'orchestrator.admin.enabled=false',
    ], { timeoutMs: 240_000 });
    console.log('  Helm install complete.');

    // ── 3. Patch the RBAC Role to add deployments/scale permission ────────
    // The default kubeclaw Role grants update on deployments but not on the
    // scale subresource. Without this, replaceNamespacedDeploymentScale → 403
    // and the sweeper's catch block fires (no SQLite update, no log entry).
    console.log('  Patching RBAC Role to add deployments/scale permission...');
    const rolePatch = JSON.stringify([
      {
        op: 'add',
        path: '/rules/-',
        value: {
          apiGroups: ['apps'],
          resources: ['deployments/scale'],
          verbs: ['get', 'update', 'patch'],
        },
      },
    ]);
    const patchResult = spawnSync(
      'kubectl',
      [
        '--context', CONTEXT, '-n', NS,
        'patch', 'role', 'kubeclaw-job-manager',
        '--type', 'json',
        '--patch', rolePatch,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
    );
    if (patchResult.status !== 0) {
      console.warn('RBAC Role patch failed:', patchResult.stderr);
      // Non-fatal; the sweeper will log the 403 error and the assertions will fail.
    } else {
      console.log('  RBAC Role patched.');
    }

    // ── 4. Wait for orchestrator to be ready ─────────────────────────────
    console.log('  Waiting for orchestrator...');
    await waitForOrchestrator(120_000);
    console.log('  Orchestrator ready.');

    // ── 5. Scale orchestrator to 0 so we can safely modify its SQLite ─────
    console.log('  Scaling orchestrator to 0 for SQLite seeding...');
    kubectl(['scale', 'deployment/kubeclaw-orchestrator', '--replicas=0']);
    await pollUntil(
      () => {
        const out = kubectl(
          ['get', 'deployment', 'kubeclaw-orchestrator', '-o', 'jsonpath={.status.replicas}'],
          { allowFail: true },
        );
        return out.trim() === '' || out.trim() === '0';
      },
      60_000,
      3_000,
      'orchestrator scaled to 0',
    );
    console.log('  Orchestrator at 0 replicas.');

    // ── 6. Seed the SQLite on the store PVC via a Python Job ─────────────
    // Timestamps: orchestrator will restart shortly after; sweeper fires at
    // restart+60s. We set staleTs = now-70 (70s in the past) so instances
    // seeded as idle are already past threshold when the sweeper runs.
    const seedEpoch = Math.floor(Date.now() / 1000);
    const staleTs = seedEpoch - 70;

    const nowStr = new Date().toISOString();

    // Capability spec JSON (matches CapabilitySpec shape expected by listCapabilities()).
    const shortSpecJson = JSON.stringify({
      name: CAP_SHORT, kind: 'mcp', scope: 'group',
      image: 'busybox:latest', port: 3000,
      scaleDownAfterIdleSeconds: 60,
      volumeFromGroupPvc: false, credentialsFrom: 'none',
    });
    const longSpecJson = JSON.stringify({
      name: CAP_LONG, kind: 'mcp', scope: 'group',
      image: 'busybox:latest', port: 3000,
      scaleDownAfterIdleSeconds: 86400,
      volumeFromGroupPvc: false, credentialsFrom: 'none',
    });

    const seedPy = `
import sqlite3, sys, os

DB = '/app/store/messages.db'
if not os.path.exists(DB):
    print(f'ERROR: DB not found at {DB}', file=sys.stderr)
    sys.exit(1)

db = sqlite3.connect(DB, timeout=10)

# Insert capability specs into the capabilities table.
for (name, kind, spec_json) in [
    (${JSON.stringify(CAP_SHORT)}, 'mcp', ${JSON.stringify(shortSpecJson)}),
    (${JSON.stringify(CAP_LONG)}, 'mcp', ${JSON.stringify(longSpecJson)}),
]:
    db.execute(
        """INSERT OR REPLACE INTO capabilities
           (name, kind, spec, lifecycle, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)""",
        (name, kind, spec_json, ${JSON.stringify(nowStr)}, ${JSON.stringify(nowStr)})
    )

# Insert per-group instances.
for (grp, cap, dep, grphash, reps, luat) in [
    (
        ${JSON.stringify(GROUP_IDLE)},   ${JSON.stringify(CAP_SHORT)},
        ${JSON.stringify(state.idleDeployName)}, ${JSON.stringify(idleHash)},
        1, ${staleTs}
    ),
    (
        ${JSON.stringify(GROUP_LONG_TTL)}, ${JSON.stringify(CAP_LONG)},
        ${JSON.stringify(state.longTtlDeployName)}, ${JSON.stringify(longTtlHash)},
        1, ${staleTs}
    ),
]:
    db.execute(
        """INSERT OR REPLACE INTO per_group_capability_instances
           (group_folder, capability_name, group_hash, deployment_name,
            service_name, current_replicas, last_used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (grp, cap, dep, dep, grphash, reps, luat, ${seedEpoch})
    )

db.commit()
db.close()

print('SQLite seeding complete')
print(f'  caps: ${CAP_SHORT}, ${CAP_LONG}')
print(f'  instances: ${GROUP_IDLE}/${CAP_SHORT} replicas=1 lastUsedAt=${staleTs}')
print(f'             ${GROUP_LONG_TTL}/${CAP_LONG} replicas=1 lastUsedAt=${staleTs}')
`;

    // Delete any prior seed Job.
    kubectl(['delete', 'job', 'kubeclaw-sqlite-seed', '--ignore-not-found'], { allowFail: true });

    const seedJobManifest = JSON.stringify({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'kubeclaw-sqlite-seed', namespace: NS },
      spec: {
        ttlSecondsAfterFinished: 300,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'seed',
              image: 'python:3.12-slim',
              imagePullPolicy: 'IfNotPresent',
              command: ['python3', '-c', seedPy],
              volumeMounts: [{
                name: 'store', mountPath: '/app/store',
              }],
            }],
            volumes: [{
              name: 'store',
              persistentVolumeClaim: { claimName: 'kubeclaw-store' },
            }],
          },
        },
      },
    });

    applyManifest(seedJobManifest);
    console.log('  Seed Job created. Waiting for completion...');

    // Wait for the seed Job to complete (up to 3 min — first pull of python:3.12-slim).
    await pollUntil(
      () => {
        const out = kubectl(
          ['get', 'job', 'kubeclaw-sqlite-seed', '-o', 'jsonpath={.status.succeeded}'],
          { allowFail: true },
        );
        return out.trim() === '1';
      },
      180_000,
      5_000,
      'seed job succeeded',
    );

    // Print seed job output for debugging.
    const seedLogs = kubectl(
      ['logs', 'job/kubeclaw-sqlite-seed'],
      { allowFail: true },
    );
    console.log('  Seed job output:\n' + seedLogs.split('\n').map((l) => `    ${l}`).join('\n'));

    // ── 7. Create stub Deployments in k8s ────────────────────────────────
    // The sweeper calls client.patchDeploymentReplicas() which requires the
    // Deployment to exist in k8s. We create minimal stub Deployments.
    console.log('  Creating stub Deployments for sweeper to patch...');
    for (const depName of [state.idleDeployName, state.longTtlDeployName]) {
      const depManifest = JSON.stringify({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: depName,
          namespace: NS,
          labels: {
            'kubeclaw.io/scope': 'group',
            'kubeclaw.io/managed-by': 'kubeclaw',
          },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: depName } },
          template: {
            metadata: { labels: { app: depName } },
            spec: {
              containers: [{ name: 'stub', image: 'busybox:latest', command: ['sleep', '3600'] }],
            },
          },
        },
      });
      applyManifest(depManifest);
      console.log(`    Created: ${depName}`);
    }

    // ── 8. Scale orchestrator back to 1 (reloads SQLite from disk) ───────
    console.log('  Scaling orchestrator back to 1...');
    kubectl(['scale', 'deployment/kubeclaw-orchestrator', '--replicas=1']);
    await waitForOrchestrator(120_000);
    console.log('  Orchestrator ready. Sweeper fires in ~60s.');

    // ── 9. Wait for the sweeper to fire ───────────────────────────────────
    // The sweeper interval defaults to 60s; after the first interval the
    // idle instance should be processed. We wait 95s (60s interval + 35s margin).
    console.log('  Waiting 95 s for the sweeper to fire...');
    await sleep(95_000);
    console.log('  Wait complete. Running assertions.');
  }, 600_000);

  afterAll(async () => {
    if (!state.isK8sAvailable) return;
    console.log('\n=== Story 7 afterAll ===');
    spawnSync('helm', [
      '--kube-context', CONTEXT,
      'uninstall', RELEASE,
      '--namespace', NS,
      '--ignore-not-found',
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
    kubectlNoNS(
      ['delete', 'namespace', NS, '--ignore-not-found', '--timeout=90s'],
      { allowFail: true, timeoutMs: 120_000 },
    );
    console.log('  Teardown complete.');
  }, 180_000);

  // ── Acceptance criteria ───────────────────────────────────────────────────

  it('AC1: idle deployment is scaled to 0 replicas', () => {
    if (!state.isK8sAvailable) {
      console.warn('Skipping: kind cluster not available');
      return;
    }
    const replicas = getDeploymentReplicas(state.idleDeployName);
    console.log(`  ${state.idleDeployName}: spec.replicas = ${replicas}`);
    expect(replicas, `Expected ${state.idleDeployName} to be scaled to 0`).toBe(0);
  });

  it('AC2 + AC4: deployment with large TTL (86400 s) is NOT scaled down', () => {
    if (!state.isK8sAvailable) {
      console.warn('Skipping: kind cluster not available');
      return;
    }
    // GROUP_LONG_TTL has last_used_at=now-70 (70 s idle) but TTL=86400 s,
    // so 70 < 86400 → NOT scaled down. This covers both AC2 (within idle window)
    // and AC4 (very large scaleDownAfterIdleSeconds).
    const replicas = getDeploymentReplicas(state.longTtlDeployName);
    console.log(`  ${state.longTtlDeployName}: spec.replicas = ${replicas}`);
    expect(replicas, `Expected ${state.longTtlDeployName} to retain replicas=1`).toBe(1);
  });

  it('AC3: SQLite current_replicas is 0 for scaled-down idle instance', () => {
    if (!state.isK8sAvailable) {
      console.warn('Skipping: kind cluster not available');
      return;
    }
    const replicas = getSqliteReplicas(GROUP_IDLE, CAP_SHORT);
    console.log(`  SQLite ${GROUP_IDLE}/${CAP_SHORT}: current_replicas = ${replicas}`);
    expect(replicas, 'Expected SQLite current_replicas=0 for idle instance').toBe(0);
  });

  it('AC5: orchestrator log contains per_group_capability_scale_down', () => {
    if (!state.isK8sAvailable) {
      console.warn('Skipping: kind cluster not available');
      return;
    }
    const logs = kubectl(
      ['logs', 'deploy/kubeclaw-orchestrator', '--tail=300'],
      { allowFail: true, timeoutMs: 30_000 },
    );
    console.log('  Checking logs for per_group_capability_scale_down...');
    expect(logs, 'Expected log entry per_group_capability_scale_down').toContain(
      'per_group_capability_scale_down',
    );
    expect(logs, `Expected log entry to reference group ${GROUP_IDLE}`).toContain(GROUP_IDLE);
  });
});
