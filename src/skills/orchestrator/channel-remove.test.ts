import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── K8s mock ──────────────────────────────────────────────────────────────────

const mockDeleteDeployment = vi.fn();
const mockDeleteServiceAccount = vi.fn();
const mockDeleteService = vi.fn();
const mockDeleteNetworkPolicy = vi.fn();
const mockDeleteSecret = vi.fn();
const mockDeletePvc = vi.fn();
const mockListPvc = vi.fn();
const mockDeleteJob = vi.fn();

vi.mock('@kubernetes/client-node', () => {
  class MockCoreV1Api {}
  class MockAppsV1Api {}
  class MockBatchV1Api {}
  class MockNetworkingV1Api {}

  return {
    KubeConfig: class {
      loadFromCluster() {}
      makeApiClient(cls: unknown) {
        if (cls === MockAppsV1Api) {
          return { deleteNamespacedDeployment: mockDeleteDeployment };
        }
        if (cls === MockBatchV1Api) {
          return { deleteNamespacedJob: mockDeleteJob };
        }
        if (cls === MockNetworkingV1Api) {
          return { deleteNamespacedNetworkPolicy: mockDeleteNetworkPolicy };
        }
        return {
          deleteNamespacedServiceAccount: mockDeleteServiceAccount,
          deleteNamespacedService: mockDeleteService,
          deleteNamespacedSecret: mockDeleteSecret,
          deleteNamespacedPersistentVolumeClaim: mockDeletePvc,
          listNamespacedPersistentVolumeClaim: mockListPvc,
        };
      }
    },
    CoreV1Api: MockCoreV1Api,
    AppsV1Api: MockAppsV1Api,
    BatchV1Api: MockBatchV1Api,
    NetworkingV1Api: MockNetworkingV1Api,
  };
});

// Must import AFTER mock registration.
const { removeChannel } = await import('./channel-remove.js');

// Helper: simulate a K8s 404 error (v1.x ApiException uses `code`).
function notFound(): Error & { code: number } {
  return Object.assign(new Error('not found'), { code: 404 });
}
function pvcItem(name: string) {
  return { metadata: { name } };
}

/** All single-resource deletes succeed; PVC list empty unless overridden. */
function allDeletesSucceed() {
  mockDeleteDeployment.mockResolvedValue({});
  mockDeleteServiceAccount.mockResolvedValue({});
  mockDeleteService.mockResolvedValue({});
  mockDeleteNetworkPolicy.mockResolvedValue({});
  mockDeleteSecret.mockResolvedValue({});
  mockDeletePvc.mockResolvedValue({});
  mockDeleteJob.mockResolvedValue({});
  mockListPvc.mockResolvedValue({ items: [] });
}
/** All single-resource deletes return 404 (resource absent). */
function allDeletesAbsent() {
  mockDeleteDeployment.mockRejectedValue(notFound());
  mockDeleteServiceAccount.mockRejectedValue(notFound());
  mockDeleteService.mockRejectedValue(notFound());
  mockDeleteNetworkPolicy.mockRejectedValue(notFound());
  mockDeleteSecret.mockRejectedValue(notFound());
  mockDeletePvc.mockRejectedValue(notFound());
  mockDeleteJob.mockRejectedValue(notFound());
  mockListPvc.mockResolvedValue({ items: [] });
}

