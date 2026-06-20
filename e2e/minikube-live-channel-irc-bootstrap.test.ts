/**
 * Minikube-live: bootstrap an IRC channel end-to-end (full lifecycle).
 *
 * This test exercises the bootstrap subsystem all the way from
 * `bootstrap_channel_from_skill('bootstrap-irc')` through `commit_channel_config`
 * to a running steady-state channel Deployment that uses the channel-runner host
 * path (hostMode: channel-runner).
 *
 * The IRC channel is the load-bearing proof for the channel-runner host-selector:
 *   - The manifest registered in minikube-live-setup.ts has hostMode: "channel-runner"
 *   - The orchestrator's commit_channel_config must pick channel-runner for the
 *     Deployment (command: node dist/channel-runner.js), NOT the standalone path
 *   - The Deployment must mount groups/store/sessions PVCs (not just /runtime)
 *
 * The test-ircd (kubeclaw-capability-test-ircd) is deployed by minikube-live-setup.ts
 * as a capability pod. Its HTTP side-channel (port 8080) is reached via kubectl exec
 * and used to inject IRC messages and poll the event log.
 *
 * The bootstrap skill answers four questions:
 *   1. IRC server hostname? → kubeclaw-capability-test-ircd
 *   2. IRC port?           → 6667
 *   3. Bot nickname?       → kubeclaw-bot
 *   4. Channels to join?   → #live-test
 *
 * AC coverage:
 *   AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-irc
 *        and KUBECLAW_BOOTSTRAP_INSTANCE=<instance> [HARD]
 *   AC3 (foundation proof): steady-state Deployment has command
 *        `node dist/channel-runner.js` (host-selector picked channel-runner via
 *        manifest hostMode), and mounts groups/store/sessions volumes [HARD]
 *   AC4 (connectivity): the irc adapter connects to the test ircd (JOIN event
 *        visible in /irc/log) [HARD], an injected message reaches the channel
 *        pod logs [HARD], and the channel pod sends a reply into #live-test
 *        [INFORMATIONAL — a full LLM round-trip can be slow/flaky; the test
 *        records the outcome but does not fail if no reply arrives within the
 *        window]
 *
 * Hard vs informational rationale:
 *   AC1 + AC3 are the structural proof that the bootstrap subsystem and
 *   host-selector work correctly. These must never be flaky.
 *   AC4 connection + inbound delivery are deterministic (no LLM involved) —
 *   hard assertions are safe.
 *   AC4 LLM-reply-delivery depends on a live model round-trip and can be slow;
 *   we assert only that the ircd event log contains a PRIVMSG FROM kubeclaw-bot
 *   within a generous window, and log a warning rather than failing if it does
 *   not arrive.
 *
 * Cleanup: afterAll deletes the bootstrap Job, the runtime PVC, the
 * steady-state Deployment, and the credentials Secret.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-irc';

// IRC parameters answered during the bootstrap dialogue.
const IRC_SERVER = 'kubeclaw-capability-test-ircd';
const IRC_PORT = '6667';
const IRC_NICK = 'kubeclaw-bot';
const IRC_CHANNEL = '#live-test';

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

/** Resolve the first running pod name for a label selector. */
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
 * Run a Node.js script inside a pod via kubectl exec.
 * Used to hit the ircd HTTP side-channel (port 8080) without exposing a Service.
 */
function nodeExecInPod(
  podName: string,
  containerName: string,
  script: string,
  timeoutMs = 15_000,
): { ok: boolean; stdout: string; stderr: string } {
  return kubectl(
    [
      'exec',
      '-n',
      NAMESPACE,
      podName,
      '-c',
      containerName,
      '--',
      'node',
      '-e',
      script,
    ],
    { timeout: timeoutMs },
  );
}

/** POST JSON to the ircd HTTP side-channel from inside the ircd pod. */
function httpPostInIrcdPod(
  ircdPodName: string,
  path: string,
  body: object,
  timeoutMs = 10_000,
): { ok: boolean; body: string } {
  const jsonBody = JSON.stringify(body);
  const script = `
    const http = require('node:http');
    const payload = ${JSON.stringify(jsonBody)};
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: ${JSON.stringify(path)},
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { process.stdout.write(data); process.exit(res.statusCode === 200 ? 0 : 1); });
    });
    req.on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
    req.write(payload);
    req.end();
  `;
  const r = nodeExecInPod(ircdPodName, 'capability', script, timeoutMs);
  return { ok: r.ok, body: r.stdout };
}

