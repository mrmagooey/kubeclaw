/**
 * Per-test kubeclaw cluster helper.
 *
 * Each e2e test file that needs an isolated namespace + helm release calls
 * `setupTestCluster()` in beforeAll and `handle.teardown()` in afterAll.
 *
 * A single global file-based lock (/tmp/kubeclaw-e2e-cluster.lock) ensures
 * only one such environment exists at any time, even when vitest runs test
 * files in parallel forks. The lock records the holder PID so a crashed
 * fork doesn't deadlock the next one.
 *
 * The helper trusts that `e2e/global-setup.ts` has already built
 * `kubeclaw-orchestrator:latest` and `kubeclaw-agent:latest` into minikube's
 * docker daemon. It does NOT rebuild.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Lock ────────────────────────────────────────────────────────────────────

const LOCK_PATH = join(tmpdir(), 'kubeclaw-e2e-cluster.lock');
const LOCK_POLL_MS = 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0: existence-check only, does not actually signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the global cluster lock. Returns a release function.
 *
 * If the lock file exists, polls until either:
 *   - the file disappears (previous holder released cleanly), OR
 *   - the holder PID is dead (orphaned lock from a crashed fork → steal).
 */
export async function acquireClusterLock(
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      // Lock acquired. Return release function.
      return () => {
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          // Already removed — fine.
        }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Existing lock — check if holder is alive.
      try {
        const holder = parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
        if (Number.isFinite(holder) && !pidIsAlive(holder)) {
          console.warn(
            `[per-test-cluster] Stale lock from pid=${holder} (dead) — stealing`,
          );
          try {
            unlinkSync(LOCK_PATH);
          } catch {
            // Concurrent steal — fine, just retry.
          }
          continue;
        }
      } catch {
        // Race: file disappeared between EEXIST and read. Just retry.
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  throw new Error(
    `[per-test-cluster] Failed to acquire ${LOCK_PATH} within ${timeoutMs}ms — ` +
      `another e2e fork is holding it`,
  );
}

// ─── kubectl / helm helpers ──────────────────────────────────────────────────

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number; allowFailure?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout,
  });
  if (!opts.allowFailure && r.status !== 0) {
    throw new Error(
      `[per-test-cluster] ${cmd} ${args.join(' ')} failed (status=${r.status}):\n` +
        `STDOUT: ${r.stdout ?? ''}\nSTDERR: ${r.stderr ?? ''}`,
    );
  }
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

