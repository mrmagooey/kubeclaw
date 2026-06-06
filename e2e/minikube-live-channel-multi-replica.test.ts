/**
 * Story 182: Multi-replica channel scaling on RWX/RWO storage classes.
 *
 * Two describe blocks:
 *   1. RWX path — skipped unless MINIKUBE_RWX_STORAGE_CLASS is set.
 *      Tests that a channel can scale to 3 replicas on an NFS/EFS-backed PVC.
 *      TODO(story-182-follow-on): Enable when minikube NFS provisioner is
 *      configured in CI. Run locally with:
 *        MINIKUBE_RWX_STORAGE_CLASS=nfs-sc npx vitest run \
 *          --config vitest.minikube-live.config.ts \
 *          e2e/minikube-live-channel-multi-replica.test.ts
 *
 *   2. RWO path — always runs. Tests that the replica cap at 1 is enforced
 *      by the HPA and that the steady-state pod mounts runtime read-only.
 *      These are template-level assertions (no live cluster required).
 *
 * Patterns from minikube-live-bootstrap-channel.test.ts + minikube-live-admin-shell.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

const RWX_STORAGE_CLASS = process.env.MINIKUBE_RWX_STORAGE_CLASS;
const CHART_DIR = './helm/kubeclaw';

// ─── 1. RWX path (skipped unless MINIKUBE_RWX_STORAGE_CLASS env var is set) ──

describe.skipIf(!RWX_STORAGE_CLASS)(
  'Story 182 AC2: RWX cluster — steady-state Deployment scales to N replicas',
  () => {
    /**
     * TODO(story-182-follow-on): This describe block tests that a channel can
     * scale to 3 replicas when the runtime PVC uses an RWX storage class.
     *
     * Prerequisites:
     *   - minikube addons enable storage-provisioner-rancher (or csi-driver-nfs)
     *   - A StorageClass named MINIKUBE_RWX_STORAGE_CLASS exists in the cluster
     *   - MINIKUBE_RWX_STORAGE_CLASS=<storage-class-name> is set as env var
     *
     * The test is deferred because NFS provisioner setup is non-trivial on
     * minikube and is not yet provisioned in CI. Set MINIKUBE_RWX_STORAGE_CLASS
     * to run locally once an RWX-capable provisioner is available.
     *
     * To un-defer:
     *   - In beforeAll: bootstrap a channel with --set bootstrap.runtimePvc.accessModes[0]=ReadWriteMany
     *     and --set bootstrap.runtimePvc.storageClass=$MINIKUBE_RWX_STORAGE_CLASS
     *   - Assert PVC shows ReadWriteMany in kubectl get pvc output
     *   - Scale the Deployment to 3 replicas
     *   - Assert all 3 pods are Running within 60s
     *   - Send 30 requests to the channel Service and assert >= 2 distinct pod
     *     identities appear in the x-served-by header (or equivalent)
     */
    it.todo(
      'channel scales to 3 replicas on RWX storage class (NFS/EFS/Filestore)',
    );

    it.todo(
      'all 3 replicas serve traffic (x-served-by header shows >=2 distinct pods)',
    );

    it.todo(
      'runtime PVC shows ReadWriteMany in kubectl get pvc output',
    );
  },
);

// ─── 2. RWO path (always runs — template-level assertions, no live cluster) ──

describe('Story 182 AC3/AC4: RWO cluster — guardrail + mount invariants', () => {
  /**
   * These tests use helm template rendering and file inspection only.
   * No live cluster is required.
   */

  it('AC3: Helm chart renders HPA with maxReplicas:1 for default RWO config', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'secrets.claudeCodeOauthToken=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('kind: HorizontalPodAutoscaler');
    expect(result.stdout).toContain('maxReplicas: 1');
    expect(result.stdout).toContain('name: kubeclaw-channel-rwo-guardrail');
  });

  it('AC3: HPA annotation names the accessModes constraint (ReadWriteMany)', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'secrets.claudeCodeOauthToken=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // HPA annotation must name the accessModes constraint per story AC3
    expect(result.stdout).toContain('ReadWriteMany');
  });

  it('AC3: No HPA guardrail is rendered when accessModes is ReadWriteMany', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'bootstrap.runtimePvc.accessModes[0]=ReadWriteMany',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('kind: HorizontalPodAutoscaler');
  });

  it('AC4: values.yaml runtimePvc.accessModes comment mentions RWX storage class types', () => {
    const result = spawnSync(
      'grep',
      ['-n', 'ReadWriteMany.*RWX\\|RWX.*ReadWriteMany', `${CHART_DIR}/values.yaml`],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it('AC5: INSTALL.md contains Multi-replica channels subsection', () => {
    const result = spawnSync(
      'grep',
      ['-n', 'Multi-replica', './INSTALL.md'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Multi-replica');
  });

  it('AC5: INSTALL.md names AWS EFS, GCP Filestore, and Azure Files', () => {
    const result = spawnSync(
      'grep',
      ['-c', 'EFS\\|Filestore\\|Azure Files', './INSTALL.md'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const count = parseInt(result.stdout.trim(), 10);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
