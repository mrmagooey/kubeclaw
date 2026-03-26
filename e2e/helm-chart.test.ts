/**
 * Helm chart e2e tests.
 *
 * Verifies that `helm install kubeclaw ./helm/kubeclaw` correctly deploys all
 * infrastructure resources and that they behave as expected.
 *
 * Runs against a live minikube cluster (handled by global-setup.ts).
 * Uses an isolated namespace so it never interferes with a production
 * `kubeclaw` deployment.
 *
 * Structure
 * ─────────
 * 1. Static checks  — helm lint / template (no cluster required)
 * 2. Install        — helm install into kubeclaw-helm-test namespace
 * 3. Resources      — assert every manifest was applied correctly
 * 4. Redis          — port-forward + ioredis ping to verify real connectivity
 * 5. Orchestrator   — deployment readiness (skipped when image is absent)
 * 6. Upgrade        — helm upgrade smoke-test (maxConcurrentJobs change)
 * 7. Teardown       — helm uninstall + namespace delete (always runs)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'child_process';
import { requireKubernetes } from './setup.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw-helm-test';
const NAMESPACE = 'kubeclaw-helm-test';
const PORT_FORWARD_LOCAL_PORT = 16380; // separate from global-setup's 16379
const TEST_REDIS_PASSWORD = 'test-redis-password-e2e';

// Timeouts (ms) — allow time for image pulls on fresh clusters
const REDIS_READY_TIMEOUT = 60_000;
const DEPLOYMENT_READY_TIMEOUT = 60_000;
const PVC_BIND_TIMEOUT = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run kubectl against our test namespace; throw if it exits non-zero. */
function kc(args: string[]): string {
  const result = spawnSync('kubectl', [...args, '-n', NAMESPACE], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `kubectl ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/** kubectl without throwing — returns stdout and exit code. */
function kcSafe(args: string[]): { stdout: string; exitCode: number } {
  const result = spawnSync('kubectl', [...args, '-n', NAMESPACE], {
    encoding: 'utf8',
  });
  return { stdout: (result.stdout ?? '').trim(), exitCode: result.status ?? 1 };
}

/** kubectl at cluster scope (no namespace flag). */
function kcCluster(args: string[]): { stdout: string; exitCode: number } {
  const result = spawnSync('kubectl', args, { encoding: 'utf8' });
  return { stdout: (result.stdout ?? '').trim(), exitCode: result.status ?? 1 };
}

/** Parse JSON returned by `kubectl get <resource> -o json`. */
function getJson(resource: string): Record<string, unknown> {
  return JSON.parse(kc(['get', resource, '-o', 'json']));
}

/** Poll until fn() returns true or timeout expires. */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** True if minikube has a local image matching the given tag prefix. */
function minikubeHasImage(name: string): boolean {
  const result = spawnSync('minikube', ['image', 'list'], { encoding: 'utf8' });
  return result.status === 0 && (result.stdout ?? '').includes(name);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let portForwardProc: ChildProcess | null = null;
let redisConnected = false;
let orchestratorImagePresent = false;

beforeAll(async () => {
  requireKubernetes();

  // Use minikube context
  spawnSync('kubectl', ['config', 'use-context', 'minikube'], {
    encoding: 'utf8',
  });

  // Clean up any leftover release from a previous interrupted run
  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8',
  });
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true'],
    { encoding: 'utf8', timeout: 60_000 },
  );

  // Pre-create the namespace with helm ownership metadata so helm can manage
  // it (the chart's namespace.yaml PATCHes it with pod-security labels).
  spawnSync('kubectl', ['create', 'namespace', NAMESPACE], { encoding: 'utf8' });
  spawnSync('kubectl', ['label', 'namespace', NAMESPACE,
    'app.kubernetes.io/managed-by=Helm',
  ], { encoding: 'utf8' });
  spawnSync('kubectl', ['annotate', 'namespace', NAMESPACE,
    `meta.helm.sh/release-name=${RELEASE}`,
    `meta.helm.sh/release-namespace=${NAMESPACE}`,
  ], { encoding: 'utf8' });

  // ── Helm install ──────────────────────────────────────────────────────────
  const installResult = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--namespace', NAMESPACE,
      '--timeout', '60s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', `secrets.anthropicApiKey=test-key`,
      '--set', `secrets.claudeCodeOauthToken=test-token`,
      '--set', `redis.password=${TEST_REDIS_PASSWORD}`,
      '--set', 'orchestrator.maxConcurrentJobs=5',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (installResult.status !== 0) {
    console.error('helm install stderr:', installResult.stderr);
    console.error('helm install stdout:', installResult.stdout);
    throw new Error(
      `helm install failed with exit code ${installResult.status}`,
    );
  }

  // ── Wait for Redis pod ────────────────────────────────────────────────────
  await waitUntil(
    () => {
      const { stdout } = kcSafe([
        'get', 'pods',
        '-l', 'app=kubeclaw-redis',
        '-o', 'jsonpath={.items[0].status.phase}',
      ]);
      return stdout === 'Running';
    },
    REDIS_READY_TIMEOUT,
    'Redis pod Running',
  );

  // ── Port-forward Redis for connectivity tests ─────────────────────────────
  portForwardProc = spawn(
    'kubectl',
    [
      'port-forward',
      '-n', NAMESPACE,
      'svc/kubeclaw-redis',
      `${PORT_FORWARD_LOCAL_PORT}:6379`,
    ],
    { stdio: 'ignore', detached: false },
  );
  await sleep(2000);

  try {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(
      `redis://:${TEST_REDIS_PASSWORD}@localhost:${PORT_FORWARD_LOCAL_PORT}`,
      { connectTimeout: 5000, maxRetriesPerRequest: 1, lazyConnect: true },
    );
    await redis.connect();
    await redis.ping();
    await redis.quit();
    redisConnected = true;
  } catch (err) {
    console.warn('Redis port-forward ping failed (non-fatal):', err);
  }

  // ── Check if orchestrator image is available in minikube ──────────────────
  orchestratorImagePresent = minikubeHasImage('kubeclaw-orchestrator');
}, 120_000);