describe('removeChannel — comprehensive name-based cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('deletes every resource a channel can own (both install paths)', () => {
    it('deletes Deployment, SA, Services, NetworkPolicy, all Secret variants, and the bootstrap Job by name', async () => {
      allDeletesSucceed();
      await removeChannel('http');

      expect(mockDeleteDeployment).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http',
        namespace: 'kubeclaw',
      });
      expect(mockDeleteServiceAccount).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http',
        namespace: 'kubeclaw',
      });
      // Both the channel Service and the metrics Service.
      const svcNames = mockDeleteService.mock.calls.map((c) => c[0].name);
      expect(svcNames).toEqual(
        expect.arrayContaining([
          'kubeclaw-channel-http',
          'kubeclaw-channel-http-metrics',
        ]),
      );
      expect(mockDeleteNetworkPolicy).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http-ingress',
        namespace: 'kubeclaw',
      });
      // All three Secret naming conventions: helm / bootstrap / legacy.
      const secNames = mockDeleteSecret.mock.calls.map((c) => c[0].name);
      expect(secNames).toEqual(
        expect.arrayContaining([
          'kubeclaw-channel-http', // helm user secret
          'kubeclaw-channel-http-credentials', // bootstrap credentials
          'kubeclaw-http-secrets', // legacy setup_channel
        ]),
      );
      expect(mockDeleteJob).toHaveBeenCalledWith({
        name: 'kubeclaw-bootstrap-http',
        namespace: 'kubeclaw',
      });
    });

    it('lists PVCs WITHOUT a label selector (the install paths do not label them consistently)', async () => {
      allDeletesSucceed();
      await removeChannel('http');
      expect(mockListPvc).toHaveBeenCalledWith({ namespace: 'kubeclaw' });
      // No labelSelector key.
      expect(mockListPvc.mock.calls[0][0]).not.toHaveProperty('labelSelector');
    });
  });

  describe('PVC name matching — groups/store/sessions/runtime + versioned runtime', () => {
    it('deletes the four standard PVCs and a versioned runtime PVC', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-groups'),
          pvcItem('kubeclaw-channel-http-store'),
          pvcItem('kubeclaw-channel-http-sessions'),
          pvcItem('kubeclaw-channel-http-runtime'),
          pvcItem('kubeclaw-channel-http-runtime-v2'), // upgrade-era
        ],
      });
      const result = await removeChannel('http');
      for (const n of [
        'kubeclaw-channel-http-groups',
        'kubeclaw-channel-http-store',
        'kubeclaw-channel-http-sessions',
        'kubeclaw-channel-http-runtime',
        'kubeclaw-channel-http-runtime-v2',
      ]) {
        expect(result.deleted).toContain(n);
      }
    });

    it('does NOT delete a different instance whose name shares a prefix (http vs http-staging)', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-groups'),
          pvcItem('kubeclaw-channel-http-staging-groups'), // different instance!
          pvcItem('kubeclaw-channel-http-staging-runtime'),
        ],
      });
      const result = await removeChannel('http');
      expect(result.deleted).toContain('kubeclaw-channel-http-groups');
      expect(result.deleted).not.toContain(
        'kubeclaw-channel-http-staging-groups',
      );
      expect(result.deleted).not.toContain(
        'kubeclaw-channel-http-staging-runtime',
      );
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      expect(deletedPvc).not.toContain('kubeclaw-channel-http-staging-groups');
    });

    it('ignores unrelated PVCs that merely contain the instance name', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-groups'),
          pvcItem('kubeclaw-groups'), // shared infra PVC — must not be touched
          pvcItem('kubeclaw-channel-http'), // no recognised suffix — skip
        ],
      });
      const result = await removeChannel('http');
      expect(result.deleted).toEqual(
        expect.arrayContaining(['kubeclaw-channel-http-groups']),
      );
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      expect(deletedPvc).toEqual(['kubeclaw-channel-http-groups']);
    });
  });

  describe('idempotent — 404 on everything reports absent, never throws', () => {
    it('a second removal reports all resources absent', async () => {
      allDeletesAbsent();
      const r1 = await removeChannel('gone');
      const r2 = await removeChannel('gone');
      expect(r1.deleted).toEqual([]);
      expect(r2.deleted).toEqual([]);
      expect(r2.alreadyAbsent).toEqual(
        expect.arrayContaining([
          'kubeclaw-channel-gone',
          'kubeclaw-channel-gone-credentials',
          'kubeclaw-gone-secrets',
          'kubeclaw-channel-gone-ingress',
          'kubeclaw-bootstrap-gone',
        ]),
      );
      expect(r2.summary).toContain('Already absent:');
    });
  });

  describe('error handling + summary', () => {
    it('propagates non-404 errors (e.g. 500) from a delete', async () => {
      const serverError = Object.assign(new Error('internal server error'), {
        statusCode: 500,
      });
      mockDeleteDeployment.mockRejectedValue(serverError);
      await expect(removeChannel('bad')).rejects.toThrow(
        'internal server error',
      );
    });

    it('summary lists deleted resources', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-prod-runtime')],
      });
      const result = await removeChannel('prod');
      expect(result.summary).toContain('Deleted:');
      expect(result.summary).toContain('kubeclaw-channel-prod');
      expect(result.summary).toContain('kubeclaw-channel-prod-runtime');
    });
  });
});
