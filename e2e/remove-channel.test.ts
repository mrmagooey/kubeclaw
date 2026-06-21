/**
 * E2E: remove_channel admin shell tool
 *
 * Tests that remove_channel deletes ALL resources a real channel instance owns,
 * across both install front-ends. The fixture provisions resources with the
 * REAL names the install paths produce (Deployment, both Secret naming
 * conventions, Service, NetworkPolicy, and the four standard PVCs) — crucially
 * WITHOUT the `kubeclaw-channel` label, because the actual install paths do not
 * label these resources. This proves remove_channel finds + deletes them by
 * name (the previous label-based deletion matched nothing and orphaned them).
 *
 * Requires: kind cluster `kubeclaw-e2e-istio` with kubeclaw installed
 *   (kubectl context = kind-kubeclaw-e2e-istio, namespace = kubeclaw).
 *   Image `kubeclaw-orchestrator:e2e-test` must be pre-loaded into kind.
 * Does NOT require a live LLM — calls executeTool() directly via kubectl exec.
 *
 * Run:
 *   docker build -t kubeclaw-orchestrator:e2e-test .
 *   docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar
 *   kind load image-archive /tmp/orch.tar --name kubeclaw-e2e-istio
 *   kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw --ignore-not-found --timeout=60s
 *   kubectl config use-context kind-kubeclaw-e2e-istio
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts remove-channel
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw';
const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw';

// Use a unique instance name per test run to avoid Deployment selector
// immutability conflicts if the namespace is not wiped between runs.
const INSTANCE_SUFFIX = Math.random().toString(36).slice(2, 7);
const INSTANCE_NAME = `http-removetest-${INSTANCE_SUFFIX}`;
const BASE = `kubeclaw-channel-${INSTANCE_NAME}`;
const DEPLOYMENT_NAME = BASE;
// Both real Secret naming conventions the install paths use.
const SECRET_HELM = BASE; // declarative Helm user secret
const SECRET_BOOTSTRAP = `${BASE}-credentials`; // bootstrap credentials
const SERVICE_NAME = BASE; // httpPort channel Service
const INGRESS_NAME = BASE; // Helm Ingress (ingress.enabled)
const NETPOL_NAME = `${BASE}-ingress`; // httpPort ingress NetworkPolicy
const PVC_NAMES = [
  `${BASE}-groups`,
  `${BASE}-store`,
  `${BASE}-sessions`,
  `${BASE}-runtime`,
];
// Every resource the fixture creates — used for assertions + teardown.
const ALL_RESOURCES: Array<[kind: string, name: string]> = [
  ['deployment', DEPLOYMENT_NAME],
  ['secret', SECRET_HELM],
  ['secret', SECRET_BOOTSTRAP],
  ['service', SERVICE_NAME],
  ['ingress', INGRESS_NAME],
  ['networkpolicy', NETPOL_NAME],
  ...PVC_NAMES.map((p) => ['pvc', p] as [string, string]),
];

const RESOURCE_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// ── Skip guard ──────────────────────────────────────────────────────────────────
// Skip the whole suite if the kind cluster context is not present.

const contextAvailable =
  spawnSync('kubectl', ['config', 'get-contexts', KUBE_CONTEXT], {
    stdio: 'pipe',
  }).status === 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run kubectl with --context=KUBE_CONTEXT and return result. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
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
 * Call executeTool inside the orchestrator pod via kubectl exec.
 * Uses dynamic import of the compiled admin-shell.js — no LLM needed.
 */
function runAdminTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const script = `import('/app/dist/admin-shell.js').then(async m => {
  const result = await m.executeTool(${JSON.stringify(toolName)}, ${JSON.stringify(input)});
  process.stdout.write(result + '\\n');
}).catch(e => {
  process.stderr.write(String(e) + '\\n');
  process.exit(1);
});`;

  const r = spawnSync(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      '-n',
      NAMESPACE,
      'exec',
      'deployment/kubeclaw-orchestrator',
      '-c',
      'orchestrator',
      '--',
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: opts.timeout ?? 60_000,
    },
  );
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Poll condition until it returns true, or throw on timeout. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** True when the named resource no longer exists in the namespace. */
function resourceAbsent(kind: string, name: string): boolean {
  const r = kc([
    'get',
    kind,
    name,
    '-n',
    NAMESPACE,
    '--ignore-not-found',
    '-o',
    'name',
  ]);
  return r.ok && r.stdout.trim() === '';
}

// ── Suite setup / teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  if (!contextAvailable) return; // suite is skipped — nothing to set up

  const helmStatus = spawnSync(
    'helm',
    [
      '--kube-context',
      KUBE_CONTEXT,
      'status',
      RELEASE,
      '--namespace',
      NAMESPACE,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (helmStatus.status !== 0) {
    console.log(`Installing kubeclaw into ${KUBE_CONTEXT}...`);
    kc(['create', 'namespace', NAMESPACE]);
    const install = spawnSync(
      'helm',
      [
        '--kube-context',
        KUBE_CONTEXT,
        'upgrade',
        '--install',
        RELEASE,
        CHART_DIR,
        '--namespace',
        NAMESPACE,
        '--timeout',
        '120s',
        '--set',
        `namespace=${NAMESPACE}`,
        '--set',
        'secrets.anthropicApiKey=test-key',
        '--set',
        'redis.password=e2e-test-pass',
        '--set',
        'image.tag=e2e-test',
        '--set',
        'image.pullPolicy=Never',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 180_000 },
    );
    if (install.status !== 0) {
      throw new Error(
        `helm install failed:\nstdout: ${install.stdout}\nstderr: ${install.stderr}`,
      );
    }
  }

  console.log('Waiting for kubeclaw-orchestrator to be Ready...');
  await waitUntil(
    () => {
      const r = kc([
        'get',
        'deployment',
        'kubeclaw-orchestrator',
        '-n',
        NAMESPACE,
        '-o',
        'jsonpath={.status.readyReplicas}',
      ]);
      return r.ok && r.stdout.trim() === '1';
    },
    120_000,
    'kubeclaw-orchestrator readyReplicas=1',
  );
  console.log('kubeclaw-orchestrator is Ready');
}, 180_000);

