import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── K8s mock ──────────────────────────────────────────────────────────────────

const mockDeleteDeployment = vi.fn();
const mockDeleteServiceAccount = vi.fn();
const mockDeleteService = vi.fn();
const mockDeleteNetworkPolicy = vi.fn();
const mockDeleteIngress = vi.fn();
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
          return {
            deleteNamespacedNetworkPolicy: mockDeleteNetworkPolicy,
            deleteNamespacedIngress: mockDeleteIngress,
          };
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
  mockDeleteIngress.mockResolvedValue({});
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
  mockDeleteIngress.mockRejectedValue(notFound());
  mockDeleteSecret.mockRejectedValue(notFound());
  mockDeletePvc.mockRejectedValue(notFound());
  mockDeleteJob.mockRejectedValue(notFound());
  mockListPvc.mockResolvedValue({ items: [] });
}

describe('removeChannel — comprehensive name-based cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('deletes every resource a channel can own (both install paths)', () => {
    it('deletes Deployment, SA, Services, Ingress, NetworkPolicy, all Secret variants, and both bootstrap Jobs by name', async () => {
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
      const svcNames = mockDeleteService.mock.calls.map((c) => c[0].name);
      expect(svcNames).toEqual(
        expect.arrayContaining([
          'kubeclaw-channel-http',
          'kubeclaw-channel-http-metrics',
        ]),
      );
      // Helm Ingress (named like <base>) + the ingress NetworkPolicy.
      expect(mockDeleteIngress).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http',
        namespace: 'kubeclaw',
      });
      expect(mockDeleteNetworkPolicy).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http-ingress',
        namespace: 'kubeclaw',
      });
      expect(mockDeleteNetworkPolicy).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-http-sidecar-egress',
        namespace: 'kubeclaw',
      });
      // All three Secret naming conventions: helm / bootstrap / legacy.
      const secNames = mockDeleteSecret.mock.calls.map((c) => c[0].name);
      expect(secNames).toEqual(
        expect.arrayContaining([
          'kubeclaw-channel-http',
          'kubeclaw-channel-http-credentials',
          'kubeclaw-http-secrets',
        ]),
      );
      // Initial bootstrap Job + the upgrade Job.
      const jobNames = mockDeleteJob.mock.calls.map((c) => c[0].name);
      expect(jobNames).toEqual(
        expect.arrayContaining([
          'kubeclaw-bootstrap-http',
          'kubeclaw-bootstrap-http-upgrade',
        ]),
      );
    });

    it('deletes the sidecar-egress NetworkPolicy (treat 404 as absent, not error)', async () => {
      allDeletesSucceed();
      const result = await removeChannel('http');
      // The sidecar-egress netpol delete must have been attempted
      const netpolNames = mockDeleteNetworkPolicy.mock.calls.map((c: any) => c[0].name);
      expect(netpolNames).toContain('kubeclaw-channel-http-sidecar-egress');
      // And it should appear in the deleted list
      expect(result.deleted).toContain('networkpolicy/kubeclaw-channel-http-sidecar-egress');
    });

    it('does NOT delete a different instance sidecar-egress netpol (http vs http-staging cross-instance safety)', async () => {
      allDeletesSucceed();
      await removeChannel('http');
      // Specifically targeting http-sidecar-egress — must NOT touch http-staging-sidecar-egress
      const netpolNames = mockDeleteNetworkPolicy.mock.calls.map((c: any) => c[0].name);
      expect(netpolNames).not.toContain('kubeclaw-channel-http-staging-sidecar-egress');
    });

    it('lists PVCs WITHOUT a label selector (the install paths do not label them consistently)', async () => {
      allDeletesSucceed();
      await removeChannel('http');
      expect(mockListPvc).toHaveBeenCalledWith({ namespace: 'kubeclaw' });
      expect(mockListPvc.mock.calls[0][0]).not.toHaveProperty('labelSelector');
    });

    it('records resources as <kind>/<name> so same-named resources are distinct', async () => {
      allDeletesSucceed();
      const result = await removeChannel('http');
      expect(result.deleted).toEqual(
        expect.arrayContaining([
          'deployment/kubeclaw-channel-http',
          'serviceaccount/kubeclaw-channel-http',
          'service/kubeclaw-channel-http',
          'service/kubeclaw-channel-http-metrics',
          'ingress/kubeclaw-channel-http',
          'networkpolicy/kubeclaw-channel-http-ingress',
          'networkpolicy/kubeclaw-channel-http-sidecar-egress',
          'secret/kubeclaw-channel-http',
          'secret/kubeclaw-channel-http-credentials',
          'secret/kubeclaw-http-secrets',
          'job/kubeclaw-bootstrap-http',
          'job/kubeclaw-bootstrap-http-upgrade',
        ]),
      );
    });
  });

  describe('PVC name matching — groups/store/sessions/runtime/auxsession + versioned runtime', () => {
    it('deletes the auxsession PVC', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-auxsession'),
        ],
      });
      const result = await removeChannel('http');
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      expect(deletedPvc).toContain('kubeclaw-channel-http-auxsession');
      expect(result.deleted).toContain('persistentvolumeclaim/kubeclaw-channel-http-auxsession');
    });

    it('does NOT delete a different instance auxsession PVC (http vs http-staging)', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-auxsession'),
          pvcItem('kubeclaw-channel-http-staging-auxsession'),
        ],
      });
      await removeChannel('http');
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      expect(deletedPvc).toContain('kubeclaw-channel-http-auxsession');
      expect(deletedPvc).not.toContain('kubeclaw-channel-http-staging-auxsession');
    });

    it('deletes the four standard PVCs and a versioned runtime PVC', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-groups'),
          pvcItem('kubeclaw-channel-http-store'),
          pvcItem('kubeclaw-channel-http-sessions'),
          pvcItem('kubeclaw-channel-http-runtime'),
          pvcItem('kubeclaw-channel-http-runtime-v2'),
        ],
      });
      const result = await removeChannel('http');
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      for (const n of [
        'kubeclaw-channel-http-groups',
        'kubeclaw-channel-http-store',
        'kubeclaw-channel-http-sessions',
        'kubeclaw-channel-http-runtime',
        'kubeclaw-channel-http-runtime-v2',
      ]) {
        expect(deletedPvc).toContain(n);
        expect(result.deleted).toContain(`persistentvolumeclaim/${n}`);
      }
    });

    it('does NOT delete a different instance whose name shares a prefix (http vs http-staging)', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-http-groups'),
          pvcItem('kubeclaw-channel-http-staging-groups'),
          pvcItem('kubeclaw-channel-http-staging-runtime'),
        ],
      });
      await removeChannel('http');
      const deletedPvc = mockDeletePvc.mock.calls.map((c) => c[0].name);
      expect(deletedPvc).toEqual(['kubeclaw-channel-http-groups']);
      expect(deletedPvc).not.toContain('kubeclaw-channel-http-staging-groups');
      expect(deletedPvc).not.toContain('kubeclaw-channel-http-staging-runtime');
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
      await removeChannel('http');
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
          'deployment/kubeclaw-channel-gone',
          'secret/kubeclaw-channel-gone-credentials',
          'secret/kubeclaw-gone-secrets',
          'ingress/kubeclaw-channel-gone',
          'networkpolicy/kubeclaw-channel-gone-ingress',
          'networkpolicy/kubeclaw-channel-gone-sidecar-egress',
          'job/kubeclaw-bootstrap-gone',
          'job/kubeclaw-bootstrap-gone-upgrade',
        ]),
      );
      expect(r2.summary).toContain('Already absent:');
    });
  });

  describe('best-effort — one resource failing does NOT abort the rest', () => {
    it('records a non-404 error (e.g. a 403 RBAC gap) as failed and still deletes everything else', async () => {
      allDeletesSucceed();
      // ServiceAccount delete fails with 403 (the exact RBAC cascade the e2e
      // exposed: with fail-fast this orphaned every later resource).
      mockDeleteServiceAccount.mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 403\nMessage: forbidden'), {
          code: 403,
        }),
      );
      const result = await removeChannel('http');
      // Did NOT throw; the failure is recorded.
      expect(
        result.failed.some((f) =>
          f.startsWith('serviceaccount/kubeclaw-channel-http'),
        ),
      ).toBe(true);
      expect(result.summary).toContain('FAILED (could not delete):');
      // Everything AFTER the failed SA was still deleted.
      expect(result.deleted).toEqual(
        expect.arrayContaining([
          'service/kubeclaw-channel-http',
          'networkpolicy/kubeclaw-channel-http-ingress',
          'secret/kubeclaw-channel-http-credentials',
          'job/kubeclaw-bootstrap-http',
        ]),
      );
    });

    it('a list failure (e.g. PVC list) is recorded but does not abort the Job deletes after it', async () => {
      allDeletesSucceed();
      mockListPvc.mockRejectedValue(new Error('list boom'));
      const result = await removeChannel('http');
      expect(
        result.failed.some((f) =>
          f.startsWith('persistentvolumeclaims (list)'),
        ),
      ).toBe(true);
      expect(result.deleted).toContain('job/kubeclaw-bootstrap-http');
    });
  });

  describe('summary', () => {

    it('summary lists deleted resources', async () => {
      allDeletesSucceed();
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-prod-runtime')],
      });
      const result = await removeChannel('prod');
      expect(result.summary).toContain('Deleted:');
      expect(result.summary).toContain('deployment/kubeclaw-channel-prod');
      expect(result.summary).toContain(
        'persistentvolumeclaim/kubeclaw-channel-prod-runtime',
      );
    });
  });
});