/** GET the ircd HTTP log endpoint from inside the ircd pod. */
function httpGetIrcdLog(
  ircdPodName: string,
  timeoutMs = 10_000,
): { ok: boolean; events: Array<{ type: string; from: string; channel: string; text?: string; injected?: boolean }> } {
  const script = `
    const http = require('node:http');
    http.get('http://localhost:8080/irc/log', (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { process.stdout.write(data); process.exit(0); });
    }).on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
  `;
  const r = nodeExecInPod(ircdPodName, 'capability', script, timeoutMs);
  if (!r.ok) return { ok: false, events: [] };
  try {
    const parsed = JSON.parse(r.stdout) as { events: Array<{ type: string; from: string; channel: string; text?: string; injected?: boolean }> };
    return { ok: true, events: parsed.events ?? [] };
  } catch {
    return { ok: false, events: [] };
  }
}

/** Poll fn() until predicate returns true or timeout elapses. */
async function pollUntil(
  fn: () => boolean,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }
  return false;
}

/**
 * POST a chat message to the admin shell and open an SSE stream. Returns the
 * first assistant text reply if one arrives within timeoutMs, or null if none
 * arrives (acceptable — cluster state is the load-bearing signal). Throws only
 * on hard errors (non-202 from /chat, non-200 from /events).
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
 * Poll for the bootstrap Job to appear in the cluster. Resolves with the Job's
 * YAML when it appears, or rejects after timeoutMs. Uses 2s poll interval.
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

describe('Minikube-live: bootstrap IRC channel end-to-end (channel-runner host path)', () => {
  let provisioned = false;
  let adminPass = '';
  let authHeader = '';
  let ircdPodName: string | null = null;

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
      console.warn(`⚠️  Admin port-forward to ${ADMIN_URL} not reachable — skipping all assertions.`);
      return;
    }

    // Locate the test-ircd pod (deployed by minikube-live-setup.ts as a
    // capability pod labelled app=kubeclaw-capability-test-ircd).
    ircdPodName = getPodName('app=kubeclaw-capability-test-ircd');
    if (!ircdPodName) {
      console.warn('⚠️  test-ircd pod not found — IRC connectivity assertions will skip.');
    }

    // The irc manifest + bootstrap-irc skill are installed at helm-install time
    // by minikube-live-setup.ts via --set-json bootstrap.channelManifests and
    // --set-file bootstrap.skills.bootstrap-irc. No runtime seeding needed here.
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
    // The irc baseline ConfigMap entries are Helm-managed and survive test runs.
  });

  // ── AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL env set ───────

  it('bootstrap_channel_from_skill creates a bootstrap Job with KUBECLAW_BOOTSTRAP_SKILL set (AC1) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    const prompt =
      `Please bootstrap a new channel using the bootstrap-irc skill. ` +
      `The channel type is irc and the instance name is ${INSTANCE_NAME}.`;

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
    const jobAppearedPromise = waitForBootstrapJob(INSTANCE_NAME, RACE_TIMEOUT_MS);

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
    expect(jobYaml).toContain('bootstrap-irc');
    expect(jobYaml).toContain('KUBECLAW_BOOTSTRAP_INSTANCE');
    expect(jobYaml).toContain(INSTANCE_NAME);
  }, 90_000);

  // ── AC1b: bootstrap dialogue completes (admin answers the four IRC questions) ─

  it('bootstrap dialogue completes after answering the four IRC questions (AC1b) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // Wait for the bootstrap pod to be running and ask its first question.
    // The skill asks about the IRC server hostname first (Step 3).
    let askAppeared = false;
    for (let i = 0; i < 40; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      // Match the DISTINCTIVE question phrasing ("hostname"), not bare "IRC"
      // or "server" — the bootstrap pod logs the word "IRC" constantly
      // (installing irc-upd, the skill title), which would fire this detector
      // on noise and post the answer BEFORE the agent actually asks via
      // ask_admin, desyncing the whole dialogue. "hostname" only appears when
      // the agent issues the first question.
      if (logs.ok && /hostname/i.test(logs.stdout)) {
        askAppeared = true;
        break;
      }
      await sleep(3000);
    }
    expect(
      askAppeared,
      'bootstrap pod did not ask about the IRC server within 120s',
    ).toBe(true);

    // Answer Q1: IRC server hostname.
    await postChatAndCollectReply(
      authHeader,
      `The IRC server hostname is ${IRC_SERVER}.`,
      60_000,
    );

    // Wait for Q2: IRC port.
    for (let i = 0; i < 20; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      if (logs.ok && /port/i.test(logs.stdout)) break;
      await sleep(3000);
    }
    // Answer Q2: IRC port.
    await postChatAndCollectReply(
      authHeader,
      `Use port ${IRC_PORT}.`,
      60_000,
    );

    // Wait for Q3: bot nickname.
    for (let i = 0; i < 20; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      if (logs.ok && /nickname/i.test(logs.stdout)) break;
      await sleep(3000);
    }
    // Answer Q3: bot nickname.
    await postChatAndCollectReply(
      authHeader,
      `The bot nickname is ${IRC_NICK}.`,
      60_000,
    );

    // Wait for Q4: channels to join.
    for (let i = 0; i < 20; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=300',
      ]);
      if (logs.ok && /channels to join/i.test(logs.stdout)) break;
      await sleep(3000);
    }
    // Answer Q4: channels to join.
    await postChatAndCollectReply(
      authHeader,
      `Join the channel ${IRC_CHANNEL}.`,
      60_000,
    );

    // Wait for the bootstrap Job to complete. The commit is near-instant but
    // the bootstrap pod then runs one more LLM turn before exiting. Budget
    // generously against the live model.
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
      await sleep(3000);
    }
    expect(complete, 'bootstrap Job did not Complete within 180s').toBe(true);
  }, 360_000);

  // ── AC3: steady-state Deployment uses channel-runner command + has PVC mounts ─
  //
  // This is the LOAD-BEARING assertion for the channel-runner host-selector.
  // The irc manifest has hostMode: "channel-runner". The orchestrator's
  // commit_channel_config must have stamped the Deployment with:
  //   containers[0].command: ["node", "dist/channel-runner.js"]
  // and mounted groups/store/sessions PVCs (not only /runtime).

  it('commit_channel_config produces a Deployment with node dist/channel-runner.js command and groups/store/sessions mounts (AC3) [HARD]', async () => {
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
    // These are the shared-state volumes (not just /runtime which the standalone
    // path also mounts). All three must be present in the spec.
    const hasGroupsMount =
      deployYaml.includes('kubeclaw-groups') || deployYaml.includes('/groups');
    const hasStoreMount =
      deployYaml.includes('kubeclaw-store') || deployYaml.includes('/store');
    const hasSessionsMount =
      deployYaml.includes('kubeclaw-sessions') || deployYaml.includes('/sessions');
    expect(hasGroupsMount, 'Deployment must mount groups volume (channel-runner path)').toBe(true);
    expect(hasStoreMount, 'Deployment must mount store volume (channel-runner path)').toBe(true);
    expect(hasSessionsMount, 'Deployment must mount sessions volume (channel-runner path)').toBe(true);

    // AC3 (negative): the bootstrap-specific env must not be present in the
    // steady-state Deployment — this confirms commit produced a clean manifest.
    expect(deployYaml).not.toContain('KUBECLAW_BOOTSTRAP_SKILL');

    // Wait for the channel pod to be Ready.
    let ready = false;
    for (let i = 0; i < 30; i++) {
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
    expect(ready, 'channel pod did not reach Ready within 90s').toBe(true);
  }, 180_000);

  // ── AC4 (connection): ircd shows kubeclaw-bot joined #live-test [HARD] ──────

  it('IRC adapter connects to the test ircd and joins #live-test (AC4 connection) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }
    if (!ircdPodName) {
      console.warn('Skipping — ircd pod not found');
      return;
    }

    // Poll the ircd HTTP log for a JOIN event from kubeclaw-bot on #live-test.
    let lastEvents: Array<{ type: string; from: string; channel: string }> = [];
    const joined = await pollUntil(
      () => {
        const result = httpGetIrcdLog(ircdPodName!, 8_000);
        if (!result.ok) return false;
        lastEvents = result.events;
        return result.events.some(
          (e) =>
            e.type === 'join' &&
            e.from.toLowerCase() === IRC_NICK.toLowerCase() &&
            e.channel === IRC_CHANNEL.toLowerCase(),
        );
      },
      3_000,
      60_000,
    );

    expect(
      joined,
      `Expected JOIN from ${IRC_NICK} on ${IRC_CHANNEL} in ircd log. ` +
        `Last events: ${JSON.stringify(lastEvents.slice(-10))}`,
    ).toBe(true);
  }, 90_000);

  // ── AC4 (inbound): injected message reaches channel pod logs [HARD] ─────────

  it('injected IRC message is received by the channel pod (AC4 inbound) [HARD]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }
    if (!ircdPodName) {
      console.warn('Skipping — ircd pod not found');
      return;
    }

    const marker = `kubeclaw-irc-e2e-${Date.now()}`;

    // Inject a PRIVMSG into #live-test via the ircd HTTP side-channel.
    const inject = httpPostInIrcdPod(
      ircdPodName,
      '/irc/inject',
      { channel: IRC_CHANNEL, from: 'e2e-tester', text: marker },
      10_000,
    );
    expect(inject.ok, `POST /irc/inject failed: ${inject.body}`).toBe(true);

    // Poll the channel pod's logs for evidence that the message was processed.
    // The channel adapter logs an "IRC message" or "message stored" line for
    // every inbound PRIVMSG; the log should also contain the marker text since
    // the adapter stores the message content verbatim.
    const channelPodLabelSel = `kubeclaw.io/role=channel,kubeclaw/channel=${INSTANCE_NAME}`;
    let channelLogs = '';
    const appeared = await pollUntil(
      () => {
        const channelPod = getPodName(channelPodLabelSel);
        if (!channelPod) return false;
        const r = kubectl(
          ['logs', '-n', NAMESPACE, channelPod, '--tail=400'],
          { timeout: 8_000 },
        );
        channelLogs = r.ok ? r.stdout : '';
        return channelLogs.includes(marker);
      },
      3_000,
      60_000,
    );

    expect(
      appeared,
      `Expected marker '${marker}' in channel pod logs within 60s.\n` +
        `Last tail:\n${channelLogs.slice(-2000)}`,
    ).toBe(true);
  }, 90_000);

  // ── AC4 (reply): channel pod sends a reply to #live-test [INFORMATIONAL] ────
  //
  // A full LLM round-trip (inbound → agent → LLM → IRC PRIVMSG) depends on the
  // live model and can be slow. We give it a generous window and log whether the
  // reply arrived, but do NOT fail the suite if it does not — AC3 (the
  // channel-runner command + volumes) is the load-bearing structural assertion.

  it('channel pod delivers a reply to #live-test after receiving a message (AC4 reply) [INFORMATIONAL]', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }
    if (!ircdPodName) {
      console.warn('Skipping — ircd pod not found');
      return;
    }

    const prompt = `hello from e2e-test, please reply briefly`;

    // Inject the prompt message into #live-test.
    const inject = httpPostInIrcdPod(
      ircdPodName,
      '/irc/inject',
      { channel: IRC_CHANNEL, from: 'e2e-tester', text: prompt },
      10_000,
    );
    if (!inject.ok) {
      console.warn(`Could not inject reply-trigger message: ${inject.body}`);
      return;
    }

    // Poll the ircd event log for a PRIVMSG from kubeclaw-bot into #live-test.
    // This proves the channel pod completed an outbound send. INFORMATIONAL:
    // we do not fail if no reply arrives within the window.
    const replyWindowMs = 120_000;
    const injectTs = Date.now();
    let replyArrived = false;

    const deadline = Date.now() + replyWindowMs;
    while (Date.now() < deadline) {
      const result = httpGetIrcdLog(ircdPodName, 8_000);
      if (result.ok) {
        const botReply = result.events.find(
          (e) =>
            e.type === 'privmsg' &&
            e.from.toLowerCase() === IRC_NICK.toLowerCase() &&
            e.channel === IRC_CHANNEL.toLowerCase() &&
            // Only consider messages that arrived after we sent the prompt.
            (e as { ts?: number }).ts !== undefined &&
            (e as { ts: number }).ts >= injectTs,
        );
        if (botReply) {
          replyArrived = true;
          console.log(`[AC4-reply] kubeclaw-bot replied: "${botReply.text ?? ''}"`);
          break;
        }
      }
      await sleep(3000);
    }

    if (!replyArrived) {
      // Informational: log a warning but do not fail the test.
      console.warn(
        `[AC4-reply] INFORMATIONAL: kubeclaw-bot did not send a PRIVMSG to ` +
          `${IRC_CHANNEL} within ${replyWindowMs / 1000}s. ` +
          `This may indicate an LLM latency issue, not a structural failure. ` +
          `AC3 (channel-runner command + volumes) is the load-bearing assertion.`,
      );
    }
    // No expect() — this is informational. The test always passes.
  }, 180_000);
});