afterAll(() => {
  if (!contextAvailable) return;
  // Best-effort cleanup of any test channel resources left by a failed run.
  for (const [kind, name] of ALL_RESOURCES) {
    kc(['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found']);
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe.skipIf(!contextAvailable)(
  `remove_channel admin shell tool (instance: ${INSTANCE_NAME})`,
  () => {
    it(
      'provisions a real channel (Deployment, both Secrets, Service, NetworkPolicy, PVCs) — UNLABELLED',
      async () => {
        // Real channel resource names, with NO kubeclaw-channel label — exactly
        // as the declarative-Helm + bootstrap install paths produce them. This
        // is what the previous label-based remove_channel failed to clean up.
        const pvcDocs = PVC_NAMES.map(
          (name) => `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi`,
        ).join('\n---');

        const fixtureManifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEPLOYMENT_NAME}
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DEPLOYMENT_NAME}
  template:
    metadata:
      labels:
        app: ${DEPLOYMENT_NAME}
    spec:
      containers:
        - name: channel
          image: kubeclaw-orchestrator:e2e-test
          imagePullPolicy: Never
          command: ["sleep", "infinity"]
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_HELM}
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  users: "testuser:testpass"
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_BOOTSTRAP}
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  users: "testuser:testpass"
---
apiVersion: v1
kind: Service
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
spec:
  selector:
    app: ${DEPLOYMENT_NAME}
  ports:
    - name: http
      port: 80
      targetPort: 4080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${NETPOL_NAME}
  namespace: ${NAMESPACE}
spec:
  podSelector:
    matchLabels:
      app: ${DEPLOYMENT_NAME}
  policyTypes: [Ingress]
  ingress:
    - from: []
      ports:
        - protocol: TCP
          port: 4080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${INGRESS_NAME}
  namespace: ${NAMESPACE}
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${SERVICE_NAME}
                port:
                  number: 80
---${pvcDocs}
`;
        const apply = spawnSync(
          'kubectl',
          ['--context', KUBE_CONTEXT, 'apply', '-f', '-'],
          {
            input: fixtureManifest,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 60_000,
          },
        );
        expect(
          apply.status,
          `kubectl apply fixture failed:\nstdout: ${apply.stdout}\nstderr: ${apply.stderr}`,
        ).toBe(0);

        // All fixture resources must exist before removal.
        await waitUntil(
          () => kc(['get', 'deployment', DEPLOYMENT_NAME, '-n', NAMESPACE]).ok,
          RESOURCE_READY_TIMEOUT_MS,
          `Deployment ${DEPLOYMENT_NAME} to exist`,
        );
        for (const [kind, name] of ALL_RESOURCES) {
          const check = kc(['get', kind, name, '-n', NAMESPACE]);
          expect(check.ok, `${kind}/${name} not created:\n${check.stderr}`).toBe(
            true,
          );
        }
      },
      RESOURCE_READY_TIMEOUT_MS + 30_000,
    );

    it(
      'remove_channel deletes EVERY resource (Deployment, both Secrets, Service, NetworkPolicy, all PVCs)',
      async () => {
        const result = runAdminTool(
          'remove_channel',
          { instanceName: INSTANCE_NAME },
          { timeout: 60_000 },
        );

        expect(
          result.ok,
          `remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);

        const output = result.stdout;
        expect(output, 'Expected "Deleted:" in output').toContain('Deleted:');
        // Every fixture resource must appear as deleted in the tool's summary.
        for (const [kind, name] of ALL_RESOURCES) {
          expect(output, `Expected ${kind}/${name} in remove output`).toContain(
            name,
          );
        }

        // Poll until every resource is fully gone from the API server (PVCs may
        // linger Terminating while the pod releases them).
        await waitUntil(
          () => ALL_RESOURCES.every(([kind, name]) => resourceAbsent(kind, name)),
          60_000,
          'all channel resources fully absent after remove_channel',
        );
      },
      90_000,
    );

    it(
      'idempotent — second remove_channel call reports everything already absent',
      () => {
        const result = runAdminTool(
          'remove_channel',
          { instanceName: INSTANCE_NAME },
          { timeout: 30_000 },
        );

        expect(
          result.ok,
          `second remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);

        const output = result.stdout;
        expect(output, 'Expected "Already absent:" in output').toContain(
          'Already absent:',
        );
        expect(
          output,
          'Should not contain "Deleted:" on second call',
        ).not.toMatch(/^Deleted:/m);
      },
      30_000,
    );
  },
);
