/**
 * Tests for securityContext hardening and per-pod egress wiring in
 * createSidecarToolPodJob / buildSidecarToolPodJobForTest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  CONTAINER_IMAGE: 'kubeclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'UTC',
  KUBECLAW_NAMESPACE: 'kubeclaw',
  TOOL_JOB_MEMORY_REQUEST: '512Mi',
  TOOL_JOB_MEMORY_LIMIT: '4Gi',
  TOOL_JOB_CPU_REQUEST: '250m',
  TOOL_JOB_CPU_LIMIT: '2000m',
  REDIS_AGENT_PASSWORD: '',
  REDIS_TOOL_SERVER_PASSWORD: '',
  CREDENTIAL_SIDECAR_IMAGE: 'envoyproxy/envoy:v1.31-latest',
  CREDENTIAL_SIDECAR_PORT: 8443,
  BROWSER_SIDECAR_IMAGE: 'chromium:latest',
  BROWSER_SIDECAR_PORT: 9222,
  BROWSER_SIDECAR_MEMORY_REQUEST: '256Mi',
  BROWSER_SIDECAR_MEMORY_LIMIT: '1Gi',
  BROWSER_SIDECAR_CPU_REQUEST: '100m',
  BROWSER_SIDECAR_CPU_LIMIT: '500m',
  assertToolImageAllowed: vi.fn(),
  assertGroupMountAllowed: vi.fn(),
  getContainerImage: vi.fn(() => 'kubeclaw-agent:latest'),
  getInjectionMode: vi.fn(() => 'off'),
  getAuditOnly: vi.fn(() => false),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockCreateToolPodACL } = vi.hoisted(() => ({
  mockCreateToolPodACL: vi.fn().mockResolvedValue({
    username: 'test-user',
    password: 'test-pass',
  }),
}));

vi.mock('./acl-manager.js', () => ({
  getACLManager: vi.fn(() => ({
    createToolPodACL: mockCreateToolPodACL,
  })),
}));

vi.mock('./redis-client.js', () => ({
  getRedisSubscriber: vi.fn(() => ({})),
  getOutputChannel: vi.fn((gf: string) => `kubeclaw:messages:${gf}`),
  closeRedisConnections: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db.js', () => ({
  resolveToolJob: vi.fn(),
}));

// Mock egress substrate so the default applier is a no-op ('none')
vi.mock('./egress/substrate.js', () => ({
  detectEgressSubstrate: vi.fn(() => 'none'),
  hasHardEgressEnforcement: vi.fn(() => false),
}));

// Mock @kubernetes/client-node — loadFromDefault is a no-op; makeApiClient returns stubs
const { mockBatchApi, mockCustomObjectsApi } = vi.hoisted(() => {
  const mockBatchApi = {
    createNamespacedJob: vi.fn().mockResolvedValue({}),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };
  const mockCustomObjectsApi = {
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  };
  return { mockBatchApi, mockCustomObjectsApi };
});

vi.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: class KubeConfig {
      loadFromDefault = vi.fn();
      makeApiClient = vi.fn((apiClass: unknown) => {
        if (apiClass === 'BatchV1Api') return mockBatchApi;
        if (apiClass === 'CustomObjectsApi') return mockCustomObjectsApi;
        return {};
      });
    },
    CoreV1Api: 'CoreV1Api',
    BatchV1Api: 'BatchV1Api',
    AppsV1Api: 'AppsV1Api',
    CustomObjectsApi: 'CustomObjectsApi',
    loadAllYaml: vi.fn(() => []),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { JobRunner } from './job-runner.js';
import type { SidecarToolPodJobSpec } from './types.js';
import type { EgressApplier } from './egress/apply.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSidecarToolPodJob: securityContext + egress hardening', () => {
  let runner: JobRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new JobRunner();
  });

  it('applies hardened securityContext and per-pod egress for a sidecar tool job', async () => {
    const applied: Parameters<EgressApplier['applyForJob']>[0][] = [];

    // Inject a spy applier
    runner.egressApplier = {
      applyForJob: async (a) => {
        applied.push(a);
      },
      deleteForJob: async () => {},
    };

    const spec: SidecarToolPodJobSpec = {
      agentJobId: 'job1',
      groupFolder: 'g',
      toolName: 'image_search',
      toolSpec: {
        name: 'image_search',
        description: 'd',
        parameters: {},
        image: 'kubeclaw/image-search:latest',
        pattern: 'http',
        credentials: ['brave-search'],
        allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
      },
      timeout: 60000,
    };

    const built = await runner.buildSidecarToolPodJobForTest(spec);

    // (a) Pod template uses hardened pod securityContext
    const podSpec = built.spec!.template!.spec!;
    expect((podSpec.securityContext as any).runAsNonRoot).toBe(true);
    expect((podSpec.securityContext as any).fsGroup).toBe(2000);
    expect((podSpec.securityContext as any).seccompProfile).toEqual({
      type: 'RuntimeDefault',
    });

    // (b) user-tool container uses hardened container securityContext
    const userContainer = (podSpec.containers as any[]).find(
      (c: any) => c.name === 'user-tool',
    );
    expect(userContainer).toBeDefined();
    expect(userContainer.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(userContainer.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(userContainer.securityContext.capabilities).toEqual({
      drop: ['ALL'],
    });

    // (c) applier.applyForJob was called with the tool's allowedEgress
    expect(applied).toHaveLength(1);
    expect(applied[0].allowedEgress).toEqual([
      { host: 'api.search.brave.com', ports: [443] },
    ]);
    expect(applied[0].jobLabel).toBe('job1');
    expect(applied[0].namespace).toBe('kubeclaw');
  });

  it('calls applyForJob with empty allowedEgress when toolSpec.allowedEgress is absent', async () => {
    const applied: Parameters<EgressApplier['applyForJob']>[0][] = [];
    runner.egressApplier = {
      applyForJob: async (a) => {
        applied.push(a);
      },
      deleteForJob: async () => {},
    };

    const spec: SidecarToolPodJobSpec = {
      agentJobId: 'job2',
      groupFolder: 'g',
      toolName: 'basic_tool',
      toolSpec: {
        name: 'basic_tool',
        description: 'd',
        parameters: {},
        image: 'kubeclaw/basic:latest',
        pattern: 'http',
      },
      timeout: 60000,
    };

    await runner.buildSidecarToolPodJobForTest(spec);

    expect(applied).toHaveLength(1);
    expect(applied[0].allowedEgress).toEqual([]);
  });
});
