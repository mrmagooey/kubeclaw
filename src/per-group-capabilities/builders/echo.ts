/**
 * Echo test builder for per-group capabilities.
 *
 * This builder is intentionally minimal: it produces a Deployment running
 * `busybox sleep infinity` with a stub HTTP /health endpoint backed by a
 * tiny nc-based listener. Its sole purpose is to give the e2e test suite
 * a concrete, fast-starting capability type to exercise the provisioning
 * path without any external image registry.
 *
 * PRODUCTION GUARD: This builder is only active when the `echo` capability
 * type appears in the Helm `perGroupCapabilities` values array (i.e. when
 * explicitly declared by the operator). It must never be auto-registered.
 * The builder does nothing beyond satisfy the CapabilitySpec shape — the
 * real reconciler (src/per-group-capabilities/reconciler.ts) drives K8s.
 */
import type { CapabilitySpec } from '../../capabilities/types.js';

/** The capability name for the echo test builder. */
export const ECHO_CAPABILITY_TYPE = 'echo';

/**
 * Build a CapabilitySpec for the echo test capability.
 *
 * The caller (helm value parser / test fixture) supplies `image` and
 * `scaleDownAfterIdleSeconds`. Defaults are test-safe minimums.
 *
 * Note: the echo capability runs `busybox sleep infinity` so it starts
 * instantly. For the e2e readiness probe to pass, the image must expose
 * `/health` on port 3000 — use `kubeclaw-echo:e2e-test` which bundles
 * a minimal HTTP health endpoint via socat/nc.
 */
export function buildEchoCapabilitySpec(opts: {
  image: string;
  scaleDownAfterIdleSeconds?: number;
}): CapabilitySpec {
  return {
    kind: 'http',
    name: ECHO_CAPABILITY_TYPE,
    image: opts.image,
    scope: 'group',
    scaleDownAfterIdleSeconds: opts.scaleDownAfterIdleSeconds ?? 120,
    volumeFromGroupPvc: false,
    credentialsFrom: 'none',
    port: 3000,
    healthPath: '/health',
    resources: {
      memoryRequest: '16Mi',
      memoryLimit: '64Mi',
      cpuRequest: '10m',
      cpuLimit: '100m',
    },
  };
}
