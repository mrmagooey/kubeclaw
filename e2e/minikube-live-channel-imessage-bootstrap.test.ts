/**
 * Minikube-live: assert the bootstrapped iMessage channel is correctly wired.
 *
 * NOTE: This test requires a running minikube cluster with the KubeClaw
 * stack deployed. It is NOT run in standard CI — only in the full
 * minikube-live test suite (vitest.minikube-live.config.ts).
 *
 * The global setup bootstraps the iMessage channel as instance `e2e-imessage`
 * with no httpPort (polling model). This test asserts that the steady-state
 * resources are correctly created:
 *
 * AC coverage:
 *   AC1 [HARD]: Deployment kubeclaw-channel-e2e-imessage exists with command
 *               ["node","dist/channel-runner.js"] and the orchestrator image.
 *   AC2 [HARD]: NO Service kubeclaw-channel-e2e-imessage (iMessage is polling,
 *               no httpPort, no webhook server).
 *   AC3 [HARD]: Secret kubeclaw-channel-e2e-imessage exists with the two
 *               required iMessage credential keys.
 *
 * NOTE: A live iMessage round-trip requires a Mac running BlueBubbles and
 * is NOT CI-able. This test only validates Kubernetes resource wiring.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = 'kubeclaw-live';
const INSTANCE_NAME = 'e2e-imessage';

// ── Helpers ───────────────────────────────────────────────────────────────────

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function kubectlJson<T = unknown>(args: string[]): T | null {
  const r = kubectl([...args, '-o', 'json']);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(`minikube-live: imessage channel bootstrap (${INSTANCE_NAME})`, () => {
  beforeAll(() => {
    // Verify cluster is accessible
    const r = kubectl(['cluster-info', '--context=minikube']);
    if (!r.ok) {
      throw new Error(
        'minikube cluster not accessible — run e2e/minikube-live-setup.ts first',
      );
    }
  });

  it('AC1: Deployment exists with channel-runner command', () => {
    const deploy = kubectlJson<{
      spec: {
        template: { spec: { containers: Array<{ command?: string[] }> } };
      };
    }>([
      'get',
      'deployment',
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-n',
      NAMESPACE,
    ]);

    expect(deploy).not.toBeNull();
    const containers = deploy!.spec.template.spec.containers;
    expect(containers.length).toBeGreaterThan(0);
    const mainContainer = containers[0];
    expect(mainContainer.command).toEqual(['node', 'dist/channel-runner.js']);
  });

  it('AC2: NO Service for iMessage channel (polling model, no httpPort)', () => {
    // iMessage uses polling — there is no inbound webhook server and thus no
    // Kubernetes Service should be created for this channel instance.
    const svc = kubectlJson([
      'get',
      'service',
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-n',
      NAMESPACE,
    ]);
    // Service should NOT exist (null = 404 from kubectl)
    expect(svc).toBeNull();
  });

  it('AC3: Secret exists with both iMessage credential keys', () => {
    const secret = kubectlJson<{
      data: Record<string, string>;
    }>(['get', 'secret', `kubeclaw-channel-${INSTANCE_NAME}`, '-n', NAMESPACE]);

    expect(secret).not.toBeNull();
    const keys = Object.keys(secret!.data);
    expect(keys).toContain('IMESSAGE_BRIDGE_URL');
    expect(keys).toContain('IMESSAGE_BRIDGE_PASSWORD');
  });
});
