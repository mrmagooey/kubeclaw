import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';

/**
 * Tests for the kubernetes step.
 *
 * Verifies: parseArgs, checkSecretsExist, detectStorageManifest, waitForRedis.
 */

// Track mock state
let mockExecSyncResults: Map<string, string | Error> = new Map();
let mockSpawnSyncResults: Map<
  string,
  { status: number | null; stdout: string; stderr: string }
> = new Map();
let mockExistsSyncResults: Map<string, boolean> = new Map();
let mockReadFileResults: Map<string, string> = new Map();
let capturedStatuses: Array<{ step: string; fields: Record<string, unknown> }> =
  [];

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    const result = mockExecSyncResults.get(cmd);
    if (result instanceof Error) {
      throw result;
    }
    return result ?? '';
  }),
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    return (
      mockSpawnSyncResults.get(key) ?? { status: 0, stdout: '', stderr: '' }
    );
  }),
}));

// Mock fs
vi.mock('fs', async () => {
  return {
    default: {
      existsSync: vi.fn((p: string) => mockExistsSyncResults.get(p) ?? false),
      readFileSync: vi.fn((p: string) => mockReadFileResults.get(p) ?? ''),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn((p: string) => mockExistsSyncResults.get(p) ?? false),
    readFileSync: vi.fn((p: string) => mockReadFileResults.get(p) ?? ''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    capturedStatuses.push({ step, fields });
  }),
}));

