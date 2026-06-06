/**
 * E2E tests for Story 181: upgrade_channel blue-green runtime PVC swap.
 *
 * DEFERRED: Requires minikube cluster, live LLM (LIVE_LLM_BASE_URL env var),
 * a bootstrapped channel instance with a steady-state Deployment, and a
 * second manifest hash registered in kubeclaw-channel-manifests ConfigMap.
 *
 * Implementation checklist when unblocking:
 *
 * Prerequisites:
 * 1. A channel instance (e.g. `tg-upgrade-e2e`) must already be running with
 *    a steady-state Deployment that mounts `kubeclaw-channel-tg-upgrade-e2e-runtime`.
 * 2. A new target manifest (different package.json version) must be published to
 *    kubeclaw-channel-manifests as `telegram-v2.json` with a new `manifestHash`.
 * 3. The kubeclaw-agent image in minikube must be built from the new manifest.
 *
 * Happy path (AC1 + AC2 + AC3 + AC4):
 * 1. Call `upgrade_channel` via admin-shell chat for instance `tg-upgrade-e2e` with
 *    `target_manifest_hash` = the v2 manifest hash.
 * 2. Assert via SSE stream: the admin receives an "upgrade started" reply containing
 *    the upgradeJobId, new PVC name (e.g. `-v2`), and old PVC name.
 * 3. Assert via kubectl: new PVC `kubeclaw-channel-tg-upgrade-e2e-runtime-v2` exists.
 * 4. Assert via kubectl: Job `kubeclaw-bootstrap-tg-upgrade-e2e-upgrade` is Running.
 * 5. Wait for Job to complete (simulate `commit_channel_config` upgrade path).
 * 6. Assert via kubectl: Deployment `kubeclaw-channel-tg-upgrade-e2e` has
 *    `spec.template.spec.volumes[name=runtime].persistentVolumeClaim.claimName`
 *    equal to the new PVC name.
 * 7. Wait for Deployment rollout: all pods should be Running with new PVC.
 * 8. Assert via kubectl: old PVC is deleted after UPGRADE_OLD_PVC_GRACE_SECONDS.
 *
 * Rollback path (AC5): MANIFEST_DIVERGENCE causes rollback:
 * 1. Run `upgrade_channel` with a mismatch-skill (mutates packages after `npm ci`).
 * 2. Assert via SSE stream: MANIFEST_DIVERGENCE text received.
 * 3. Assert via kubectl: new versioned PVC (e.g. `-v2`) is deleted.
 * 4. Assert via kubectl: old PVC still exists and Deployment still mounts old PVC.
 * 5. Assert: instance name `tg-upgrade-e2e:upgrade` is freed — second call succeeds.
 *
 * Concurrent rejection (AC3):
 * 1. Trigger `upgrade_channel` for `tg-upgrade-e2e`.
 * 2. Immediately trigger `upgrade_channel` again for same instance.
 * 3. Assert: second call returns ALREADY_IN_PROGRESS JSON.
 * 4. Assert: only one new PVC and one Job exist.
 *
 * Pattern after: e2e/minikube-live-bootstrap-channel.test.ts
 * Cleanup pattern: afterEach deletes the upgrade Job, new PVC, and restores Deployment.
 */
import { describe, it } from 'vitest';

const SKIP_REASON =
  'Story 181 e2e deferred: requires minikube + live LLM + bootstrapped channel instance + v2 manifest';

describe('Story 181: upgrade_channel blue-green PVC swap e2e (deferred)', () => {
  it.skip(
    SKIP_REASON,
    'happy path: upgrade_channel creates versioned PVC and upgrade Job',
    () => {},
  );
  it.skip(
    SKIP_REASON,
    'happy path: Deployment is patched to new PVC after commit_channel_config',
    () => {},
  );
  it.skip(
    SKIP_REASON,
    'happy path: old PVC is deleted after grace period',
    () => {},
  );
  it.skip(
    SKIP_REASON,
    'rollback: MANIFEST_DIVERGENCE deletes new PVC, Deployment retains old PVC',
    () => {},
  );
  it.skip(
    SKIP_REASON,
    'rollback: instance upgrade key freed after MANIFEST_DIVERGENCE — retry allowed',
    () => {},
  );
  it.skip(
    SKIP_REASON,
    'concurrent: second upgrade_channel for same instance returns ALREADY_IN_PROGRESS',
    () => {},
  );
});