async function waitFor(
  label: string,
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`[per-test-cluster] Timed out after ${timeoutMs}ms: ${label}`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface HttpChannelSpec {
  /** In-cluster port the channel listens on. Defaults to 4080. */
  httpPort?: number;
  /** Host port to port-forward the channel service to. */
  localPort: number;
  /** Comma-separated 'user:pass,user2:pass2'. */
  users: string;
}

export interface ClusterOpts {
  /** Namespace to install into. Created fresh; deleted on teardown. */
  namespace: string;
  /** Helm release name. Defaults to namespace. */
  releaseName?: string;
  /** Configure an HTTP channel + port-forward it. */
  httpChannel?: HttpChannelSpec;
  /** Optional Redis port-forward (for tests that publish/subscribe directly). */
  redisLocalPort?: number;
  /** Extra `--set key=value` arguments for helm. */
  extraSet?: string[];
  /** helm install timeout (string passed to --timeout, e.g. '180s'). */
  helmTimeout?: string;
  /**
   * Maximum time to wait for the cluster lock. Defaults to 30 min.
   * Lock acquisition happens BEFORE the setup deadline starts, so this
   * is in addition to setupTimeoutMs.
   */
  lockTimeoutMs?: number;
  /** Maximum setup time AFTER the lock is acquired. Defaults to 6 min. */
  setupTimeoutMs?: number;
  /**
   * Which deployments/statefulsets to wait for before returning. Defaults to
   * orchestrator + redis. Add 'channel-http' when httpChannel is set, and
   * 'credential-broker' when credentialInjection.mode != off via extraSet.
   */
  waitForReady?: Array<
    'orchestrator' | 'redis' | 'channel-http' | 'credential-broker'
  >;
  /** Quiet noisy kubectl/helm stdout/stderr in this test. */
  quiet?: boolean;
}

export interface ClusterHandle {
  namespace: string;
  releaseName: string;
  /** Tear down port-forwards, helm uninstall, namespace delete, release lock. */
  teardown(): Promise<void>;
}

const DEFAULT_REDIS_PASSWORD = 'kubeclaw-per-test-redis-pass';

/**
 * Bring up an isolated kubeclaw release in `opts.namespace`. Returns a handle
 * whose `teardown()` reverses everything (helm uninstall, delete namespace,
 * kill port-forwards, release the lock).
 *
 * Caller MUST invoke `teardown()` from afterAll — even on test failure — to
 * avoid leaking the namespace and holding the global lock.
 */
export async function setupTestCluster(
  opts: ClusterOpts,
): Promise<ClusterHandle> {
  const releaseName = opts.releaseName ?? opts.namespace;

  // Acquire the global cluster lock first, with its own timeout (default 30 min).
  // The setup deadline is computed AFTER the lock is in hand, so lock-wait time
  // does not eat into the time budget for helm install + rollout waits.
  const releaseLock = await acquireClusterLock(
    opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );

  const setupDeadline = Date.now() + (opts.setupTimeoutMs ?? 6 * 60 * 1000);
  const remaining = () => Math.max(1000, setupDeadline - Date.now());

  const portForwards: ChildProcess[] = [];

  const teardown = async (): Promise<void> => {
    for (const proc of portForwards) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Ignore — already exited.
      }
    }
    // Helm uninstall is idempotent with --ignore-not-found semantics via
    // its own behaviour; we treat failures as warnings.
    run('helm', ['uninstall', releaseName, '--namespace', opts.namespace], {
      allowFailure: true,
      timeout: 60_000,
    });
    run(
      'kubectl',
      [
        'delete',
        'namespace',
        opts.namespace,
        '--ignore-not-found',
        '--wait=false',
      ],
      { allowFailure: true, timeout: 30_000 },
    );
    releaseLock();
  };

  try {
    // Clean slate: nuke any leftover release/namespace from a prior aborted run.
    run('helm', ['uninstall', releaseName, '--namespace', opts.namespace], {
      allowFailure: true,
      timeout: 60_000,
    });
    run(
      'kubectl',
      [
        'delete',
        'namespace',
        opts.namespace,
        '--ignore-not-found',
        '--wait=true',
      ],
      { allowFailure: true, timeout: 90_000 },
    );

    // Pre-create the namespace with Helm metadata so the chart's
    // namespace.yaml PATCHes it cleanly.
    run('kubectl', ['create', 'namespace', opts.namespace]);
    run('kubectl', [
      'label',
      'namespace',
      opts.namespace,
      'app.kubernetes.io/managed-by=Helm',
    ]);
    run('kubectl', [
      'annotate',
      'namespace',
      opts.namespace,
      `meta.helm.sh/release-name=${releaseName}`,
      `meta.helm.sh/release-namespace=${opts.namespace}`,
    ]);

    // Build helm --set args.
    //
    // `credentialInjection.mode=off` by default: the in-cluster credential
    // broker image (ghcr.io/mrmagooey/kubeclaw-credential-broker:latest) is
    // not loaded into minikube and pulls would fail with ErrImageNeverPull,
    // bringing the channel pod down via its Envoy sidecar. Tests that
    // actually exercise credential injection re-enable it via extraSet.
    const setArgs: string[] = [
      `namespace=${opts.namespace}`,
      `secrets.anthropicApiKey=test-key`,
      `secrets.claudeCodeOauthToken=test-token`,
      `redis.password=${DEFAULT_REDIS_PASSWORD}`,
      `credentialInjection.mode=off`,
    ];
    const setStringArgs: string[] = [];
    if (opts.httpChannel) {
      const httpPort = opts.httpChannel.httpPort ?? 4080;
      setArgs.push(
        'channels.http.enabled=true',
        `channels.http.httpPort=${httpPort}`,
        'channels.http.envVars[0].name=HTTP_CHANNEL_USERS',
        'channels.http.envVars[0].key=users',
        'channels.http.envVars[1].name=HTTP_CHANNEL_PORT',
        'channels.http.envVars[1].key=port',
        'channels.http.envVars[1].optional=true',
      );
      // The user string contains commas (multi-user) and colons (user:pass).
      // helm --set treats comma as a key separator, so embed via --set-string
      // with each literal comma escaped. The chart's secrets.yaml then writes
      // this into the auto-generated kubeclaw-channel-http Secret.
      const escapedUsers = opts.httpChannel.users.replace(/,/g, '\\,');
      setStringArgs.push(`secrets.httpChannelUsers=${escapedUsers}`);
    }
    for (const x of opts.extraSet ?? []) setArgs.push(x);

    const helmArgs: string[] = [
      'upgrade',
      '--install',
      releaseName,
      './helm/kubeclaw',
      '--namespace',
      opts.namespace,
      '--timeout',
      opts.helmTimeout ?? '180s',
    ];
    for (const s of setArgs) helmArgs.push('--set', s);
    for (const s of setStringArgs) helmArgs.push('--set-string', s);

    run('helm', helmArgs, { timeout: 5 * 60 * 1000 });

    // ── Wait for readiness ────────────────────────────────────────────────
    const waitTargets = new Set<string>(
      opts.waitForReady ?? ['orchestrator', 'redis'],
    );
    if (opts.httpChannel) waitTargets.add('channel-http');

    if (waitTargets.has('redis')) {
      await waitFor(
        `redis StatefulSet ready in ${opts.namespace}`,
        () => {
          const r = run(
            'kubectl',
            [
              '-n',
              opts.namespace,
              'get',
              'pod',
              '-l',
              'app=kubeclaw-redis',
              '-o',
              'jsonpath={.items[0].status.phase}',
            ],
            { allowFailure: true },
          );
          return r.stdout.trim() === 'Running';
        },
        remaining(),
      );
    }

    if (waitTargets.has('orchestrator')) {
      run(
        'kubectl',
        [
          'rollout',
          'status',
          'deployment/kubeclaw-orchestrator',
          '-n',
          opts.namespace,
          `--timeout=${Math.floor(remaining() / 1000)}s`,
        ],
        { timeout: remaining() + 5000 },
      );
    }

    if (waitTargets.has('channel-http')) {
      run(
        'kubectl',
        [
          'rollout',
          'status',
          'deployment/kubeclaw-channel-http',
          '-n',
          opts.namespace,
          `--timeout=${Math.floor(remaining() / 1000)}s`,
        ],
        { timeout: remaining() + 5000 },
      );
    }

    if (waitTargets.has('credential-broker')) {
      run(
        'kubectl',
        [
          'rollout',
          'status',
          'deployment/kubeclaw-credential-broker',
          '-n',
          opts.namespace,
          `--timeout=${Math.floor(remaining() / 1000)}s`,
        ],
        { timeout: remaining() + 5000 },
      );
    }

    // ── Port-forwards ─────────────────────────────────────────────────────
    if (opts.httpChannel) {
      // svc/kubeclaw-channel-http exposes port 80 → targetPort http (httpPort).
      // Forward to the *service* port (80), not the targetPort.
      const proc = spawn(
        'kubectl',
        [
          'port-forward',
          '-n',
          opts.namespace,
          'svc/kubeclaw-channel-http',
          `${opts.httpChannel.localPort}:80`,
        ],
        { stdio: opts.quiet ? 'ignore' : 'inherit', detached: false },
      );
      portForwards.push(proc);
      await waitForPortForward(
        `127.0.0.1:${opts.httpChannel.localPort}`,
        30_000,
      );
    }

    if (opts.redisLocalPort) {
      const proc = spawn(
        'kubectl',
        [
          'port-forward',
          '-n',
          opts.namespace,
          'svc/kubeclaw-redis',
          `${opts.redisLocalPort}:6379`,
        ],
        { stdio: opts.quiet ? 'ignore' : 'inherit', detached: false },
      );
      portForwards.push(proc);
      await waitForPortForward(`127.0.0.1:${opts.redisLocalPort}`, 30_000);
    }

    return {
      namespace: opts.namespace,
      releaseName,
      teardown,
    };
  } catch (err) {
    // Setup failed — tear down what we did manage to create so the next
    // test isn't blocked, then re-throw.
    await teardown().catch(() => {});
    throw err;
  }
}

async function waitForPortForward(
  hostPort: string,
  timeoutMs: number,
): Promise<void> {
  const [host, portStr] = hostPort.split(':');
  const port = parseInt(portStr, 10);
  const { createConnection } = await import('net');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(
    `[per-test-cluster] Port-forward ${hostPort} not reachable after ${timeoutMs}ms`,
  );
}

/**
 * True if minikube docker daemon has an image whose name contains the given
 * substring. Used by tests to bail early when the image global-setup was
 * supposed to build is missing.
 */
export function minikubeHasImage(nameSubstring: string): boolean {
  const r = spawnSync('minikube', ['image', 'list'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  return (r.stdout ?? '').includes(nameSubstring);
}

// Best-effort cleanup if the process exits without afterAll running.
function bestEffortCleanup(): void {
  if (!existsSync(LOCK_PATH)) return;
  try {
    const holder = parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (holder === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // Ignore — racing with another process is fine.
  }
}
process.on('exit', bestEffortCleanup);
process.on('SIGINT', () => {
  bestEffortCleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  bestEffortCleanup();
  process.exit(143);
});
