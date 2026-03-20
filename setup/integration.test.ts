import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import Database from 'better-sqlite3';

// Get actual fs module for file operations (bypassing mock)
const actualFs = await vi.importActual<typeof import('fs')>('fs');

/**
 * Integration test for the full Kubernetes setup sequence.
 *
 * Verifies: environment → kubernetes → verify steps work together end-to-end.
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
      readdirSync: vi.fn(() => ['auth-file.json']),
    },
    existsSync: vi.fn((p: string) => mockExistsSyncResults.get(p) ?? false),
    readFileSync: vi.fn((p: string) => mockReadFileResults.get(p) ?? ''),
    readdirSync: vi.fn(() => ['auth-file.json']),
  };
});

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({ ANTHROPIC_API_KEY: 'test-key' })),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: '/tmp/test-nanoclaw-integration-store',
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    capturedStatuses.push({ step, fields });
  }),
}));

describe('K8s setup integration', () => {
  let db: Database.Database;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSyncResults.clear();
    mockSpawnSyncResults.clear();
    mockExistsSyncResults.clear();
    mockReadFileResults.clear();
    capturedStatuses = [];

    originalExit = process.exit;
    process.exit = vi.fn((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as unknown as typeof process.exit;

    // Create real database file on disk that verify.ts can read
    const dbDir = '/tmp/test-nanoclaw-integration-store';
    const dbPath = `${dbDir}/messages.db`;

    // Ensure directory exists using actual fs
    if (!actualFs.existsSync(dbDir)) {
      actualFs.mkdirSync(dbDir, { recursive: true });
    }
    // Remove old db file if exists (and close any existing connection)
    try {
      if (actualFs.existsSync(dbPath)) {
        actualFs.unlinkSync(dbPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`);

    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '123@g.us',
      'Test Group',
      'test-group',
      '@Andy',
      new Date().toISOString(),
      1,
    );

    // Mock existsSync to return true for the db path
    mockExistsSyncResults.set(dbPath, true);
  });

  afterEach(() => {
    // Close DB connection first
    try {
      db.close();
    } catch {
      // Ignore close errors
    }

    process.exit = originalExit;

    // Clean up database file using actual fs
    try {
      const dbPath = '/tmp/test-nanoclaw-integration-store/messages.db';
      if (actualFs.existsSync(dbPath)) {
        actualFs.unlinkSync(dbPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('environment and kubernetes steps complete successfully', async () => {
    // Mock environment check calls
    mockExecSyncResults.set('kubectl cluster-info', '');
    mockExistsSyncResults.set('/home/peter/projects/nanoclaw/.env', true);
    mockExistsSyncResults.set('/home/peter/projects/nanoclaw/store/auth', true);

    // Mock kubernetes step calls
    mockExecSyncResults.set(
      'kubectl get secret nanoclaw-secrets -n nanoclaw',
      'nanoclaw-secrets',
    );
    mockSpawnSyncResults.set('kubectl apply -f -', {
      status: 0,
      stdout: '',
      stderr: '',
    });
    mockSpawnSyncResults.set(
      'kubectl rollout status deployment/nanoclaw-orchestrator -n nanoclaw --timeout=120s',
      { status: 0, stdout: '', stderr: '' },
    );
    mockSpawnSyncResults.set(
      'kubectl get pods -n nanoclaw -l app=nanoclaw-redis -o jsonpath={.items[0].status.phase}',
      { status: 0, stdout: 'Running', stderr: '' },
    );

    mockExistsSyncResults.set(
      '/home/peter/projects/nanoclaw/k8s/00-namespace.yaml',
      true,
    );
    mockExistsSyncResults.set(
      '/home/peter/projects/nanoclaw/k8s/01-network-policy.yaml',
      true,
    );
    mockExistsSyncResults.set(
      '/home/peter/projects/nanoclaw/k8s/10-redis.yaml',
      true,
    );
    mockExistsSyncResults.set(
      '/home/peter/projects/nanoclaw/k8s/20-storage.yaml',
      true,
    );
    mockExistsSyncResults.set(
      '/home/peter/projects/nanoclaw/k8s/30-orchestrator.yaml',
      true,
    );

    mockReadFileResults.set(
      '/home/peter/projects/nanoclaw/k8s/30-orchestrator.yaml',
      'image: nanoclaw-orchestrator:latest\nimagePullPolicy: Never',
    );

    // Run environment step
    const { run: runEnvironment } = await import('./environment.js');
    await runEnvironment([]);

    const envStatus = capturedStatuses.find(
      (s) => s.step === 'CHECK_ENVIRONMENT',
    );
    expect(envStatus?.fields.STATUS).toBe('success');
    expect(envStatus?.fields.KUBERNETES).toBe('connected');

    // Run kubernetes step
    const { run: runKubernetes } = await import('./kubernetes.js');
    await runKubernetes(['--skip-build']);

    const k8sStatus = capturedStatuses.find(
      (s) => s.step === 'SETUP_KUBERNETES',
    );
    expect(k8sStatus?.fields.STATUS).toBe('success');
    expect(k8sStatus?.fields.DEPLOYMENT_READY).toBe(true);

    // Run verify step
    mockExecSyncResults.set(
      'kubectl get deployment nanoclaw-orchestrator -n nanoclaw -o jsonpath={.status.readyReplicas}',
      '1',
    );
    mockExecSyncResults.set(
      'kubectl get pods -n nanoclaw -l app=nanoclaw-redis -o jsonpath={.items[0].status.phase}',
      'Running',
    );
    mockExecSyncResults.set(
      'kubectl get secret nanoclaw-secrets -n nanoclaw',
      'nanoclaw-secrets',
    );

    const { run: runVerify } = await import('./verify.js');
    await runVerify([]);

    const verifyStatus = capturedStatuses.find((s) => s.step === 'VERIFY');
    expect(verifyStatus?.fields.STATUS).toBe('success');
    expect(verifyStatus?.fields.ORCHESTRATOR).toBe('running');
    expect(verifyStatus?.fields.REDIS).toBe('running');
    expect(verifyStatus?.fields.CREDENTIALS).toBe('configured');
    expect(verifyStatus?.fields.REGISTERED_GROUPS).toBe(1);
  });

  it('verify fails when deployment is not ready', async () => {
    mockExecSyncResults.set(
      'kubectl get deployment nanoclaw-orchestrator -n nanoclaw -o jsonpath={.status.readyReplicas}',
      '0',
    );
    mockExecSyncResults.set('nanoclaw-redis', 'Running');
    mockExecSyncResults.set(
      'kubectl get secret nanoclaw-secrets -n nanoclaw',
      'nanoclaw-secrets',
    );
    mockExistsSyncResults.set('/home/peter/projects/nanoclaw/store/auth', true);
    mockExistsSyncResults.set(
      '/home/test/.config/nanoclaw/mount-allowlist.json',
      true,
    );

    const path = await import('path');
    const dbPath = path.join(
      '/tmp/test-nanoclaw-integration-store',
      'messages.db',
    );
    mockExistsSyncResults.set(dbPath, true);

    const { run: runVerify } = await import('./verify.js');
    await expect(runVerify([])).rejects.toThrow('process.exit');

    const verifyStatus = capturedStatuses.find((s) => s.step === 'VERIFY');
    expect(verifyStatus?.fields.STATUS).toBe('failed');
    expect(verifyStatus?.fields.ORCHESTRATOR).toBe('deployed_not_ready');
  });
});
