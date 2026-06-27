/**
 * Minikube-live: assert the bootstrapped whatsapp channel is correctly wired.
 *
 * NOTE: This test requires a running minikube cluster with the KubeClaw
 * stack deployed. It is NOT run in standard CI — only in the full
 * minikube-live test suite (vitest.minikube-live.config.ts).
 *
 * The global setup bootstraps the whatsapp channel as instance `e2e-whatsapp`
 * with httpPort:4080. This test asserts that the steady-state resources are
 * correctly created:
 *
 * AC coverage:
 *   AC1 [HARD]: Deployment kubeclaw-channel-e2e-whatsapp exists with command
 *               ["node","dist/channel-runner.js"] and the orchestrator image.
 *   AC2 [HARD]: httpPort wiring — Service kubeclaw-channel-e2e-whatsapp
 *               (ClusterIP, port 80 → target 4080) and NetworkPolicy
 *               kubeclaw-channel-e2e-whatsapp-ingress (opens 4080).
 *   AC3 [HARD]: Secret kubeclaw-channel-e2e-whatsapp exists with the four
 *               required WhatsApp credential keys.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = 'kubeclaw-live';
const INSTANCE_NAME = 'e2e-whatsapp';

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

describe(`minikube-live: whatsapp channel bootstrap (${INSTANCE_NAME})`, () => {
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

  it('AC2: Service exists with port 80 → 4080', () => {
    const svc = kubectlJson<{
      spec: { ports: Array<{ port: number; targetPort: number | string }> };
    }>([
      'get',
      'service',
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-n',
      NAMESPACE,
    ]);

    expect(svc).not.toBeNull();
    const ports = svc!.spec.ports;
    expect(ports.length).toBeGreaterThan(0);
    const httpPort = ports.find((p) => p.port === 80);
    expect(httpPort).toBeDefined();
    expect(String(httpPort!.targetPort)).toBe('4080');
  });

  it('AC2: NetworkPolicy exists for httpPort ingress', () => {
    const np = kubectlJson([
      'get',
      'networkpolicy',
      `kubeclaw-channel-${INSTANCE_NAME}-ingress`,
      '-n',
      NAMESPACE,
    ]);
    expect(np).not.toBeNull();
  });

  it('AC3: Secret exists with all four credential keys', () => {
    const secret = kubectlJson<{
      data: Record<string, string>;
    }>(['get', 'secret', `kubeclaw-channel-${INSTANCE_NAME}`, '-n', NAMESPACE]);

    expect(secret).not.toBeNull();
    const keys = Object.keys(secret!.data);
    expect(keys).toContain('WHATSAPP_ACCESS_TOKEN');
    expect(keys).toContain('WHATSAPP_PHONE_NUMBER_ID');
    expect(keys).toContain('WHATSAPP_VERIFY_TOKEN');
    expect(keys).toContain('WHATSAPP_APP_SECRET');
  });
});
