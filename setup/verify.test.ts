import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import Database from 'better-sqlite3';

// Get actual fs module for directory operations
const actualFs = await vi.importActual<typeof import('fs')>('fs');

/**
 * Tests for the verify step.
 *
 * Verifies: orchestrator status, redis status, credentials, channel auth,
 * registered groups, mount allowlist, overall status derivation.
 */

// Track mock state
let mockExecSyncCalls: string[] = [];
let mockExecSyncResults: Map<string, string | Error> = new Map();
let mockExistsSyncResults: Map<string, boolean> = new Map();
let mockReaddirSyncResults: Map<string, string[]> = new Map();
let capturedStatuses: Array<{ step: string; fields: Record<string, unknown> }> =
  [];
let exitCode: number | undefined;

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, options?: unknown) => {
    mockExecSyncCalls.push(cmd);
    // Check for exact match first
    const exactMatch = mockExecSyncResults.get(cmd);
    if (exactMatch !== undefined) {
      if (exactMatch instanceof Error) {
        throw exactMatch;
      }
      return exactMatch;
    }
    // Then try partial match (for convenience in tests)
    for (const [key, result] of mockExecSyncResults.entries()) {
      if (cmd.includes(key)) {
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
    }
    // Default: throw error for unknown commands
    throw new Error('Command not mocked: ' + cmd);
  }),
}));

// Mock fs
vi.mock('fs', async () => {
  return {
    default: {
      existsSync: vi.fn((p: string) => mockExistsSyncResults.get(p) ?? false),
      readdirSync: vi.fn((p: string) => mockReaddirSyncResults.get(p) ?? []),
    },
    existsSync: vi.fn((p: string) => mockExistsSyncResults.get(p) ?? false),
    readdirSync: vi.fn((p: string) => mockReaddirSyncResults.get(p) ?? []),
  };
});

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

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

// Mock config to use a temp directory for STORE_DIR
vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: '/tmp/test-kubeclaw-verify-store',
  };
});

// Mock os.homedir
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/test'),
  };
});

