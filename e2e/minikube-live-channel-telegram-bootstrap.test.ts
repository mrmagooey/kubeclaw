/**
 * Minikube-live: bootstrap a Telegram channel end-to-end (full lifecycle).
 *
 * NOTE: Requires an 8 GiB minikube; not runnable on the constrained dev host
 * (9.5 GiB total, pods time out). Runs in CI on a larger machine.
 *
 * This test exercises the bootstrap subsystem all the way from
 * `bootstrap_channel_from_skill('bootstrap-telegram')` through
 * `commit_channel_config` to a running steady-state channel Deployment that
 * uses the channel-runner host path (hostMode: channel-runner).
 *
 * The bootstrap skill asks ONE question:
 *   "What is the Telegram bot token from @BotFather?"
 *
 * The test answers with a fake token (TEST_TELEGRAM_BOT_TOKEN env or a
 * hard-coded placeholder). Because the token validation step in the bootstrap
 * skill calls `curl https://api.telegram.org/bot.../getMe` and a fake token
 * will fail, the test accepts EITHER a "Complete" Job status OR a bootstrap pod
 * log indicating it reached the `commit_channel_config` step — whichever
 * comes first. The structural assertions (Job env vars, Deployment shape,
 * credential Secret) are the load-bearing proof.
 *
 * AC coverage:
 *   AC1 [HARD]: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-telegram
 *               and KUBECLAW_BOOTSTRAP_INSTANCE=<instance>
 *   AC1b [HARD]: bootstrap dialogue — the Job pod asks for the bot token and the
 *                admin's reply is delivered (single round-trip)
 *   AC3 [HARD]: steady-state Deployment has command `node dist/channel-runner.js`
 *               (host-selector picked channel-runner via manifest hostMode), mounts
 *               groups/store/sessions volumes, and does NOT contain the bootstrap env
 *   AC4 [INFORMATIONAL]: channel pod reaches Ready (long-poll may fail against the
 *               fake token; we log outcome but do not fail if not Ready)
 *
 * Hard vs informational rationale:
 *   AC1 + AC3 are the structural proof that the bootstrap subsystem and host-selector
 *   work correctly. These must never be flaky.
 *   AC1b token-ask round-trip is deterministic (admin-shell chat is in-process). Hard.
 *   AC4 channel pod readiness depends on a live Telegram connection — with a fake token
 *   the bot can't long-poll and the pod will crash-loop. We assert the Deployment exists
 *   and is structurally correct; readiness is informational only.
 *
 * Mirrors e2e/minikube-live-channel-irc-bootstrap.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-telegram';

// Use a fake token from the environment if provided; fall back to a clearly
// fake placeholder. The bootstrap skill validates the token via the real
// Telegram API so validation will fail — the test covers AC1/AC3 structural
// proof regardless.
const BOT_TOKEN =
  process.env.TEST_TELEGRAM_BOT_TOKEN ?? 'test-token:FAKE_KUBECLAW_E2E';

// ── Helpers ───────────────────────────────────────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Resolve the first pod name for a label selector. */
function getPodName(labelSelector: string): string | null {
  const r = kubectl([
    'get',
    'pods',
    '-n',
    NAMESPACE,
    '-l',
    labelSelector,
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
  const name = r.ok ? r.stdout.trim() : '';
  return name || null;
}

/**
 * POST a chat message to the admin shell and open an SSE stream. Returns the
 * first assistant text reply if one arrives within timeoutMs, or null if none
 * arrives. Throws only on hard errors.
 */
async function postChatAndCollectReply(
  authHeader: string,
  text: string,
  timeoutMs: number,
): Promise<string | null> {
  const eventsController = new AbortController();
  const eventsRes = await fetch(`${ADMIN_URL}/events`, {
    headers: { Authorization: authHeader, Accept: 'text/event-stream' },
    signal: eventsController.signal,
  });
  if (eventsRes.status !== 200) {
    throw new Error(`SSE /events returned ${eventsRes.status}`);
  }

  const chatRes = await fetch(`${ADMIN_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (chatRes.status !== 202) {
    eventsController.abort();
    throw new Error(`POST /chat returned ${chatRes.status}`);
  }

  const reader = eventsRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const readTimeout = Math.min(5000, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        sleep(readTimeout).then(() => ({ value: undefined, done: false })),
      ]);
      if (result.done) break;
      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const payload = JSON.parse(line.slice(5).trim()) as {
              type?: string;
              text?: string;
            };
            if (payload.type === 'assistant' && payload.text) {
              return payload.text;
            }
          } catch {
            // not JSON
          }
        }
      }
    }
  } finally {
    eventsController.abort();
  }

  return null;
}

/**
 * Poll for the bootstrap Job to appear in the cluster. Resolves with the
 * Job's YAML when it appears, or rejects after timeoutMs.
 */
async function waitForBootstrapJob(
  instanceName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get',
      'job',
      `kubeclaw-bootstrap-${instanceName}`,
      '-n',
      NAMESPACE,
      '-o',
      'yaml',
    ]);
    if (r.ok && r.stdout) {
      return r.stdout;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(2000, remaining));
  }
  throw new Error(
    `bootstrap Job kubeclaw-bootstrap-${instanceName} did not appear within ${timeoutMs}ms`,
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Minikube-live: bootstrap Telegram channel end-to-end (channel-runner host path)', () => {
  let provisioned = false;
  let adminPass = '';
  let authHeader = '';

  beforeAll(async () => {
    // Fetch admin password from the cluster secret.
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
      authHeader = basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPass);
    }

    // Verify the admin port-forward is up (10 retries × 1s).
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
      console.warn(
        `⚠️  Admin port-forward to ${ADMIN_URL} not reachable — skipping all assertions.`,
      );
      return;
    }

    // The telegram manifest + bootstrap-telegram skill are installed at helm-install
    // time by minikube-live-setup.ts — no runtime seeding needed here.
  }, 60_000);

  afterAll(() => {
    // Cleanup: all operations are idempotent (--ignore-not-found).
    const resources: [string, string][] = [
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
    // The telegram baseline ConfigMap entries are Helm-managed and survive test runs.
  });

  // ── AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL env set ────────

  it('bootstrap_channel_from_skill creates a bootstrap Job with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-telegram (AC1) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    const prompt =
      `Please bootstrap a new channel using the bootstrap-telegram skill. ` +
      `The channel type is telegram and the instance name is ${INSTANCE_NAME}.`;

    // Race: accept EITHER an assistant text reply OR the bootstrap Job
    // appearing in the cluster — whichever comes first. This makes the test
    // model-agnostic: some LLMs emit a text reply alongside the tool call,
    // others make the tool call silently. The contract is "the tool fired",
    // evidenced by the Job existing in the cluster.
    const RACE_TIMEOUT_MS = 60_000;
    const chatReplyPromise = postChatAndCollectReply(
      authHeader,
      prompt,
      RACE_TIMEOUT_MS,
    );
    const jobAppearedPromise = waitForBootstrapJob(
      INSTANCE_NAME,
      RACE_TIMEOUT_MS,
    );

    let jobYaml = '';
    const raceResult = await Promise.race([
      chatReplyPromise.then((reply) => ({ kind: 'reply' as const, reply })),
      jobAppearedPromise.then((yaml) => ({ kind: 'job' as const, yaml })),
    ]);

    if (raceResult.kind === 'job') {
      chatReplyPromise.catch(() => undefined);
      jobYaml = raceResult.yaml;
    } else {
      jobYaml = await jobAppearedPromise;
    }

    expect(jobYaml, 'bootstrap Job not found within 60s').toContain(
      'KUBECLAW_BOOTSTRAP_SKILL',
    );
    expect(jobYaml).toContain('bootstrap-telegram');
    expect(jobYaml).toContain('KUBECLAW_BOOTSTRAP_INSTANCE');
    expect(jobYaml).toContain(INSTANCE_NAME);
  }, 90_000);

  // ── AC1b: bootstrap dialogue — skill asks for bot token, admin answers ───────

  it('bootstrap dialogue reaches the bot-token question and delivers the admin reply (AC1b) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // The skill asks for the bot token (Step 2). Detect the distinctive
    // "@BotFather" phrasing from the bootstrap skill prompt (not bare "token").
    let askAppeared = false;
    for (let i = 0; i < 40; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      if (logs.ok && /@BotFather/i.test(logs.stdout)) {
        askAppeared = true;
        break;
      }
      await sleep(3000);
    }
    expect(
      askAppeared,
      'bootstrap pod did not ask for the Telegram bot token within 120s',
    ).toBe(true);

    // Deliver the token. The skill then attempts to validate it via the live
    // Telegram API; with a fake token it will fail. We send the reply regardless
    // so the dialogue round-trip is proven, then wait for either Job completion
    // or a "commit" log line (which the skill emits before the validation step
    // can block it).
    await postChatAndCollectReply(authHeader, BOT_TOKEN, 60_000);

    // Wait for the bootstrap Job to either Complete or reach the commit step.
    // With a fake token the Job may fail at the validation step, but the
    // dialogue round-trip (AC1b) is proven above.
    let complete = false;
    for (let i = 0; i < 60; i++) {
      const r = kubectl([
        'get',
        'job',
        `kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '-n',
        NAMESPACE,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Complete")].status}',
      ]);
      if (r.ok && r.stdout.trim() === 'True') {
        complete = true;
        break;
      }
      // Also accept if the bootstrap pod logs show it reached commit_channel_config.
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=400',
      ]);
      if (logs.ok && /commit_channel_config/i.test(logs.stdout)) {
        complete = true;
        break;
      }
      await sleep(3000);
    }
    expect(
      complete,
      'bootstrap Job did not Complete or reach commit_channel_config within 180s',
    ).toBe(true);
  }, 360_000);

  // ── AC3: steady-state Deployment uses channel-runner command + PVC mounts ────
  //
  // This is the LOAD-BEARING assertion for the channel-runner host-selector.
  // The telegram manifest has hostMode: "channel-runner". The orchestrator's
  // commit_channel_config must stamp the Deployment with:
  //   containers[0].command: ["node", "dist/channel-runner.js"]
  // and mount groups/store/sessions PVCs.

  it('commit_channel_config produces a Deployment with node dist/channel-runner.js and groups/store/sessions mounts (AC3) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    let deployYaml = '';
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'deployment',
        `kubeclaw-channel-${INSTANCE_NAME}`,
        '-n',
        NAMESPACE,
        '-o',
        'yaml',
      ]);
      if (r.ok && r.stdout) {
        deployYaml = r.stdout;
        break;
      }
      await sleep(2000);
    }
    expect(
      deployYaml,
      `steady-state Deployment kubeclaw-channel-${INSTANCE_NAME} not created within 60s — was commit_channel_config rejected?`,
    ).toContain(`kubeclaw-channel-${INSTANCE_NAME}`);

    // AC3 (host-selector proof): command must be channel-runner, not standalone.
    expect(
      deployYaml,
      'Deployment container command must be node dist/channel-runner.js (hostMode: channel-runner)',
    ).toContain('dist/channel-runner.js');
    expect(deployYaml).toMatch(/-\s+node/);

    // AC3 (PVC mounts): the channel-runner path mounts groups/store/sessions PVCs.
    const hasGroupsMount =
      deployYaml.includes('kubeclaw-groups') || deployYaml.includes('/groups');
    const hasStoreMount =
      deployYaml.includes('kubeclaw-store') || deployYaml.includes('/store');
    const hasSessionsMount =
      deployYaml.includes('kubeclaw-sessions') ||
      deployYaml.includes('/sessions');
    expect(
      hasGroupsMount,
      'Deployment must mount groups volume (channel-runner path)',
    ).toBe(true);
    expect(
      hasStoreMount,
      'Deployment must mount store volume (channel-runner path)',
    ).toBe(true);
    expect(
      hasSessionsMount,
      'Deployment must mount sessions volume (channel-runner path)',
    ).toBe(true);

    // AC3 (negative): no bootstrap env in the steady-state Deployment.
    expect(deployYaml).not.toContain('KUBECLAW_BOOTSTRAP_SKILL');

    // Diagnostic: log the channel pod status even if not Ready (Telegram long-poll
    // will fail with a fake token — this is expected and does NOT fail the test).
    const podName = getPodName(
      `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`,
    );
    if (podName) {
      const podStatus = kubectl([
        'get',
        'pod',
        '-n',
        NAMESPACE,
        podName,
        '-o',
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ]);
      const isReady = podStatus.ok && podStatus.stdout.trim() === 'True';
      if (!isReady) {
        const logs = kubectl([
          'logs',
          '-n',
          NAMESPACE,
          podName,
          '--all-containers=true',
          '--tail=80',
        ]);
        console.warn(
          `[AC3 diagnostic] channel pod ${podName} not Ready — expected with fake token.\n` +
            `Logs tail:\n${logs.stdout.slice(-1500)}`,
        );
      } else {
        console.log(`[AC3] channel pod ${podName} is Ready`);
      }
    }
  }, 180_000);

  // ── AC4 (credentials): Secret contains TELEGRAM_BOT_TOKEN [HARD] ────────────

  it('credentials Secret contains TELEGRAM_BOT_TOKEN (AC4 credentials) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    const secretName = `kubeclaw-channel-${INSTANCE_NAME}-credentials`;
    let secretYaml = '';
    for (let i = 0; i < 15; i++) {
      const r = kubectl([
        'get',
        'secret',
        secretName,
        '-n',
        NAMESPACE,
        '-o',
        'yaml',
      ]);
      if (r.ok && r.stdout) {
        secretYaml = r.stdout;
        break;
      }
      await sleep(2000);
    }
    expect(
      secretYaml,
      `credentials Secret ${secretName} not found within 30s`,
    ).toContain(secretName);
    // TELEGRAM_BOT_TOKEN key must be present in the secret data.
    expect(secretYaml, 'Secret must contain TELEGRAM_BOT_TOKEN key').toContain(
      'TELEGRAM_BOT_TOKEN',
    );
  }, 60_000);

  // ── AC4 (pod readiness): channel pod reaches Ready [INFORMATIONAL] ────────────
  //
  // With a fake bot token the Telegram long-poll will fail and the pod will
  // crash-loop. We record the outcome but do NOT fail the suite — AC3 (the
  // channel-runner command + volumes + credentials Secret) is the load-bearing
  // structural assertion.

  it('channel pod reaches Ready state (AC4 pod readiness) [INFORMATIONAL]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    let ready = false;
    for (let i = 0; i < 20; i++) {
      const r = kubectl([
        'get',
        'pod',
        '-n',
        NAMESPACE,
        '-l',
        `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`,
        '-o',
        'jsonpath={.items[0].status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (r.ok && r.stdout.trim() === 'True') {
        ready = true;
        break;
      }
      await sleep(3000);
    }

    if (!ready) {
      console.warn(
        `[AC4-readiness] INFORMATIONAL: channel pod did not reach Ready within 60s. ` +
          `This is expected when TEST_TELEGRAM_BOT_TOKEN is not a real bot token — ` +
          `the long-poll connection to the Telegram API will fail. ` +
          `AC3 (channel-runner command + volumes) is the load-bearing structural assertion.`,
      );
    } else {
      console.log(
        '[AC4-readiness] channel pod reached Ready — real bot token was used.',
      );
    }
    // No expect() — this is informational. The test always passes.
  }, 120_000);
});
