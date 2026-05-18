import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── K8s mock ──────────────────────────────────────────────────────────────────

const mockDeleteDeployment = vi.fn();
const mockDeleteSecret = vi.fn();
const mockDeletePvc = vi.fn();

vi.mock('@kubernetes/client-node', () => {
  class MockCoreV1Api {}
  class MockAppsV1Api {}

  return {
    KubeConfig: class {
      loadFromCluster() {}
      makeApiClient(cls: unknown) {
        if (cls === MockAppsV1Api) {
          return { deleteNamespacedDeployment: mockDeleteDeployment };
        }
        return {
          deleteNamespacedSecret: mockDeleteSecret,
          deleteNamespacedPersistentVolumeClaim: mockDeletePvc,
        };
      }
    },
    CoreV1Api: MockCoreV1Api,
    AppsV1Api: MockAppsV1Api,
  };
});

// Must import AFTER mock registration.
const { removeChannel } = await import('./channel-remove.js');

// Helper: simulate a K8s 404 error.
// @kubernetes/client-node v1.x ApiException uses `code` (not `statusCode`).
function notFound(): Error & { code: number } {
  const e = Object.assign(new Error('not found'), { code: 404 });
  return e;
}

describe('removeChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports deleted when all resources exist', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockResolvedValue({});
    mockDeletePvc.mockResolvedValue({});

    const result = await removeChannel('test-instance');

    expect(result.deleted).toEqual([
      'kubeclaw-channel-test-instance',
      'kubeclaw-test-instance-secrets',
      'kubeclaw-channel-test-instance-groups',
      'kubeclaw-channel-test-instance-store',
      'kubeclaw-channel-test-instance-sessions',
    ]);
    expect(result.alreadyAbsent).toEqual([]);
    expect(result.summary).toContain('Deleted:');
    expect(result.summary).toContain('kubeclaw-channel-test-instance');
  });

  it('reports already-absent when no resources exist (idempotent)', async () => {
    mockDeleteDeployment.mockRejectedValue(notFound());
    mockDeleteSecret.mockRejectedValue(notFound());
    mockDeletePvc.mockRejectedValue(notFound());

    const result = await removeChannel('ghost-instance');

    expect(result.deleted).toEqual([]);
    expect(result.alreadyAbsent).toHaveLength(5);
    expect(result.summary).toContain('Already absent:');
    expect(result.summary).not.toContain('Deleted:\n');
  });

  it('handles mixed: deployment exists, everything else absent', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockRejectedValue(notFound());
    mockDeletePvc.mockRejectedValue(notFound());

    const result = await removeChannel('partial-instance');

    expect(result.deleted).toEqual(['kubeclaw-channel-partial-instance']);
    expect(result.alreadyAbsent).toHaveLength(4);
  });

  it('propagates non-404 errors', async () => {
    const serverError = Object.assign(new Error('internal server error'), {
      statusCode: 500,
    });
    mockDeleteDeployment.mockRejectedValue(serverError);

    await expect(removeChannel('bad-instance')).rejects.toThrow(
      'internal server error',
    );
  });

  it('passes the correct resource names to the K8s client', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockResolvedValue({});
    mockDeletePvc.mockResolvedValue({});

    await removeChannel('my-channel');

    expect(mockDeleteDeployment).toHaveBeenCalledWith({
      name: 'kubeclaw-channel-my-channel',
      namespace: 'kubeclaw',
    });
    expect(mockDeleteSecret).toHaveBeenCalledWith({
      name: 'kubeclaw-my-channel-secrets',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(1, {
      name: 'kubeclaw-channel-my-channel-groups',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(2, {
      name: 'kubeclaw-channel-my-channel-store',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(3, {
      name: 'kubeclaw-channel-my-channel-sessions',
      namespace: 'kubeclaw',
    });
  });
});