afterAll(async () => {
  if (portForwardProc) {
    portForwardProc.kill();
    portForwardProc = null;
  }

  // Always clean up, even if tests failed
  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}, 60_000);

// ─── 1. Static checks ─────────────────────────────────────────────────────────

describe('helm chart static checks', () => {
  it('passes helm lint', () => {
    const result = spawnSync('helm', ['lint', CHART_DIR], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0 chart(s) failed');
  });

  it('renders all expected resource kinds', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'secrets.claudeCodeOauthToken=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    for (const kind of [
      'Namespace', 'StatefulSet', 'Deployment', 'NetworkPolicy',
      'PersistentVolumeClaim', 'ConfigMap', 'Secret',
      'ServiceAccount', 'Role', 'RoleBinding',
    ]) {
      expect(result.stdout, `missing kind: ${kind}`).toContain(`kind: ${kind}`);
    }
  });

  it('imagePullPolicy is Always when image.registry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'image.registry=registry.example.com',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('registry.example.com/kubeclaw-orchestrator');
    expect(result.stdout).toContain('imagePullPolicy: Always');
  });

  it('omits kubeclaw-secrets when existingSecret is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.existingSecret=my-secret',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('name: my-secret');
    expect(result.stdout).not.toContain('name: kubeclaw-secrets');
  });

  it('omits NetworkPolicy when networkPolicy.enabled is false', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'networkPolicy.enabled=false',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('kind: NetworkPolicy');
  });

  it('injects storageClassName when storage.storageClass is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'storage.storageClass=efs-sc',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('storageClassName: efs-sc');
  });

  it('uses ReadWriteMany for all group PVCs when accessMode is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'storage.accessMode=ReadWriteMany',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ReadWriteMany');
  });
});

// ─── 2. Namespace ─────────────────────────────────────────────────────────────

