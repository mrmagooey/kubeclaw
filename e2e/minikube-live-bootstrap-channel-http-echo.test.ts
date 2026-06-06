/**
 * Minikube-live: bootstrap an HTTP-echo channel end-to-end (full lifecycle).
 *
 * This test exercises the bootstrap subsystem (Stories 174-184) all the way
 * from `bootstrap_channel_from_skill` through `commit_channel_config` to a
 * running steady-state channel pod that serves HTTP.
 *
 * The channel under test (http-echo) is intentionally minimal:
 *   - No npm dependencies (Node stdlib only)
 *   - Single channel-entry.js written by the bootstrap skill via local_write
 *   - Reads PORT from env, responds 200 to any HTTP request with a JSON echo
 *
 * The skill (helm/kubeclaw/files/bootstrap-skills/bootstrap-http-echo.md)
 * and a stub manifest are pre-registered into the cluster ConfigMaps before
 * the dialogue starts — the test bypasses the admin LLM for registration
 * (deterministic kubectl) but drives the actual bootstrap dialogue through
 * /chat (LLM-mediated, brittle by nature).
 *
 * AC coverage:
 *   AC1: bootstrap Job created with KUBECLAW_BOOTSTRAP_SKILL=bootstrap-http-echo
 *   AC2: bootstrap pod completes (Job condition Complete=True)
 *   AC3: commit_channel_config succeeds (no MANIFEST_DIVERGENCE rejection)
 *   AC4: steady-state Deployment created with kubeclaw-agent:claude image,
 *        runtime PVC mounted read-only at /runtime, no KUBECLAW_SUPERUSER env
 *   AC5: HTTP GET / against the channel pod returns 200 with a JSON body
 *        containing the channel instance name
 *
 * Cleanup: afterAll deletes the bootstrap-skills ConfigMap entry, the
 * channel-manifests ConfigMap entry, the bootstrap Job, the runtime PVC,
 * the steady-state Deployment, and the credentials Secret.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;
const INSTANCE_NAME = 'e2e-http-echo';
const CHANNEL_PORT = 18764; // arbitrary high port; passed in via dialogue
const LOCAL_FORWARD_PORT = 18765; // host-side port-forward target

// http-echo manifest: zero npm dependencies. Both files are JSON literals so
// the runtime PVC's contents can be computed-and-hashed deterministically.
const HTTP_ECHO_PACKAGE_JSON = JSON.stringify({
  name: 'http-echo-runtime',
  version: '1.0.0',
  dependencies: {},
});
const HTTP_ECHO_PACKAGE_LOCK_JSON = JSON.stringify({
  name: 'http-echo-runtime',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'http-echo-runtime',
      version: '1.0.0',
    },
  },
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

function computeManifestHash(
  packageJsonStr: string,
  packageLockJsonStr: string,
): string {
  const pj = JSON.parse(packageJsonStr);
  const pl = JSON.parse(packageLockJsonStr);
  const canon = canonicalJson(pj) + '\n' + canonicalJson(pl);
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}

const HTTP_ECHO_MANIFEST_HASH = computeManifestHash(
  HTTP_ECHO_PACKAGE_JSON,
  HTTP_ECHO_PACKAGE_LOCK_JSON,
);

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean; stdin?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: opts.stdin ? ['pipe', 'pipe', 'pipe'] : 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.stdin,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Wait for an SSE reply from the admin shell after a POST /chat. Returns the
 * first assistant reply text received within timeoutMs. Pattern copied from
 * e2e/minikube-live-bootstrap-channel.test.ts (Story 174's test).
 */
async function chatAndWaitForReply(
  authHeader: string,
  text: string,
  timeoutMs = 180_000,
): Promise<string> {
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

  throw new Error(`No assistant reply within ${timeoutMs}ms`);
}

/**
 * Patch the kubeclaw-channel-manifests ConfigMap with the http-echo entry.
 * Bypasses the admin LLM (deterministic). The ConfigMap shape mirrors what
 * the orchestrator's ChannelManifestReconciler produces.
 */
