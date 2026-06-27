/**
 * Minikube-live: bootstrap a Matrix channel end-to-end (structural lifecycle).
 *
 * NOTE: This test requires a real minikube cluster with at least 8 GiB RAM
 * and a running KubeClaw orchestrator (deployed via minikube-live-setup.ts).
 * It does NOT require a real Matrix homeserver — it validates only the
 * structural bootstrap path (Job creation, manifest staging, commit_channel_config
 * call) up to the point where real Matrix credentials would be needed for the
 * steady-state Deployment to connect to the homeserver.
 *
 * A live Matrix homeserver round-trip (/sync, sending messages) requires:
 *   1. A real Matrix homeserver (matrix.org or self-hosted)
 *   2. A bot account with a valid access token
 *   3. Rooms configured in KubeClaw groups
 *
 * These requirements make a fully automated CI test impractical. The structural
 * assertions below are the CI-safe subset:
 *   AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-matrix
 *   AC3: steady-state Deployment uses channel-runner host path and correct
 *        environment variables (MATRIX_* mounted from Secret)
 *
 * Run this test only in an environment where real Matrix credentials can be
 * provided via env vars. When those vars are absent the test is skipped.
 *
 * Usage:
 *   MATRIX_HOMESERVER_URL_E2E="https://matrix.org" \
 *   MATRIX_USER_ID_E2E="@mybot:matrix.org" \
 *   MATRIX_ACCESS_TOKEN_E2E="syt_..." \
 *   npx vitest run \
 *     --config vitest.minikube-live.config.ts \
 *     e2e/minikube-live-channel-matrix-bootstrap.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-matrix';

const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL_E2E ?? '';
const MATRIX_USER_ID = process.env.MATRIX_USER_ID_E2E ?? '';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN_E2E ?? '';

const HAS_CREDS =
  !!MATRIX_HOMESERVER_URL && !!MATRIX_USER_ID && !!MATRIX_ACCESS_TOKEN;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_CREDS)('Minikube-live: Matrix channel bootstrap', () => {
  const adminPass = process.env.KUBECLAW_LIVE_ADMIN_PASSWORD ?? 'test-pass';

  beforeAll(async () => {
    // The matrix manifest ships in values.yaml and is registered at startup.
    // The bootstrap skill is also loaded from bootstrap-matrix.md.
    // No extra setup step is needed here.
  }, 60_000);

  afterAll(async () => {
    // Clean up resources created during this test.
    kubectl([
      'delete',
      'job',
      '-n',
      NAMESPACE,
      '-l',
      `kubeclaw.io/channel-instance=${INSTANCE_NAME}`,
      '--ignore-not-found',
    ]);
    kubectl([
      'delete',
      'deployment',
      '-n',
      NAMESPACE,
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '--ignore-not-found',
    ]);
    kubectl([
      'delete',
      'secret',
      '-n',
      NAMESPACE,
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '--ignore-not-found',
    ]);
    kubectl([
      'delete',
      'pvc',
      '-n',
      NAMESPACE,
      `kubeclaw-channel-${INSTANCE_NAME}-runtime`,
      '--ignore-not-found',
    ]);
  }, 60_000);

  it('AC1: bootstrap Job is created with correct bootstrap skill env var', async () => {
    // Trigger bootstrap via the admin HTTP API.
    const response = await fetch(`${ADMIN_URL}/api/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass),
      },
      body: JSON.stringify({
        tool: 'bootstrap_channel_from_skill',
        params: {
          skill_name: 'bootstrap-matrix',
          instance_name: INSTANCE_NAME,
        },
      }),
    });
    expect(response.ok).toBe(true);

    // Wait for bootstrap Job to appear.
    let jobFound = false;
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'jobs',
        '-n',
        NAMESPACE,
        '-l',
        `kubeclaw.io/channel-instance=${INSTANCE_NAME}`,
        '-o',
        'name',
      ]);
      if (r.stdout.trim()) {
        jobFound = true;
        break;
      }
      await sleep(2_000);
    }
    expect(jobFound, 'bootstrap Job should appear within 60s').toBe(true);

    // Verify the Job has KUBECLAW_BOOTSTRAP_SKILL=bootstrap-matrix.
    const jobDesc = kubectl([
      'get',
      'job',
      '-n',
      NAMESPACE,
      '-l',
      `kubeclaw.io/channel-instance=${INSTANCE_NAME}`,
      '-o',
      'jsonpath={.items[0].spec.template.spec.containers[0].env}',
    ]);
    expect(jobDesc.stdout).toContain('bootstrap-matrix');
  }, 120_000);

  it('AC3: steady-state Deployment uses channel-runner and mounts MATRIX_* env vars', async () => {
    // Provide credentials to the bootstrap Job (simulating admin responses).
    // This is done by posting the answer messages to the IPC endpoint.
    const answers = [
      { answer: MATRIX_HOMESERVER_URL },
      { answer: MATRIX_USER_ID },
      { answer: MATRIX_ACCESS_TOKEN },
    ];

    for (const { answer } of answers) {
      await fetch(`${ADMIN_URL}/api/ipc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass),
        },
        body: JSON.stringify({
          tool: 'send_bootstrap_answer',
          params: { instance_name: INSTANCE_NAME, answer },
        }),
      });
      await sleep(1_000);
    }

    // Wait for steady-state Deployment.
    let deployFound = false;
    for (let i = 0; i < 60; i++) {
      const r = kubectl([
        'get',
        'deployment',
        '-n',
        NAMESPACE,
        `kubeclaw-channel-${INSTANCE_NAME}`,
        '-o',
        'name',
      ]);
      if (r.ok) {
        deployFound = true;
        break;
      }
      await sleep(3_000);
    }
    expect(
      deployFound,
      'steady-state Deployment should appear within 180s',
    ).toBe(true);

    // Verify the Deployment uses the channel-runner command.
    const deployDesc = kubectl([
      'get',
      'deployment',
      '-n',
      NAMESPACE,
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-o',
      'jsonpath={.spec.template.spec.containers[0].command}',
    ]);
    expect(deployDesc.stdout).toContain('channel-runner');

    // Verify Secret exists with Matrix creds.
    const secretDesc = kubectl([
      'get',
      'secret',
      '-n',
      NAMESPACE,
      `kubeclaw-channel-${INSTANCE_NAME}`,
      '-o',
      'jsonpath={.data}',
    ]);
    expect(secretDesc.ok).toBe(true);
    // The secret data keys should include the Matrix env vars.
    expect(secretDesc.stdout).toContain('MATRIX_HOMESERVER_URL');
  }, 300_000);
});
