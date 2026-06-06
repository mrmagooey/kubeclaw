/**
 * E2E tests for Story 176: Manifest hash mismatch rejection.
 *
 * DEFERRED: Requires minikube cluster, live LLM (LIVE_LLM_BASE_URL env var),
 * and a mismatch-skill ConfigMap fixture. See Story 176 AC5 + notes for setup.
 *
 * Implementation checklist when unblocking:
 * 1. Seed a "mismatch skill" ConfigMap that runs `npm install left-pad` after
 *    `npm ci` to shift the lockfile hash away from the approved manifest.
 * 2. The mismatch skill should also compute sha256(post-deviate files) and pass
 *    that as runtime_pvc_lock_hash to prove the TOCTOU defense: the orchestrator
 *    still rejects even when the agent supplies a "correct" post-deviate hash.
 * 3. Assert via SSE stream that the rejection message arrives with the text
 *    "Bootstrap rejected" and mentions the channel_type.
 * 4. Assert via kubectl: no PVC, no Job, no Deployment, no Secret for the instance.
 * 5. Assert metric: curl localhost:9091/metrics | grep kubeclaw_bootstrap_manifest_mismatch_total
 *    must show value 1 for the tested channel_type.
 * 6. Assert retry: bootstrap_channel_from_skill with the same instance_name succeeds
 *    — it must not return "already in progress".
 *
 * Pattern after: e2e/minikube-live-admin-shell.test.ts
 * Cleanup pattern: afterEach calls remove_channel as in Story 174's e2e test.
 */
import { describe, it } from 'vitest';

const SKIP_REASON =
  'Story 176 e2e deferred: requires minikube + live LLM + mismatch-skill fixture';

describe('Story 176: manifest hash mismatch e2e (deferred)', () => {
  it.skip(SKIP_REASON, 'mismatch triggers MANIFEST_DIVERGENCE SSE message', () => {});
  it.skip(SKIP_REASON, 'no PVC, Job, Deployment, or Secret exist after rejection', () => {});
  it.skip(SKIP_REASON, 'kubeclaw_bootstrap_manifest_mismatch_total increments to 1', () => {});
  it.skip(SKIP_REASON, 'instance name freed: second bootstrap_channel_from_skill with same name succeeds', () => {});
  it.skip(SKIP_REASON, 'TOCTOU: agent-supplied correct post-deviate hash still causes rejection', () => {});
});