function seedManifestConfigMap(): void {
  const entry = {
    channel_type: 'http-echo',
    package_json: HTTP_ECHO_PACKAGE_JSON,
    package_lock_json: HTTP_ECHO_PACKAGE_LOCK_JSON,
    manifest_hash: HTTP_ECHO_MANIFEST_HASH,
    source: 'test-fixture',
  };
  // Strategic merge patch: add `data.http-echo.json` without disturbing other
  // entries the chart may have registered.
  const patch = JSON.stringify({
    data: { 'http-echo.json': JSON.stringify(entry) },
  });
  const r = kubectl([
    'patch',
    'configmap',
    'kubeclaw-channel-manifests',
    '-n',
    NAMESPACE,
    '--type=merge',
    '-p',
    patch,
  ]);
  if (!r.ok) {
    throw new Error(
      `Failed to seed channel-manifests ConfigMap: ${r.stderr || r.stdout}`,
    );
  }
}

/**
 * Patch the kubeclaw-bootstrap-skills ConfigMap with the http-echo skill.
 * The skill markdown is read directly from disk so the test stays in sync
 * with the canonical source-of-truth file.
 */
function seedSkillConfigMap(): void {
  const skillPath = join(
    process.cwd(),
    'helm',
    'kubeclaw',
    'files',
    'bootstrap-skills',
    'bootstrap-http-echo.md',
  );
  const markdown = readFileSync(skillPath, 'utf-8');
  const patch = JSON.stringify({
    data: { 'bootstrap-http-echo.md': markdown },
  });
  const r = kubectl([
    'patch',
    'configmap',
    'kubeclaw-bootstrap-skills',
    '-n',
    NAMESPACE,
    '--type=merge',
    '-p',
    patch,
  ]);
  if (!r.ok) {
    throw new Error(
      `Failed to seed bootstrap-skills ConfigMap: ${r.stderr || r.stdout}`,
    );
  }
}

