import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── K8s mock ──────────────────────────────────────────────────────────────────

const mockDeleteDeployment = vi.fn();
const mockDeleteSecret = vi.fn();
const mockDeletePvc = vi.fn();
const mockListPvc = vi.fn();
const mockDeleteJob = vi.fn();
const mockListJob = vi.fn();

vi.mock('@kubernetes/client-node', () => {
  class MockCoreV1Api {}
  class MockAppsV1Api {}
  class MockBatchV1Api {}

  return {
    KubeConfig: class {
      loadFromCluster() {}
      makeApiClient(cls: unknown) {
        if (cls === MockAppsV1Api) {
          return { deleteNamespacedDeployment: mockDeleteDeployment };
        }
        if (cls === MockBatchV1Api) {
          return {
            deleteNamespacedJob: mockDeleteJob,
            listNamespacedJob: mockListJob,
          };
        }
        return {
          deleteNamespacedSecret: mockDeleteSecret,
          deleteNamespacedPersistentVolumeClaim: mockDeletePvc,
          listNamespacedPersistentVolumeClaim: mockListPvc,
        };
      }
    },
    CoreV1Api: MockCoreV1Api,
    AppsV1Api: MockAppsV1Api,
    BatchV1Api: MockBatchV1Api,
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

/** Build a minimal PVC list response item. */
function pvcItem(name: string) {
  return { metadata: { name } };
}

/** Build a minimal Job list response item. */
function jobItem(name: string) {
  return { metadata: { name } };
}

describe('removeChannel — Story 177: label-based PVC + Job deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no Jobs found
    mockListJob.mockResolvedValue({ items: [] });
  });

  // ── AC1: all PVCs deleted by label ─────────────────────────────────────────

  describe('AC1 — label-based PVC deletion', () => {
    it('deletes all labelled PVCs regardless of name suffix', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-test-groups'),
          pvcItem('kubeclaw-channel-test-store'),
          pvcItem('kubeclaw-channel-test-sessions'),
          pvcItem('kubeclaw-channel-test-runtime'),
        ],
      });
      mockDeletePvc.mockResolvedValue({});

      const result = await removeChannel('test');

      expect(mockListPvc).toHaveBeenCalledWith({
        namespace: 'kubeclaw',
        labelSelector: 'kubeclaw-channel=test',
      });
      expect(result.deleted).toContain('kubeclaw-channel-test-groups');
      expect(result.deleted).toContain('kubeclaw-channel-test-store');
      expect(result.deleted).toContain('kubeclaw-channel-test-sessions');
      expect(result.deleted).toContain('kubeclaw-channel-test-runtime');
    });

    it('uses label selector on listNamespacedPersistentVolumeClaim', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({ items: [] });

      await removeChannel('my-channel');

      expect(mockListPvc).toHaveBeenCalledWith({
        namespace: 'kubeclaw',
        labelSelector: 'kubeclaw-channel=my-channel',
      });
    });
  });

  // ── AC2: summary lists every PVC touched ───────────────────────────────────

  describe('AC2 — summary format', () => {
    it('names each deleted PVC in the summary', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-prod-groups'),
          pvcItem('kubeclaw-channel-prod-runtime'),
        ],
      });
      mockDeletePvc.mockResolvedValue({});

      const result = await removeChannel('prod');

      expect(result.summary).toContain('Deleted:');
      expect(result.summary).toContain('kubeclaw-channel-prod-groups');
      expect(result.summary).toContain('kubeclaw-channel-prod-runtime');
    });

    it('reports "already absent" for PVCs that returned 404', async () => {
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-gone-groups')],
      });
      mockDeletePvc.mockRejectedValue(notFound());

      const result = await removeChannel('gone');

      expect(result.alreadyAbsent).toContain('kubeclaw-channel-gone-groups');
      expect(result.summary).toContain('Already absent:');
      expect(result.summary).toContain('kubeclaw-channel-gone-groups');
    });

    it('reports absent placeholder when no labelled PVCs exist', async () => {
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      mockListPvc.mockResolvedValue({ items: [] });

      const result = await removeChannel('ghost');

      expect(
        result.alreadyAbsent.some((s) => s.includes('kubeclaw-channel=ghost')),
      ).toBe(true);
      expect(result.summary).toContain('Already absent:');
    });
  });

  // ── AC3: idempotent ────────────────────────────────────────────────────────

  describe('AC3 — idempotent (second call reports everything absent)', () => {
    it('succeeds on second call with all resources reporting absent', async () => {
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      mockListPvc.mockResolvedValue({ items: [] });
      mockListJob.mockResolvedValue({ items: [] });

      const result1 = await removeChannel('my-instance');
      const result2 = await removeChannel('my-instance');

      expect(result1.deleted).toEqual([]);
      expect(result2.deleted).toEqual([]);
      // Both calls complete without throwing
    });
  });

  // ── AC4: backwards-compatible (legacy data-PVC-only channel) ───────────────

  describe('AC4 — backwards-compatible with legacy channel', () => {
    it('completes normally when only a legacy data-style PVC is found', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      // Legacy: only one PVC with the label (data PVC)
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-legacy-data')],
      });
      mockDeletePvc.mockResolvedValue({});

      const result = await removeChannel('legacy');

      expect(result.deleted).toContain('kubeclaw-channel-legacy');
      expect(result.deleted).toContain('kubeclaw-channel-legacy-data');
      expect(result.deleted).not.toContain('kubeclaw-channel-legacy-runtime');
      expect(result.summary).toContain('Deleted:');
    });

    it('completes normally when no PVCs exist at all (fully legacy channel)', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({ items: [] });

      const result = await removeChannel('old-channel');

      expect(result.deleted).toContain('kubeclaw-channel-old-channel');
      expect(result.deleted).toContain('kubeclaw-old-channel-secrets');
      // No PVCs deleted, but no error either
      expect(
        result.deleted.some((n) => n.includes('pvc') || n.includes('runtime')),
      ).toBe(false);
    });
  });

  // ── AC5: in-progress bootstrap (Job exists, no Deployment) ─────────────────

  describe('AC5 — in-progress bootstrap cleanup', () => {
    it('deletes bootstrap Job and runtime PVC when Deployment is absent', async () => {
      // No steady-state Deployment
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      // Bootstrap runtime PVC
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-boot-runtime')],
      });
      mockDeletePvc.mockResolvedValue({});
      // In-progress bootstrap Job
      mockListJob.mockResolvedValue({
        items: [jobItem('kubeclaw-bootstrap-boot')],
      });
      mockDeleteJob.mockResolvedValue({});

      const result = await removeChannel('boot');

      expect(result.deleted).toContain('kubeclaw-channel-boot-runtime');
      expect(result.deleted).toContain('kubeclaw-bootstrap-boot');
      expect(result.summary).toContain('kubeclaw-channel-boot-runtime');
      expect(result.summary).toContain('kubeclaw-bootstrap-boot');
    });

    it('uses label selector on listNamespacedJob', async () => {
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      mockListPvc.mockResolvedValue({ items: [] });
      mockListJob.mockResolvedValue({ items: [] });

      await removeChannel('bootstrap-instance');

      expect(mockListJob).toHaveBeenCalledWith({
        namespace: 'kubeclaw',
        labelSelector: 'kubeclaw-channel=bootstrap-instance',
      });
    });

    it('returns Jobs in summary when deleted', async () => {
      mockDeleteDeployment.mockRejectedValue(notFound());
      mockDeleteSecret.mockRejectedValue(notFound());
      mockListPvc.mockResolvedValue({
        items: [pvcItem('kubeclaw-channel-alpha-runtime')],
      });
      mockDeletePvc.mockResolvedValue({});
      mockListJob.mockResolvedValue({
        items: [jobItem('kubeclaw-bootstrap-alpha')],
      });
      mockDeleteJob.mockResolvedValue({});

      const result = await removeChannel('alpha');

      expect(result.deleted).toContain('kubeclaw-bootstrap-alpha');
      expect(result.summary).toContain('kubeclaw-bootstrap-alpha');
      expect(result.summary).toContain('Deleted:');
    });
  });

  // ── Pre-existing Story 1 regression tests (adapted for label-based arch) ───

  describe('regression — original Story 1 behaviour preserved', () => {
    it('reports deleted when deployment + secret + labelled PVCs all exist', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({
        items: [
          pvcItem('kubeclaw-channel-test-instance-groups'),
          pvcItem('kubeclaw-channel-test-instance-store'),
          pvcItem('kubeclaw-channel-test-instance-sessions'),
        ],
      });
      mockDeletePvc.mockResolvedValue({});

      const result = await removeChannel('test-instance');

      expect(result.deleted).toContain('kubeclaw-channel-test-instance');
      expect(result.deleted).toContain('kubeclaw-test-instance-secrets');
      expect(result.deleted).toContain('kubeclaw-channel-test-instance-groups');
      expect(result.deleted).toContain('kubeclaw-channel-test-instance-store');
      expect(result.deleted).toContain(
        'kubeclaw-channel-test-instance-sessions',
      );
      expect(result.alreadyAbsent).toEqual([]);
      expect(result.summary).toContain('Deleted:');
      expect(result.summary).toContain('kubeclaw-channel-test-instance');
    });

    it('propagates non-404 errors from deleteNamespacedDeployment', async () => {
      const serverError = Object.assign(new Error('internal server error'), {
        statusCode: 500,
      });
      mockDeleteDeployment.mockRejectedValue(serverError);

      await expect(removeChannel('bad-instance')).rejects.toThrow(
        'internal server error',
      );
    });

    it('passes the correct deployment and secret names to the K8s client', async () => {
      mockDeleteDeployment.mockResolvedValue({});
      mockDeleteSecret.mockResolvedValue({});
      mockListPvc.mockResolvedValue({ items: [] });

      await removeChannel('my-channel');

      expect(mockDeleteDeployment).toHaveBeenCalledWith({
        name: 'kubeclaw-channel-my-channel',
        namespace: 'kubeclaw',
      });
      expect(mockDeleteSecret).toHaveBeenCalledWith({
        name: 'kubeclaw-my-channel-secrets',
        namespace: 'kubeclaw',
      });
    });
  });
});
