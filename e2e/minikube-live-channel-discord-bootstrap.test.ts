/**
 * Minikube-live: bootstrap a Discord channel end-to-end (structural lifecycle).
 *
 * NOTE: This test requires a real minikube cluster with at least 8 GiB RAM
 * and a running KubeClaw orchestrator (deployed via minikube-live-setup.ts).
 * It does NOT require a real Discord bot token — it validates only the
 * structural bootstrap path (Job creation, manifest staging, commit_channel_config
 * call) up to the point where a real bot token would be needed for the
 * steady-state Deployment to connect to the Discord Gateway.
 *
 * A live Discord gateway round-trip (login, message receipt/send) requires:
 *   1. A real Discord bot token
 *   2. A Discord server with the bot invited
 *   3. The MessageContent privileged intent enabled in the Developer Portal
 *
 * These requirements make a fully automated CI test impractical. The structural
 * assertions below (AC1 + AC3 analogue) are the CI-safe subset:
 *   AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-discord
 *   AC3: steady-state Deployment uses channel-runner host path and correct
 *        environment variable (DISCORD_BOT_TOKEN mounted from Secret)
 *
 * Run this test only in an environment where a real Discord bot token can be
 * provided via DISCORD_BOT_TOKEN_E2E env var. When that var is absent the test
 * is automatically skipped.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN_E2E="your-bot-token" npx vitest run \
 *     --config vitest.minikube-live.config.ts \
 *     e2e/minikube-live-channel-discord-bootstrap.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-discord';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN_E2E ?? '';

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

describe.skipIf(!DISCORD_BOT_TOKEN)(
  'Minikube-live: Discord channel bootstrap',
  () => {
    const adminPass = process.env.KUBECLAW_LIVE_ADMIN_PASSWORD ?? 'test-pass';

    beforeAll(async () => {
      // Ensure the discord manifest is registered (it ships in values.yaml by default)
      // and bootstrap skill is loaded.
      // The live setup test registers manifests from values.yaml — no extra step needed.
    }, 60_000);

    afterAll(async () => {
      // Clean up the bootstrap Job and steady-state resources created during this test.
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

    it(
      '[AC1] bootstrap Job is created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-discord',
      async () => {
        // Trigger bootstrap via admin shell HTTP API
        const res = await fetch(`${ADMIN_URL}/admin/shell`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(
              KUBECLAW_LIVE_ADMIN_USERNAME,
              adminPass,
            ),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `bootstrap_channel_from_skill(type="discord", instance_name="${INSTANCE_NAME}")`,
          }),
        });
        expect(res.ok).toBe(true);

        // Poll for the bootstrap Job
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
            'jsonpath={.items[0].metadata.name}',
          ]);
          if (r.ok && r.stdout.trim()) {
            jobFound = true;
            // Verify the bootstrap skill env var
            const jobDetail = kubectl([
              'get',
              'job',
              '-n',
              NAMESPACE,
              r.stdout.trim(),
              '-o',
              'jsonpath={.spec.template.spec.initContainers[0].env}',
            ]);
            expect(jobDetail.stdout).toContain('bootstrap-discord');
            break;
          }
          await sleep(2000);
        }
        expect(jobFound).toBe(true);
      },
      120_000,
    );

    it(
      '[AC3] steady-state Deployment uses channel-runner host path and mounts DISCORD_BOT_TOKEN',
      async () => {
        // The bootstrap Job runs npm ci and then calls commit_channel_config.
        // We drive that call directly via the admin shell, bypassing the LLM dialogue.
        const res = await fetch(`${ADMIN_URL}/admin/shell`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(
              KUBECLAW_LIVE_ADMIN_USERNAME,
              adminPass,
            ),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `commit_channel_config(channel_type="discord", instance_name="${INSTANCE_NAME}", secret_data={"DISCORD_BOT_TOKEN": "${DISCORD_BOT_TOKEN}"})`,
          }),
        });
        expect(res.ok).toBe(true);

        // Poll for the steady-state Deployment
        let deploymentFound = false;
        for (let i = 0; i < 30; i++) {
          const r = kubectl([
            'get',
            'deployment',
            '-n',
            NAMESPACE,
            `kubeclaw-channel-${INSTANCE_NAME}`,
            '--ignore-not-found',
            '-o',
            'jsonpath={.metadata.name}',
          ]);
          if (r.ok && r.stdout.trim()) {
            deploymentFound = true;

            // Verify channel-runner command path
            const cmdR = kubectl([
              'get',
              'deployment',
              '-n',
              NAMESPACE,
              `kubeclaw-channel-${INSTANCE_NAME}`,
              '-o',
              'jsonpath={.spec.template.spec.containers[0].command}',
            ]);
            expect(cmdR.stdout).toContain('channel-runner.js');

            // Verify DISCORD_BOT_TOKEN is referenced from the Secret
            const envR = kubectl([
              'get',
              'deployment',
              '-n',
              NAMESPACE,
              `kubeclaw-channel-${INSTANCE_NAME}`,
              '-o',
              'jsonpath={.spec.template.spec.containers[0].envFrom}',
            ]);
            expect(envR.stdout).toContain(
              `kubeclaw-channel-${INSTANCE_NAME}`,
            );
            break;
          }
          await sleep(2000);
        }
        expect(deploymentFound).toBe(true);
      },
      120_000,
    );
  },
);