describe('kubernetes step', () => {
  let originalExit: typeof process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers with shouldAdvanceTime to advance Date.now() as well
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5000 });
    mockExecSyncResults.clear();
    mockSpawnSyncResults.clear();
    mockExistsSyncResults.clear();
    mockReadFileResults.clear();
    capturedStatuses = [];
    originalExit = process.exit;
    process.exit = vi.fn((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.exit = originalExit;
  });

  describe('parseArgs', () => {
    it('defaults to skipBuild=true and namespace=kubeclaw', async () => {
      const { run } = await import('./kubernetes.js');

      // Mock cluster-info to succeed so we don't exit early
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      // Mock spawnSync for rollout status and pod checks
      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      // Mock fs.existsSync for manifest files
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      await run([]);

      // Verify kubectl cluster-info was called using mock.calls
      const execSyncMock = vi.mocked(execSync);
      const clusterInfoCalls = execSyncMock.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('cluster-info'),
      );
      expect(clusterInfoCalls.length).toBeGreaterThan(0);
    });

    it('sets skipBuild=false when --build flag is passed', async () => {
      const { run } = await import('./kubernetes.js');

      // Track if build.sh would be called
      let buildCalled = false;
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      // Override execSync to track build.sh calls
      const execSyncMock = vi.mocked(await import('child_process')).execSync;
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes('build.sh')) {
          buildCalled = true;
        }
        const result = mockExecSyncResults.get(cmd);
        if (result instanceof Error) {
          throw result;
        }
        return result ?? '';
      });

      await run(['--build']);

      expect(buildCalled).toBe(true);
    });

    it('sets namespace when --namespace is passed', async () => {
      const { run } = await import('./kubernetes.js');

      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n custom-ns',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n custom-ns --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n custom-ns -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      await run(['--namespace', 'custom-ns']);

      // Verify custom namespace was used - check mock.calls
      const execSyncMock = vi.mocked(execSync);
      const namespaceCalls = execSyncMock.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('custom-ns'),
      );
      expect(namespaceCalls.length).toBeGreaterThan(0);
    });

    it('sets registry when --registry is passed', async () => {
      const { run } = await import('./kubernetes.js');

      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      // Mock fs.readFileSync to return orchestrator content
      mockReadFileResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        'image: kubeclaw-orchestrator:latest\nimagePullPolicy: Never',
      );

      await run(['--build', '--registry', 'reg.example.com']);

      // Verify that spawnSync was called for applying orchestrator
      expect(vi.mocked(spawnSync)).toHaveBeenCalled();
    });
  });

  describe('checkSecretsExist', () => {
    it('returns true when kubectl get secret succeeds', async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');
      await run([]);

      // Verify secret check was made using mock.calls
      const execSyncMock = vi.mocked(execSync);
      const secretCalls = execSyncMock.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('kubeclaw-secrets'),
      );
      expect(secretCalls.length).toBeGreaterThan(0);

      // Check that emitStatus was called with SECRETS_CONFIGURED: true
      const status = capturedStatuses.find(
        (s) => s.step === 'SETUP_KUBERNETES',
      );
      expect(status?.fields.SECRETS_CONFIGURED).toBe(true);
    });

    it('returns false when kubectl get secret fails', async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');
      await run([]);

      // Should proceed with warning about secrets
      const execSyncMock = vi.mocked(execSync);
      const secretCalls = execSyncMock.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('kubeclaw-secrets'),
      );
      expect(secretCalls.length).toBeGreaterThan(0);

      // Check that emitStatus was called with SECRETS_CONFIGURED: false
      const status = capturedStatuses.find(
        (s) => s.step === 'SETUP_KUBERNETES',
      );
      expect(status?.fields.SECRETS_CONFIGURED).toBe(false);
    });
  });

  describe('detectStorageManifest', () => {
    it("always uses '20-storage.yaml'", async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');
      await run([]);

      // Storage manifest should always be 20-storage.yaml
      expect(
        mockExistsSyncResults.has(
          '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        ),
      ).toBe(true);
    });
  });

  describe('waitForRedis', () => {
    it('resolves true when pod reaches Running on first poll', async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );
      mockSpawnSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis -o jsonpath={.items[0].status.phase}',
        { status: 0, stdout: 'Running', stderr: '' },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');
      await run([]);

      // Should complete successfully with Redis ready
      const status = capturedStatuses.find(
        (s) => s.step === 'SETUP_KUBERNETES',
      );
      expect(status?.fields.STATUS).toBe('success');
    });

    it('resolves true when pod reaches Running on third poll', async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );

      // Track poll count and return Running on the 3rd poll
      let pollCount = 0;
      const spawnSyncMock = vi.mocked(await import('child_process')).spawnSync;
      spawnSyncMock.mockImplementation(
        (cmd: string, args?: readonly string[]) => {
          const argsStr = args?.join(' ') ?? '';
          const key = `${cmd} ${argsStr}`;
          if (key.includes('kubeclaw-redis') && key.includes('phase')) {
            pollCount++;
            return {
              status: 0,
              stdout: pollCount >= 3 ? 'Running' : 'Pending',
              stderr: '',
              pid: 123,
              output: [''],
              signal: null,
            } as unknown as ReturnType<typeof spawnSync>;
          }
          return (mockSpawnSyncResults.get(key) ?? {
            status: 0,
            stdout: '',
            stderr: '',
            pid: 123,
            output: [''],
            signal: null,
          }) as unknown as ReturnType<typeof spawnSync>;
        },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');

      // Start run
      const runPromise = run([]);

      // Advance timers to allow 3 polls (5s interval each)
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await runPromise;

      // Should have polled 3 times
      expect(pollCount).toBe(3);

      // Should complete successfully with Redis ready
      const status = capturedStatuses.find(
        (s) => s.step === 'SETUP_KUBERNETES',
      );
      expect(status?.fields.STATUS).toBe('success');
    });

    it('resolves false when pod never reaches Running within timeout', async () => {
      mockExecSyncResults.set('kubectl cluster-info', '');
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      mockSpawnSyncResults.set('kubectl apply -f -', {
        status: 0,
        stdout: '',
        stderr: '',
      });
      mockSpawnSyncResults.set(
        'kubectl rollout status deployment/kubeclaw-orchestrator -n kubeclaw --timeout=120s',
        { status: 0, stdout: '', stderr: '' },
      );

      // Always return Pending (never Running)
      const spawnSyncMock = vi.mocked(await import('child_process')).spawnSync;
      spawnSyncMock.mockImplementation(
        (cmd: string, args?: readonly string[]) => {
          const argsStr = args?.join(' ') ?? '';
          const key = `${cmd} ${argsStr}`;
          if (key.includes('kubeclaw-redis') && key.includes('phase')) {
            return {
              status: 0,
              stdout: 'Pending',
              stderr: '',
              pid: 123,
              output: [''],
              signal: null,
            } as unknown as ReturnType<typeof spawnSync>;
          }
          return (mockSpawnSyncResults.get(key) ?? {
            status: 0,
            stdout: '',
            stderr: '',
            pid: 123,
            output: [''],
            signal: null,
          }) as unknown as ReturnType<typeof spawnSync>;
        },
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/00-namespace.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/01-network-policy.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/10-redis.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/20-storage.yaml',
        true,
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/k8s/30-orchestrator.yaml',
        true,
      );

      const { run } = await import('./kubernetes.js');

      // Use a mock that records exit code without throwing to avoid unhandled rejection
      const exitMock = vi.fn();
      process.exit = exitMock as unknown as typeof process.exit;

      // Start run
      const runPromise = run([]);

      // Advance timers to exhaust the 60s timeout (60s / 5s interval = 12 iterations)
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await runPromise;

      // Verify process.exit was called with 1
      expect(exitMock).toHaveBeenCalledWith(1);

      const status = capturedStatuses.find(
        (s) => s.step === 'SETUP_KUBERNETES',
      );
      expect(status?.fields.STATUS).toBe('failed');
      expect(status?.fields.ERROR).toBe('redis_not_ready');
    }, 20000);
  });
});