describe('Minikube-live: bootstrap HTTP-echo channel end-to-end', () => {
  let provisioned = false;
  let adminPass = '';
  let authHeader = '';

  beforeAll(async () => {
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
      return;
    }

    // Seed the http-echo manifest + skill into the ConfigMaps.
    seedManifestConfigMap();
    seedSkillConfigMap();
  }, 60_000);

  afterAll(() => {
    // Resource cleanup. All operations are idempotent.
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
    // Remove ConfigMap entries (patch with null deletes the key).
    kubectl(
      [
        'patch',
        'configmap',
        'kubeclaw-channel-manifests',
        '-n',
        NAMESPACE,
        '--type=json',
        '-p',
        '[{"op":"remove","path":"/data/http-echo.json"}]',
      ],
      { allowFail: true },
    );
    kubectl(
      [
        'patch',
        'configmap',
        'kubeclaw-bootstrap-skills',
        '-n',
        NAMESPACE,
        '--type=json',
        '-p',
        '[{"op":"remove","path":"/data/bootstrap-http-echo.md"}]',
      ],
      { allowFail: true },
    );
  });

  // ── AC1: bootstrap Job created with correct env ────────────────────────────

  it('bootstrap_channel_from_skill creates a bootstrap Job with KUBECLAW_BOOTSTRAP_SKILL set (AC1)', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    const prompt =
      `Please bootstrap a new channel using the bootstrap-http-echo skill. ` +
      `The channel type is http-echo and the instance name is ${INSTANCE_NAME}.`;
    const reply = await chatAndWaitForReply(authHeader, prompt, 60_000);
    expect(reply.toLowerCase()).toContain('bootstrap');

    // Poll for the Job to appear.
    let jobYaml = '';
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'job',
        `kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '-n',
        NAMESPACE,
        '-o',
        'yaml',
      ]);
      if (r.ok) {
        jobYaml = r.stdout;
        break;
      }
      await sleep(2000);
    }
    expect(jobYaml, 'bootstrap Job not created within 60s').toContain(
      'KUBECLAW_BOOTSTRAP_SKILL',
    );
    expect(jobYaml).toContain('bootstrap-http-echo');
    expect(jobYaml).toContain(`KUBECLAW_BOOTSTRAP_INSTANCE`);
    expect(jobYaml).toContain(INSTANCE_NAME);
  }, 90_000);

  // ── AC2: bootstrap dialogue completes (admin answers the port question) ──

  it('bootstrap dialogue completes when admin answers the port question (AC2)', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // Wait for the bootstrap pod to reach a state where it has asked its
    // first question. The skill instructs it to ask about the port.
    let asked = false;
    for (let i = 0; i < 30; i++) {
      const logs = kubectl([
        'logs',
        '-n',
        NAMESPACE,
        `job/kubeclaw-bootstrap-${INSTANCE_NAME}`,
        '--tail=200',
      ]);
      if (logs.ok && /port/i.test(logs.stdout)) {
        asked = true;
        break;
      }
      await sleep(3000);
    }
    expect(asked, 'bootstrap pod did not ask the port question within 90s')
      .toBe(true);

    // Answer the port question via admin chat. The admin LLM forwards to the
    // bootstrap pod over Redis IPC.
    const reply = await chatAndWaitForReply(
      authHeader,
      `Use port ${CHANNEL_PORT}.`,
      60_000,
    );
    expect(reply).toBeTruthy();

    // Wait for the Job to complete.
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
  }, 270_000);

  // ── AC3+AC4: steady-state Deployment created from agent image ──────────────

  it('commit_channel_config produces a steady-state Deployment with the agent image (AC3+AC4)', async () => {
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
      if (r.ok) {
        deployYaml = r.stdout;
        break;
      }
      await sleep(2000);
    }
    expect(
      deployYaml,
      'steady-state Deployment not created within 60s — was commit_channel_config rejected?',
    ).toContain(`kubeclaw-channel-${INSTANCE_NAME}`);

    // AC4: the Deployment uses the generic agent image (NOT a per-channel
    // image), the runtime PVC is mounted read-only, and KUBECLAW_SUPERUSER
    // is not set on the container.
    expect(deployYaml).toContain('kubeclaw-agent:claude');
    expect(deployYaml).toContain('readOnly: true');
    expect(deployYaml).not.toContain('KUBECLAW_SUPERUSER');
    expect(deployYaml).not.toContain('KUBECLAW_BOOTSTRAP_SKILL');

    // Wait for the pod to be Ready.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = kubectl([
        'get',
        'pod',
        '-n',
        NAMESPACE,
        '-l',
        `kubeclaw-channel=${INSTANCE_NAME}`,
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

  // ── AC5: HTTP GET / against the channel pod returns 200 ───────────────────

  it('channel pod responds to HTTP GET / with 200 and a JSON body (AC5)', async () => {
    if (!provisioned) {
      console.warn('Skipping — admin not reachable');
      return;
    }

    // Port-forward to the channel pod so we can hit it from the test host.
    const podName = kubectl([
      'get',
      'pod',
      '-n',
      NAMESPACE,
      '-l',
      `kubeclaw-channel=${INSTANCE_NAME}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ]).stdout.trim();
    expect(podName).toBeTruthy();

    // Use background spawn for port-forward; tear down after the test.
    const { spawn } = await import('node:child_process');
    const pf = spawn(
      'kubectl',
      [
        'port-forward',
        '-n',
        NAMESPACE,
        `pod/${podName}`,
        `${LOCAL_FORWARD_PORT}:${CHANNEL_PORT}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      // Wait for port-forward to be ready.
      let reachable = false;
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${LOCAL_FORWARD_PORT}/`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.status === 200) {
            const body = await res.json();
            expect((body as { channel: string }).channel).toContain(
              INSTANCE_NAME,
            );
            reachable = true;
            break;
          }
        } catch {
          // retry
        }
        await sleep(1500);
      }
      expect(
        reachable,
        'channel pod did not serve HTTP 200 within 30s of port-forward',
      ).toBe(true);
    } finally {
      pf.kill('SIGTERM');
    }
  }, 90_000);
});
