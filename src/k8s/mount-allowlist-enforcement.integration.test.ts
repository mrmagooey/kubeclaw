/**
 * Integration test: mount-allowlist ENFORCEMENT seam (Gap 3).
 *
 * The job-runner.test.ts mocks assertGroupMountAllowed from config.js, so it
 * never exercises the real env-var-driven enforcement.  These tests drive the
 * REAL assertGroupMountAllowed (from src/config.ts) with no mocking of the
 * function under test, verifying that:
 *
 *  - an image NOT in TOOL_GROUP_MOUNT_ALLOWLIST is rejected with a clear error
 *  - a matching image (exact or wildcard) is permitted
 *  - the empty-allowlist default-deny rule holds
 *
 * The K8s API is fully stubbed — no cluster is needed.
 *
 * FINDING: assertGroupMountAllowed IS wired at the call site in job-runner.ts
 * (src/k8s/job-runner.ts, createSidecarToolPodJob, mount==='group' branch).
 * The existing unit tests mock it away; these integration tests prove the real
 * logic works end-to-end through the config module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Stub all external collaborators so no cluster is needed ─────────────────

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({
    createToolPodACL: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./redis-client.js', () => {
  const { EventEmitter } = require('events');
  const sub = new EventEmitter() as any;
  sub.subscribe = vi.fn((_: string, cb: (err: null) => void) => cb(null));
  sub.unsubscribe = vi.fn();
  sub.off = vi.fn();
  sub.quit = vi.fn().mockResolvedValue('OK');
  return {
    getRedisSubscriber: vi.fn(() => sub),
    getOutputChannel: vi.fn((g: string) => `kubeclaw:messages:${g}`),
    closeRedisConnections: vi.fn().mockResolvedValue(undefined),
  };
});

const mockCreateJob = vi.fn().mockResolvedValue({ body: {} });

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn(() => ({
      createNamespacedJob: mockCreateJob,
      readNamespacedJob: vi.fn(),
      deleteNamespacedJob: vi.fn(),
      listNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
      createNamespacedPersistentVolumeClaim: vi.fn(),
      createNamespacedService: vi.fn(),
      replaceNamespacedService: vi.fn(),
      createNamespacedDeployment: vi.fn(),
      replaceNamespacedDeployment: vi.fn(),
    }));
  },
  CoreV1Api: 'CoreV1Api',
  BatchV1Api: 'BatchV1Api',
  AppsV1Api: 'AppsV1Api',
  CustomObjectsApi: 'CustomObjectsApi',
  loadAllYaml: vi.fn(() => []),
}));

// Stub egress substrate detection so the default egressApplier is a no-op
vi.mock('./egress/substrate.js', () => ({
  detectEgressSubstrate: vi.fn(() => 'none'),
  hasHardEgressEnforcement: vi.fn(() => false),
}));

// ── Import the module under test AFTER mocks (config is NOT mocked) ─────────
// config.ts reads TOOL_GROUP_MOUNT_ALLOWLIST at import time, so we use
// dynamic imports inside each test to pick up env changes made via
// vi.stubEnv / process.env mutation before import.

describe('assertGroupMountAllowed — real enforcement (no mock)', () => {
  const originalEnv = process.env.TOOL_GROUP_MOUNT_ALLOWLIST;

  afterEach(() => {
    // Restore env and reset module registry so the next test gets a fresh import
    if (originalEnv === undefined) {
      delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;
    } else {
      process.env.TOOL_GROUP_MOUNT_ALLOWLIST = originalEnv;
    }
    vi.resetModules();
  });

  it('throws for any image when allowlist is empty (default-deny)', async () => {
    delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;
    const { assertGroupMountAllowed } = await import('../config.js');
    expect(() => assertGroupMountAllowed('alpine:latest')).toThrow(
      /not permitted to mount the group filesystem/,
    );
  });

  it('throws when image does not match any allowlist pattern', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'my-tool:v1,other-tool:*';
    const { assertGroupMountAllowed } = await import('../config.js');
    expect(() => assertGroupMountAllowed('alpine:latest')).toThrow(
      /not permitted to mount the group filesystem/,
    );
    expect(() => assertGroupMountAllowed('my-tool:v2')).toThrow(
      /not permitted to mount the group filesystem/,
    );
  });

  it('does not throw for an exact-match image in the allowlist', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:latest';
    const { assertGroupMountAllowed } = await import('../config.js');
    expect(() => assertGroupMountAllowed('alpine:latest')).not.toThrow();
  });

  it('does not throw for a wildcard-match (alpine:*)', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:*';
    const { assertGroupMountAllowed } = await import('../config.js');
    expect(() => assertGroupMountAllowed('alpine:3.18')).not.toThrow();
    expect(() => assertGroupMountAllowed('alpine:latest')).not.toThrow();
  });

  it('wildcard does not match a different image prefix', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:*';
    const { assertGroupMountAllowed } = await import('../config.js');
    expect(() => assertGroupMountAllowed('ubuntu:22.04')).toThrow(
      /not permitted to mount the group filesystem/,
    );
  });

  it('error message lists permitted patterns', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'safe-tool:v1,other:*';
    const { assertGroupMountAllowed } = await import('../config.js');
    let msg = '';
    try {
      assertGroupMountAllowed('rogue:latest');
    } catch (e: unknown) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('safe-tool:v1');
    expect(msg).toContain('other:*');
    expect(msg).toContain('TOOL_GROUP_MOUNT_ALLOWLIST');
  });
});

describe('mount=group enforcement wired through createSidecarToolPodJob', () => {
  /**
   * Verify the enforcement is wired at the call site in job-runner.ts.
   *
   * With TOOL_GROUP_MOUNT_ALLOWLIST unset (empty → default-deny), calling
   * createSidecarToolPodJob with mount:'group' must throw — proving that
   * assertGroupMountAllowed is invoked in the real code path, not bypassed.
   *
   * This test does NOT mock assertGroupMountAllowed, so a failure here would
   * mean the enforcement is no longer wired at the builder call site.
   *
   * FINDING: assertGroupMountAllowed IS wired (confirmed).  The existing
   * job-runner.test.ts mocks it, so these tests are the only ones that exercise
   * the real env-var-driven logic through the full createSidecarToolPodJob path.
   */

  const originalEnv = process.env.TOOL_GROUP_MOUNT_ALLOWLIST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;
    } else {
      process.env.TOOL_GROUP_MOUNT_ALLOWLIST = originalEnv;
    }
    vi.resetModules();
    mockCreateJob.mockReset();
    mockCreateJob.mockResolvedValue({ body: {} });
  });

  /** Minimal valid spec for createSidecarToolPodJob with mount:'group' */
  function groupMountSpec(image: string) {
    return {
      agentJobId: 'direct-abc123-deadbeef',
      groupFolder: 'my-group',
      toolName: 'my-tool',
      timeout: 60000,
      toolSpec: {
        name: 'my-tool',
        description: 'test tool',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
        image,
        pattern: 'file' as const,
        mount: 'group',
        run: 'echo ok',
      },
    };
  }

  it('rejects a group-mount tool when TOOL_GROUP_MOUNT_ALLOWLIST is empty', async () => {
    delete process.env.TOOL_GROUP_MOUNT_ALLOWLIST;

    // Leave assertGroupMountAllowed real; only stub parts config.js that
    // require env vars not relevant to this test.
    vi.doMock('../config.js', async () => {
      const real =
        await vi.importActual<typeof import('../config.js')>('../config.js');
      return {
        ...real,
        assertToolImageAllowed: vi.fn(), // don't block on image allowlist
        getContainerImage: vi.fn(() => 'kubeclaw-agent:latest'),
        getInjectionMode: vi.fn(() => 'off' as const),
        getAuditOnly: vi.fn(() => false),
      };
    });

    const { JobRunner } = await import('./job-runner.js');
    const runner = new JobRunner();

    await expect(
      runner.createSidecarToolPodJob(groupMountSpec('alpine:latest')),
    ).rejects.toThrow(/not permitted to mount the group filesystem/);
  });

  it('permits a group-mount tool when the image matches TOOL_GROUP_MOUNT_ALLOWLIST', async () => {
    process.env.TOOL_GROUP_MOUNT_ALLOWLIST = 'alpine:*';

    vi.doMock('../config.js', async () => {
      const real =
        await vi.importActual<typeof import('../config.js')>('../config.js');
      return {
        ...real,
        assertToolImageAllowed: vi.fn(),
        getContainerImage: vi.fn(() => 'kubeclaw-agent:latest'),
        getInjectionMode: vi.fn(() => 'off' as const),
        getAuditOnly: vi.fn(() => false),
      };
    });

    const { JobRunner } = await import('./job-runner.js');
    const runner = new JobRunner();

    // alpine:latest matches alpine:* → must not throw
    const jobName = await runner.createSidecarToolPodJob(
      groupMountSpec('alpine:latest'),
    );
    expect(typeof jobName).toBe('string');
    expect(mockCreateJob).toHaveBeenCalled();
  });
});