describe('namespace', () => {
  it('exists with pod-security.kubernetes.io/enforce=privileged', () => {
    const result = kcCluster(['get', 'namespace', NAMESPACE, '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const ns = JSON.parse(result.stdout) as {
      metadata: { labels: Record<string, string> };
    };
    expect(ns.metadata.labels['pod-security.kubernetes.io/enforce']).toBe(
      'privileged',
    );
  });
});

// ─── 3. Secrets ───────────────────────────────────────────────────────────────

describe('secrets', () => {
  it('kubeclaw-secrets contains anthropic-api-key and claude-code-oauth-token', () => {
    const secret = getJson('secret/kubeclaw-secrets') as {
      data: Record<string, string>;
    };
    expect(Object.keys(secret.data)).toContain('anthropic-api-key');
    expect(Object.keys(secret.data)).toContain('claude-code-oauth-token');
  });

  it('kubeclaw-redis contains admin-password matching install value', () => {
    const secret = getJson('secret/kubeclaw-redis') as {
      data: Record<string, string>;
    };
    const decoded = Buffer.from(
      secret.data['admin-password'],
      'base64',
    ).toString();
    expect(decoded).toBe(TEST_REDIS_PASSWORD);
  });
});

// ─── 4. Network policies ──────────────────────────────────────────────────────

describe('network policies', () => {
  it('kubeclaw-agent-policy exists', () => {
    const out = kc(['get', 'networkpolicy', 'kubeclaw-agent-policy']);
    expect(out).toContain('kubeclaw-agent-policy');
  });

  it('kubeclaw-orchestrator-policy exists', () => {
    const out = kc(['get', 'networkpolicy', 'kubeclaw-orchestrator-policy']);
    expect(out).toContain('kubeclaw-orchestrator-policy');
  });

  it('agent policy permits DNS(53), Redis(6379), HTTPS(443) only', () => {
    const policy = getJson('networkpolicy/kubeclaw-agent-policy') as {
      spec: {
        egress: Array<{ ports: Array<{ port: number }> }>;
      };
    };
    const ports = policy.spec.egress.flatMap((r) => r.ports.map((p) => p.port));
    expect(ports).toContain(53);
    expect(ports).toContain(6379);
    expect(ports).toContain(443);
    expect(ports).not.toContain(80);
    expect(ports).not.toContain(22);
  });
});

// ─── 5. Storage ───────────────────────────────────────────────────────────────

describe('persistent volume claims', () => {
  const pvcs: Array<[name: string, size: string]> = [
    ['kubeclaw-groups', '50Gi'],
    ['kubeclaw-sessions', '20Gi'],
    ['kubeclaw-project', '10Gi'],
    ['kubeclaw-store', '1Gi'],
  ];

  for (const [pvcName, expectedSize] of pvcs) {
    it(`${pvcName} is Bound with size ${expectedSize}`, async () => {
      await waitUntil(
        () => {
          const { stdout } = kcSafe([
            'get', 'pvc', pvcName,
            '-o', 'jsonpath={.status.phase}',
          ]);
          return stdout === 'Bound';
        },
        PVC_BIND_TIMEOUT,
        `${pvcName} Bound`,
      );

      const { stdout: phase } = kcSafe([
        'get', 'pvc', pvcName, '-o', 'jsonpath={.status.phase}',
      ]);
      expect(phase).toBe('Bound');

      const { stdout: size } = kcSafe([
        'get', 'pvc', pvcName,
        '-o', 'jsonpath={.spec.resources.requests.storage}',
      ]);
      expect(size).toBe(expectedSize);
    }, PVC_BIND_TIMEOUT + 10_000);
  }
});

// ─── 6. ConfigMaps ────────────────────────────────────────────────────────────

describe('configmaps', () => {
  it('kubeclaw-runner-wrapper has runner-wrapper.sh', () => {
    const cm = getJson('configmap/kubeclaw-runner-wrapper') as {
      data: Record<string, string>;
    };
    expect(cm.data['runner-wrapper.sh']).toBeDefined();
    expect(cm.data['runner-wrapper.sh']).toContain('INPUT_DIR');
    expect(cm.data['runner-wrapper.sh']).toContain('OUTPUT_DIR');
  });

  it('kubeclaw-wrapper-script has runner-wrapper.sh', () => {
    const cm = getJson('configmap/kubeclaw-wrapper-script') as {
      data: Record<string, string>;
    };
    expect(cm.data['runner-wrapper.sh']).toBeDefined();
  });
});

// ─── 7. RBAC ─────────────────────────────────────────────────────────────────

describe('RBAC', () => {
  it('kubeclaw-orchestrator ServiceAccount exists', () => {
    const out = kc(['get', 'serviceaccount', 'kubeclaw-orchestrator']);
    expect(out).toContain('kubeclaw-orchestrator');
  });

  it('kubeclaw-job-manager Role grants Job CRUD and pod log access', () => {
    const role = getJson('role/kubeclaw-job-manager') as {
      rules: Array<{
        apiGroups: string[];
        resources: string[];
        verbs: string[];
      }>;
    };
    const jobRule = role.rules.find(
      (r) => r.apiGroups.includes('batch') && r.resources.includes('jobs'),
    );
    expect(jobRule).toBeDefined();
    for (const verb of ['create', 'get', 'list', 'delete']) {
      expect(jobRule!.verbs).toContain(verb);
    }
    const logRule = role.rules.find(
      (r) =>
        r.apiGroups.includes('') &&
        r.resources.includes('pods/log'),
    );
    expect(logRule).toBeDefined();
    expect(logRule!.verbs).toContain('get');
  });

  it('RoleBinding references correct SA and Role', () => {
    const binding = getJson('rolebinding/kubeclaw-orchestrator-binding') as {
      subjects: Array<{ kind: string; name: string }>;
      roleRef: { name: string };
    };
    expect(binding.roleRef.name).toBe('kubeclaw-job-manager');
    const sa = binding.subjects.find(
      (s) => s.kind === 'ServiceAccount' && s.name === 'kubeclaw-orchestrator',
    );
    expect(sa).toBeDefined();
  });

  it('orchestrator SA can create jobs (auth can-i)', () => {
    const result = kcCluster([
      'auth', 'can-i', 'create', 'jobs',
      '--namespace', NAMESPACE,
      '--as', `system:serviceaccount:${NAMESPACE}:kubeclaw-orchestrator`,
    ]);
    expect(result.stdout).toBe('yes');
  });

  it('orchestrator SA cannot delete namespaces (least-privilege)', () => {
    const result = kcCluster([
      'auth', 'can-i', 'delete', 'namespaces',
      '--namespace', NAMESPACE,
      '--as', `system:serviceaccount:${NAMESPACE}:kubeclaw-orchestrator`,
    ]);
    expect(result.stdout).toBe('no');
  });
});

// ─── 8. Redis ─────────────────────────────────────────────────────────────────

describe('Redis', () => {
  it('StatefulSet has 1 ready replica', async () => {
    await waitUntil(
      () => {
        const { stdout } = kcSafe([
          'get', 'statefulset', 'kubeclaw-redis',
          '-o', 'jsonpath={.status.readyReplicas}',
        ]);
        return stdout === '1';
      },
      REDIS_READY_TIMEOUT,
      'Redis readyReplicas=1',
    );
    const { stdout } = kcSafe([
      'get', 'statefulset', 'kubeclaw-redis',
      '-o', 'jsonpath={.status.readyReplicas}',
    ]);
    expect(stdout).toBe('1');
  }, REDIS_READY_TIMEOUT + 5000);

  it('Service exposes port 6379', () => {
    const svc = getJson('service/kubeclaw-redis') as {
      spec: { ports: Array<{ port: number }> };
    };
    expect(svc.spec.ports.some((p) => p.port === 6379)).toBe(true);
  });

  it('responds to PING via port-forward', async () => {
    if (!redisConnected) {
      console.warn('Skipping: Redis port-forward not available');
      return;
    }
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(
      `redis://:${TEST_REDIS_PASSWORD}@localhost:${PORT_FORWARD_LOCAL_PORT}`,
      { connectTimeout: 5000, maxRetriesPerRequest: 1, lazyConnect: true },
    );
    try {
      await redis.connect();
      expect(await redis.ping()).toBe('PONG');
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  it('supports read/write via port-forward', async () => {
    if (!redisConnected) {
      console.warn('Skipping: Redis port-forward not available');
      return;
    }
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(
      `redis://:${TEST_REDIS_PASSWORD}@localhost:${PORT_FORWARD_LOCAL_PORT}`,
      { connectTimeout: 5000, maxRetriesPerRequest: 1, lazyConnect: true },
    );
    try {
      await redis.connect();
      await redis.set('helm-e2e:smoke', 'ok', 'EX', 30);
      expect(await redis.get('helm-e2e:smoke')).toBe('ok');
      await redis.del('helm-e2e:smoke');
    } finally {
      await redis.quit().catch(() => {});
    }
  });
});

// ─── 9. Orchestrator ──────────────────────────────────────────────────────────

describe('orchestrator deployment', () => {
  it('Deployment manifest exists with correct env vars', () => {
    const dep = getJson('deployment/kubeclaw-orchestrator') as {
      spec: {
        replicas: number;
        template: {
          spec: {
            containers: Array<{
              env: Array<{ name: string; value?: string }>;
            }>;
          };
        };
      };
    };
    expect(dep.spec.replicas).toBe(1);
    const env = dep.spec.template.spec.containers[0].env;
    const get = (name: string) => env.find((e) => e.name === name);

    expect(get('MAX_CONCURRENT_JOBS')?.value).toBe('5');
    expect(get('REDIS_URL')?.value).toContain('kubeclaw-redis');
    expect(get('KUBECLAW_NAMESPACE')?.value).toBe(NAMESPACE);
  });

  it('Deployment becomes ready when orchestrator image is present in minikube', async () => {
    if (!orchestratorImagePresent) {
      console.warn(
        'Skipping orchestrator readiness: kubeclaw-orchestrator image not in minikube.\n' +
          'Load it with:\n' +
          '  docker build -t kubeclaw-orchestrator:latest .\n' +
          '  minikube image load kubeclaw-orchestrator:latest',
      );
      return;
    }
    await waitUntil(
      () => {
        const { stdout } = kcSafe([
          'get', 'deployment', 'kubeclaw-orchestrator',
          '-o', 'jsonpath={.status.readyReplicas}',
        ]);
        return stdout === '1';
      },
      DEPLOYMENT_READY_TIMEOUT,
      'orchestrator readyReplicas=1',
    );
    const { stdout } = kcSafe([
      'get', 'deployment', 'kubeclaw-orchestrator',
      '-o', 'jsonpath={.status.readyReplicas}',
    ]);
    expect(stdout).toBe('1');
  }, DEPLOYMENT_READY_TIMEOUT + 5000);
});

// ─── 10. Helm upgrade ─────────────────────────────────────────────────────────

describe('helm upgrade', () => {
  it('applies maxConcurrentJobs change', () => {
    const result = spawnSync(
      'helm',
      [
        'upgrade', RELEASE, CHART_DIR,
        '--namespace', NAMESPACE,
        '--reuse-values',
        '--set', 'orchestrator.maxConcurrentJobs=8',
        '--timeout', '60s',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );

    if (result.status !== 0) {
      console.error('helm upgrade stderr:', result.stderr);
    }
    expect(result.status).toBe(0);

    const { stdout } = kcSafe([
      'get', 'deployment', 'kubeclaw-orchestrator',
      '-o',
      // eslint-disable-next-line no-useless-escape
      'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="MAX_CONCURRENT_JOBS")].value}',
    ]);
    expect(stdout).toBe('8');
  });

  it('preserves Redis password across upgrade (lookup prevents rotation)', () => {
    const before = kcSafe([
      'get', 'secret', 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]).stdout;

    spawnSync(
      'helm',
      [
        'upgrade', RELEASE, CHART_DIR,
        '--namespace', NAMESPACE,
        '--reuse-values',
        '--timeout', '60s',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );

    const after = kcSafe([
      'get', 'secret', 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]).stdout;

    expect(after).toBe(before);
  });
});