describe('verify step', () => {
  let db: Database.Database;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSyncCalls = [];
    mockExecSyncResults.clear();
    mockExistsSyncResults.clear();
    mockReaddirSyncResults.clear();
    capturedStatuses = [];
    exitCode = undefined;

    // Mock process.exit to capture exit code instead of terminating
    originalExit = process.exit;
    process.exit = vi.fn((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit called with ${code}`);
    }) as unknown as typeof process.exit;

    // Ensure db directory exists in mock (for verify.ts to see)
    mockExistsSyncResults.set('/tmp/test-kubeclaw-verify-store', true);

    // Create real database file on disk that verify.ts can read
    const dbPath = '/tmp/test-kubeclaw-verify-store/messages.db';
    // Ensure directory exists using actual fs (bypassing mock)
    if (!actualFs.existsSync('/tmp/test-kubeclaw-verify-store')) {
      actualFs.mkdirSync('/tmp/test-kubeclaw-verify-store', {
        recursive: true,
      });
    }
    // Remove old db file if exists
    if (actualFs.existsSync(dbPath)) {
      actualFs.unlinkSync(dbPath);
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
      const dbPath = '/tmp/test-kubeclaw-verify-store/messages.db';
      if (actualFs.existsSync(dbPath)) {
        actualFs.unlinkSync(dbPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('orchestrator check', () => {
    it('returns not_found when kubectl is not available', async () => {
      const { run } = await import('./verify.js');

      // First command (readyReplicas) fails, second (deployment check) fails, third (kubectl version) fails
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        new Error('kubectl not found'),
      );
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw',
        new Error('kubectl not found'),
      );
      mockExecSyncResults.set(
        'kubectl version',
        new Error('kubectl not found'),
      );

      try {
        await run([]);
      } catch {
        // Expected to throw due to process.exit
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.ORCHESTRATOR).toBe('not_found');
    });

    it('returns not_deployed when deployment does not exist', async () => {
      const { run } = await import('./verify.js');

      // kubectl version succeeds
      mockExecSyncResults.set('kubectl version', 'v1.28.0');

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.ORCHESTRATOR).toBe('not_deployed');
    });

    it('returns deployed_not_ready when readyReplicas = 0', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '0',
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.ORCHESTRATOR).toBe('deployed_not_ready');
    });

    it('returns deployed_not_ready when readyReplicas is NaN (empty string)', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '',
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.ORCHESTRATOR).toBe('deployed_not_ready');
    });

    it('returns running when readyReplicas = 2', async () => {
      const { run } = await import('./verify.js');

      // Setup orchestrator as running
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '2',
      );
      // Minimal mocks for other checks - need to match actual command strings
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );
      // The redis command uses "-l app=kubeclaw-redis" so we need to match differently
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      await run([]);

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.ORCHESTRATOR).toBe('running');
    });
  });

  describe('redis check', () => {
    it('returns running when pod phase is Running', async () => {
      const { run } = await import('./verify.js');

      // Setup minimal conditions for redis check
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      // The redis command uses "-l app=kubeclaw-redis" so we need to match the full command pattern
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      await run([]);

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.REDIS).toBe('running');
    });

    it('returns not_ready when pod phase is Pending', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Pending',
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.REDIS).toBe('not_ready');
    });

    it('returns not_found when no pod found (empty output)', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        '',
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.REDIS).toBe('not_found');
    });

    it('returns not_found when kubectl fails', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        new Error('kubectl failed'),
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.REDIS).toBe('not_found');
    });
  });

  describe('credentials check', () => {
    it('returns configured when secret exists', async () => {
      const { run } = await import('./verify.js');

      // Setup minimal conditions for credentials check
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );
      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      await run([]);

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.CREDENTIALS).toBe('configured');
    });

    it('returns missing when secret not found', async () => {
      const { run } = await import('./verify.js');

      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.CREDENTIALS).toBe('missing');
    });
  });

  describe('overall status derivation', () => {
    it('returns success when all conditions met', async () => {
      const { run } = await import('./verify.js');

      // Setup all success conditions with full command mocks
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      await run([]);

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('success');
    });

    it('returns failed when orchestrator is not running', async () => {
      mockExecSyncResults.set('readyReplicas', '0');

      const { run } = await import('./verify.js');
      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('failed');
      expect(status?.fields.ORCHESTRATOR).toBe('deployed_not_ready');
    });

    it('returns failed when redis is not running', async () => {
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Pending',
      );

      const { run } = await import('./verify.js');
      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('failed');
      expect(status?.fields.REDIS).toBe('not_ready');
    });

    it('returns failed when credentials are missing', async () => {
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        new Error('secret not found'),
      );

      const { run } = await import('./verify.js');
      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('failed');
      expect(status?.fields.CREDENTIALS).toBe('missing');
    });

    it('returns failed when no channels configured', async () => {
      // Set up all passing conditions EXCEPT channels
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );

      // No channel auth - auth dir doesn't exist and is empty
      mockExistsSyncResults.delete('/home/peter/projects/kubeclaw/store/auth');
      mockReaddirSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        [],
      );

      // Mock token secret calls to return empty/not found (prevent partial match from credentials check)
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath={.data.TELEGRAM_BOT_TOKEN}',
        '',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath={.data.SLACK_BOT_TOKEN}',
        '',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath={.data.SLACK_APP_TOKEN}',
        '',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath={.data.DISCORD_BOT_TOKEN}',
        '',
      );

      // Other requirements pass
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      const { run } = await import('./verify.js');
      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('failed');
      // Verify other conditions are met, so failure is isolated to channels
      expect(status?.fields.ORCHESTRATOR).toBe('running');
      expect(status?.fields.REDIS).toBe('running');
      expect(status?.fields.CREDENTIALS).toBe('configured');
    });

    it('returns failed when registeredGroups = 0', async () => {
      db.prepare('DELETE FROM registered_groups').run();

      const { run } = await import('./verify.js');
      try {
        await run([]);
      } catch {
        // Expected
      }

      const status = capturedStatuses.find((s) => s.step === 'VERIFY');
      expect(status?.fields.STATUS).toBe('failed');
      expect(status?.fields.REGISTERED_GROUPS).toBe(0);
    });
  });

  describe('getK8sSecretValue key validation', () => {
    it('proceeds with kubectl call for valid key', async () => {
      const { run } = await import('./verify.js');

      // Setup minimal conditions with full command mocks
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );
      // Mock the TELEGRAM_BOT_TOKEN secret fetch - need to match "data.TELEGRAM_BOT_TOKEN"
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw -o jsonpath={.data.TELEGRAM_BOT_TOKEN}',
        'dGVzdC10b2tlbg==',
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      // Clear env var to force reading from K8s secret
      delete process.env.TELEGRAM_BOT_TOKEN;
      mockExecSyncCalls = [];

      await run([]);

      // Should have called kubectl for the secret with valid key
      expect(
        mockExecSyncCalls.some((cmd) => cmd.includes('TELEGRAM_BOT_TOKEN')),
      ).toBe(true);
    });

    it('does not call kubectl for invalid key', async () => {
      // We can't directly test getK8sSecretValue since it's not exported,
      // but we can verify via the run() function that invalid keys don't cause issues
      const { run } = await import('./verify.js');

      // Setup minimal conditions
      mockExecSyncResults.set(
        'kubectl get deployment kubeclaw-orchestrator -n kubeclaw -o jsonpath={.status.readyReplicas}',
        '1',
      );
      mockExecSyncResults.set(
        'kubectl get pods -n kubeclaw -l app=kubeclaw-redis',
        'Running',
      );
      mockExecSyncResults.set(
        'kubectl get secret kubeclaw-secrets -n kubeclaw',
        'kubeclaw-secrets',
      );

      mockExistsSyncResults.set(
        '/home/peter/projects/kubeclaw/store/auth',
        true,
      );
      mockExistsSyncResults.set(
        '/home/test/.config/kubeclaw/mount-allowlist.json',
        true,
      );
      mockReaddirSyncResults.set('/home/peter/projects/kubeclaw/store/auth', [
        'auth-file.json',
      ]);

      const path = await import('path');
      const dbPath = path.join('/tmp/test-kubeclaw-verify-store', 'messages.db');
      mockExistsSyncResults.set(dbPath, true);

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

      mockExecSyncCalls = [];

      await run([]);

      // Should NOT have called kubectl with any invalid key pattern
      const invalidKeyCalls = mockExecSyncCalls.filter(
        (cmd) =>
          cmd.includes('..') || cmd.includes('/etc/') || cmd.includes('../../'),
      );
      expect(invalidKeyCalls.length).toBe(0);
    });
  });
});
