/**
 * Minikube-live: bootstrap channel via admin shell (Story 174).
 *
 * Tests the end-to-end path: admin-shell chat command → bootstrap-runner → K8s Job + PVC.
 *
 * Strategy:
 *   - Use the chat API with the live LLM to issue a "bootstrap_channel_from_skill" command.
 *   - The LLM will call the tool internally; we verify the K8s Job and PVC appear in the cluster.
 *   - We do NOT test the full commit_channel_config round-trip (that needs a real Telegram token).
 *
 * AC coverage:
 *   AC1: channel-base image is present in minikube (verified by setup.ts ensureImage call)
 *   AC2: RBAC (bootstrap SA has only ConfigMap read) — verified via kubectl auth can-i
 *   AC3: bootstrap Job has KUBECLAW_SUPERUSER=true in env
 *   AC5: no steady-state Deployment before commit_channel_config; checked immediately after Job creation
 *
 * Cleanup: the afterAll hook deletes all resources created during the test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-test-telegram';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


describe('Minikube-live: bootstrap channel from skill (Story 174)', () => {
  let provisioned = false;
  let adminPass = '';

  beforeAll(async () => {
    // Read admin password from cluster Secret.
    const pwdResult = kubectl([
      'get',
      'secret',
      '-n',
      NAMESPACE,
      'kubeclaw-secrets',
      '-o',
      'jsonpath={.data.admin-http-password}',
    ]);
    if (pwdResult.ok && pwdResult.stdout) {
      adminPass = Buffer.from(pwdResult.stdout, 'base64').toString('utf8');
    }

    // Wait for admin port-forward to be reachable.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${ADMIN_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        // retry
      }
      await sleep(1000);
    }
    if (!provisioned) {
      console.warn(`⚠️  Admin port-forward to ${ADMIN_URL} not reachable.`);
    }
  });

  afterAll(() => {
    // Clean up all K8s resources created during the test.
    const resources = [
      ['job', `kubeclaw-bootstrap-${INSTANCE_NAME}`],
      ['pvc', `kubeclaw-channel-${INSTANCE_NAME}-runtime`],
      ['deployment', `kubeclaw-channel-${INSTANCE_NAME}`],
      ['secret', `kubeclaw-channel-${INSTANCE_NAME}-credentials`],
    ];
    for (const [kind, name] of resources) {
      kubectl(
        ['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found=true'],
        { allowFail: true, timeout: 10_000 },
      );
    }
  });

  // ── AC1: channel-base image is available in minikube ─────────────────────

  it('kubeclaw-agent:latest image is available in minikube docker daemon (AC1)', () => {
    const r = spawnSync(
      'bash',
      [
        '-c',
        'eval $(minikube docker-env) && docker image inspect kubeclaw-agent:latest --format "{{.Id}}" 2>/dev/null',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(
      r.status,
      'kubeclaw-agent:latest not present in minikube',
    ).toBe(0);
    expect(r.stdout.trim(), 'Image ID should be non-empty').toBeTruthy();
  });

  // ── AC2: bootstrap RBAC — SA can only read ConfigMaps, not create Secrets ─

  it('bootstrap ServiceAccount cannot create Secrets (RBAC AC2)', () => {
    const r = kubectl([
      'auth',
      'can-i',
      'create',
      'secrets',
      '--namespace',
      NAMESPACE,
      '--as',
      `system:serviceaccount:${NAMESPACE}:kubeclaw-bootstrap`,
    ]);
    // auth can-i returns exit 1 when not allowed, which means ok=false
    expect(r.ok, 'bootstrap SA should NOT be allowed to create Secrets').toBe(
      false,
    );
  });

  it('bootstrap ServiceAccount CAN get ConfigMaps (RBAC AC2)', () => {
    // The bootstrap Role grants get/list on specific named ConfigMaps only
    // (resourceNames: kubeclaw-bootstrap-skills, kubeclaw-channel-manifests).
    // kubectl auth can-i for a generic resource returns "no" when the Role uses
    // resourceNames — we must check the specific named resource to get "yes".
    const r = kubectl([
      'auth',
      'can-i',
      'get',
      'configmaps/kubeclaw-bootstrap-skills',
      '--namespace',
      NAMESPACE,
      '--as',
      `system:serviceaccount:${NAMESPACE}:kubeclaw-bootstrap`,
    ]);
    expect(r.ok, 'bootstrap SA should be allowed to get ConfigMaps').toBe(true);
  });

  // ── Bootstrap trigger via admin shell LLM chat ────────────────────────────

  it('admin shell "bootstrap telegram channel" creates K8s Job and PVC within 120s', async () => {
    expect(provisioned, 'admin port-forward not live').toBe(true);
    expect(adminPass, 'admin password not populated').toBeTruthy();

    const authHeader = basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass);

    // Fire the chat POST — we don't gate on the LLM reply arriving.
    // The real outcome (Job + PVC created) is verified by sibling assertions via kubectl.
    const chatRes = await fetch(`${ADMIN_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        text: `Please bootstrap a new telegram channel. Use instance_name="${INSTANCE_NAME}" and skill_name="bootstrap-telegram". Do not wait for credentials — just start the bootstrap Job immediately.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(chatRes.status, 'POST /chat should return 202').toBe(202);

    // The Job and PVC assertions that matter are in the sibling tests below,
    // which poll kubectl for up to 30s. We just need the /chat to be accepted.
  }, 30_000);

  // ── AC3: K8s Job has KUBECLAW_SUPERUSER=true ──────────────────────────────

  it('bootstrap Job has KUBECLAW_SUPERUSER=true env var (AC3)', async () => {
    const jobName = `kubeclaw-bootstrap-${INSTANCE_NAME}`;

    // Poll up to 30s for the Job to appear (the LLM chat may have just created it).
    let envJson = '';
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'job',
        jobName,
        '-n',
        NAMESPACE,
        '--ignore-not-found=true',
        '-o',
        'jsonpath={.spec.template.spec.containers[0].env}',
      ]);
      if (r.ok && r.stdout.trim() && r.stdout.trim() !== 'null') {
        envJson = r.stdout.trim();
        break;
      }
      await sleep(1000);
    }

    expect(
      envJson,
      `Job ${jobName} not found or has no env within 30s`,
    ).toBeTruthy();

    const envVars = JSON.parse(envJson) as Array<{
      name: string;
      value?: string;
    }>;
    const superuserVar = envVars.find((e) => e.name === 'KUBECLAW_SUPERUSER');
    expect(
      superuserVar,
      'KUBECLAW_SUPERUSER env var missing from Job',
    ).toBeTruthy();
    expect(superuserVar?.value).toBe('true');
  });

  // ── AC5: no steady-state Deployment before commit_channel_config ──────────

  it('no steady-state Deployment exists before commit_channel_config is called (AC5)', () => {
    const deployName = `kubeclaw-channel-${INSTANCE_NAME}`;
    const r = kubectl([
      'get',
      'deployment',
      deployName,
      '-n',
      NAMESPACE,
      '--ignore-not-found=true',
      '-o',
      'jsonpath={.metadata.name}',
    ]);
    const found = r.ok && r.stdout.trim() === deployName;
    expect(
      found,
      `Steady-state Deployment ${deployName} must NOT exist before commit_channel_config`,
    ).toBe(false);
  });

  // ── PVC is created with correct name ─────────────────────────────────────

  it('runtime PVC kubeclaw-channel-<instance>-runtime exists in namespace', async () => {
    const pvcName = `kubeclaw-channel-${INSTANCE_NAME}-runtime`;

    let found = false;
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'pvc',
        pvcName,
        '-n',
        NAMESPACE,
        '--ignore-not-found=true',
        '-o',
        'jsonpath={.metadata.name}',
      ]);
      if (r.ok && r.stdout.trim() === pvcName) {
        found = true;
        break;
      }
      await sleep(1000);
    }

    expect(found, `PVC ${pvcName} not found in ${NAMESPACE} within 30s`).toBe(
      true,
    );
  });
});
