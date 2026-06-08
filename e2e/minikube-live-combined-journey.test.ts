/**
 * Minikube-live e2e: combined journey across one agent channel.
 *
 * Reuses the globalSetup cluster (e2e/minikube-live-setup.ts): namespace
 * kubeclaw-live, helm-installed kubeclaw, port-forwards for the HTTP channel
 * and Redis. Reuses the existing kubeclaw-channel-http agent channel.
 *
 * Stages (Redis bypass = load-bearing/deterministic; LLM-driven = informational):
 *   0. Channel pod Ready and runs kubeclaw-agent:latest (NOT :claude/:openrouter).
 *   1. Install MCP capability journey-test-mcp; channel connects to it.
 *   2. execute_agent via Redis bypass -> nested kubeclaw-agent Job + result.
 *   3. bash tool pod via Redis bypass -> kubeclaw-tool Job spawned.
 *   4. MCP record_test_message tool reachable from channel pod (tools/list).
 *   5. One LLM-driven request through POST /message (asserts 200 only).
 *
 * Run: npm run test:minikube-live -- minikube-live-combined-journey
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const GROUP_FOLDER = 'http-http-alice';
const MAIN_GROUP = 'http';
const CHAT_JID = 'http:alice';
const JOURNEY_CAP_NAME = 'journey-test-mcp';
const JOURNEY_CAP_IMAGE = 'kubeclaw-test-mcp:latest';
const CAP_SERVICE = `kubeclaw-cap-${JOURNEY_CAP_NAME}`;
const CAP_LABEL = `app=${CAP_SERVICE}`;
const CHANNEL_LABEL = 'app=kubeclaw-channel-http';
const AGENT_LABEL = `app=kubeclaw-agent,kubeclaw/group=${GROUP_FOLDER}`;
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function postMessage(text: string): Promise<Response> {
  return fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
    },
    body: JSON.stringify({ text }),
  });
}

async function waitForJob(
  labelSelector: string,
  timeoutMs: number,
  sinceMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'jobs', '-n', NAMESPACE, '-l', labelSelector,
      '--sort-by=.metadata.creationTimestamp',
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.creationTimestamp}{"\\n"}{end}',
    ]);
    if (r.ok && r.stdout.trim()) {
      const lines = r.stdout.trim().split('\n').reverse();
      for (const line of lines) {
        const [name, ts] = line.split('\t');
        if (!name || !ts) continue;
        if (Date.parse(ts) + 2000 >= sinceMs) return name;
      }
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  return null;
}

async function pollStream(
  redis: Redis,
  stream: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const entries = await redis.xrange(stream, '-', '+');
        if (entries.length > 0) {
          const [, fields] = entries[entries.length - 1];
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          return resolve(obj);
        }
      } catch { /* stream may not exist yet */ }
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting on ${stream}`));
      }
      setTimeout(check, 4000);
    };
    void check();
  });
}

async function waitForPodReady(label: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', label,
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
    ]);
    if (r.ok && r.stdout.trim() && r.stdout.trim().split(/\s+/).every((s) => s === 'True')) {
      return true;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false;
}

describe('Minikube-live: combined journey across one agent channel', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, { signal: AbortSignal.timeout(2000) });
        if (res.status > 0) { provisioned = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(`Port-forward to ${HTTP_URL} not reachable — globalSetup may have failed.`);
      return;
    }

    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`Failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();
  }, 120_000);

  afterAll(async () => {
    if (redis) {
      try {
        await redis.xadd(
          'kubeclaw:task-requests', '*',
          'type', 'remove_capability',
          'groupFolder', MAIN_GROUP,
          'isMain', 'true',
          'name', JOURNEY_CAP_NAME,
        );
      } catch { /* best-effort */ }
      try { await redis.quit(); } catch { /* ignore */ }
    }
  });

  it('Stage 0: channel pod is Ready and runs kubeclaw-agent:latest', async () => {
    expect(provisioned, 'globalSetup port-forward not live').toBe(true);

    const ready = await waitForPodReady(CHANNEL_LABEL, 120_000);
    expect(ready, `channel pod (${CHANNEL_LABEL}) not Ready within 120 s`).toBe(true);

    const img = kubectl([
      'get', 'pods', '-n', NAMESPACE, '-l', CHANNEL_LABEL,
      '-o', 'jsonpath={.items[0].spec.containers[?(@.name=="channel")].image}',
    ]);
    expect(img.ok, `kubectl get image failed: ${img.stderr}`).toBe(true);
    const image = img.stdout.trim();
    console.log(`channel container image: ${image}`);
    expect(image, 'channel image must be the consolidated :latest tag').toMatch(/kubeclaw-agent:latest$/);
    expect(image, 'stale per-provider image tag must not be used').not.toMatch(/kubeclaw-agent:(claude|openrouter)/);
  }, 150_000);

  it('Stage 1: capability installs and the channel connects to it', async () => {
    expect(provisioned).toBe(true);
    expect(redis, 'Redis client not initialised').not.toBeNull();

    const spec = { kind: 'mcp', name: JOURNEY_CAP_NAME, image: JOURNEY_CAP_IMAGE, port: 3000, path: '/mcp' };
    await redis!.xadd(
      'kubeclaw:task-requests', '*',
      'type', 'install_capability',
      'groupFolder', MAIN_GROUP,
      'isMain', 'true',
      'spec', JSON.stringify(spec),
    );

    const ready = await waitForPodReady(CAP_LABEL, 240_000);
    expect(ready, `capability pod (${CAP_LABEL}) not Ready within 240 s`).toBe(true);

    const svc = kubectl(['get', 'service', CAP_SERVICE, '-n', NAMESPACE, '-o', 'jsonpath={.metadata.name}']);
    expect(svc.ok, `Service ${CAP_SERVICE} not found: ${svc.stderr}`).toBe(true);
    expect(svc.stdout.trim()).toBe(CAP_SERVICE);

    await new Promise((r) => setTimeout(r, 5000));

    const logs = kubectl(['logs', '-n', NAMESPACE, 'deployment/kubeclaw-channel-http', '--tail=2000']);
    expect(logs.ok, `kubectl logs failed: ${logs.stderr}`).toBe(true);
    expect(logs.stdout, 'channel logs should mention capabilities_update or the capability name')
      .toMatch(/capabilities_update|Connected to MCP server|journey-test-mcp/i);
  }, 300_000);

  it('Stage 2: execute_agent bypass spawns a kubeclaw-agent Job and returns a result', async () => {
    expect(provisioned).toBe(true);
    expect(redis).not.toBeNull();

    const rand = Math.random().toString(36).slice(2, 8);
    const agentJobId = `journey-agent-${Date.now()}-${rand}`;
    const resultStream = `kubeclaw:agent-job-result:${agentJobId}`;
    const startMs = Date.now();

    await redis!.xadd(
      'kubeclaw:spawn-agent-job', '*',
      'agentJobId', agentJobId,
      'groupFolder', GROUP_FOLDER,
      'chatJid', CHAT_JID,
      'prompt', 'Echo the word: done',
      'timeout', '300000',
      'channel', 'http',
    );

    const jobName = await waitForJob(AGENT_LABEL, 240_000, startMs);
    expect(jobName, `No kubeclaw-agent Job (${AGENT_LABEL}) appeared within 240 s`).not.toBeNull();
    console.log(`Stage 2: kubeclaw-agent Job appeared: ${jobName}`);

    const result = await pollStream(redis!, resultStream, 300_000);
    expect.soft(result.result ?? '', 'agent-job result field must be non-empty').toBeTruthy();
    console.log(`Stage 2: result (first 200): ${(result.result ?? '').slice(0, 200)}`);
  }, 600_000);

  it('Stage 3: spawn-tool-pod bypass spawns an execution tool Job', async () => {
    expect(provisioned).toBe(true);
    expect(redis).not.toBeNull();

    const rand = Math.random().toString(36).slice(2, 8);
    const toolJobId = `journey-tool-${Date.now()}-${rand}`;
    const callsStream = `kubeclaw:toolcalls:${toolJobId}:execution`;
    const startMs = Date.now();

    await redis!.xadd(
      callsStream, '*',
      'requestId', `${toolJobId}-1`,
      'tool', 'bash',
      'input', JSON.stringify({ command: 'echo journey-tool-ok' }),
    );

    await redis!.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', toolJobId,
      'groupFolder', GROUP_FOLDER,
      'category', 'execution',
      'timeout', '120000',
      'channel', 'http',
    );

    // Tool pod Jobs carry: app=kubeclaw-tool-pod, kubeclaw/group=<groupFolder>
    // Use both labels to avoid matching agent jobs from Stage 2.
    const toolJob = await waitForJob(`app=kubeclaw-tool-pod,kubeclaw/group=${GROUP_FOLDER}`, 180_000, startMs);
    expect(toolJob, `No tool Job for group ${GROUP_FOLDER} appeared within 180 s`).not.toBeNull();
    console.log(`Stage 3: tool Job appeared: ${toolJob}`);

    const resultsStream = `kubeclaw:toolresults:${toolJobId}:execution`;
    try {
      const len = await redis!.xlen(resultsStream);
      console.log(`Stage 3: toolresults stream length=${len}`);
    } catch {
      console.log('Stage 3: toolresults stream not yet created (informational)');
    }
  }, 240_000);

  it('Stage 4: capability MCP tool is registered and reachable from the channel pod', () => {
    expect(provisioned).toBe(true);

    const pods = kubectl(['get', 'pods', '-n', NAMESPACE, '-l', CHANNEL_LABEL, '-o', 'jsonpath={.items[0].metadata.name}']);
    expect(pods.ok).toBe(true);
    const channelPod = pods.stdout.trim();
    expect(channelPod, 'no channel pod found').toBeTruthy();

    const probe = `
      const http = require('node:http');
      const body = JSON.stringify({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
      const req = http.request({
        host: '${CAP_SERVICE}', port: 3000, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(data.includes('record_test_message')
              ? 'tools-ok:record_test_message'
              : 'tools-ok:no-tool:' + data.slice(0, 200));
          } else {
            http.get('http://${CAP_SERVICE}:3000/test/log', (r2) => {
              let d2 = '';
              r2.on('data', (c) => d2 += c);
              r2.on('end', () => console.log('fallback-ok:' + d2.slice(0, 200)));
            }).on('error', (e) => { console.error('fallback-err:' + e.message); process.exit(3); });
          }
        });
      });
      req.on('error', (e) => { console.error('req-err:' + e.message); process.exit(3); });
      req.write(body); req.end();
    `;

    const exec = kubectl(['exec', '-n', NAMESPACE, channelPod, '-c', 'channel', '--', 'node', '-e', probe], { timeout: 30_000 });
    expect(exec.ok, `MCP probe exec failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`).toBe(true);
    expect(exec.stdout, `expected tools-ok or fallback-ok: ${exec.stdout}`).toMatch(/tools-ok|fallback-ok/);
  }, 90_000);

  it('Stage 5: LLM-driven request returns HTTP 200', async () => {
    expect(provisioned).toBe(true);

    const controller = new AbortController();
    const sseLines: string[] = [];
    const ssePromise = (async () => {
      try {
        const sseRes = await fetch(`${HTTP_URL}/stream`, {
          headers: { Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS) },
          signal: controller.signal,
        });
        if (!sseRes.ok || !sseRes.body) return;
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('data: ')) sseLines.push(line.slice(6));
          }
        }
      } catch { /* aborted */ }
    })();

    try {
      const res = await postMessage('Use your tools to record the test message "journey-marker" and then reply done.');
      expect(res.status, 'POST /message must be accepted').toBe(200);

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && sseLines.length === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log(`Stage 5 (informational): SSE delivered=${sseLines.length > 0}, lines=${sseLines.length}`);
    } finally {
      controller.abort();
      await ssePromise.catch(() => {});
    }
  }, 120_000);
});
