/**
 * Minikube-live IRC end-to-end tests.
 *
 * Depends on the global setup in e2e/minikube-live-setup.ts which helm-installs
 * kubeclaw into namespace `kubeclaw-live` with:
 *   - capabilities.test-ircd  → kubeclaw-test-ircd:latest (IRC + HTTP side-channel)
 *   - channels.irc            → kubeclaw-bot connects to kubeclaw-capability-test-ircd:6667
 *
 * Tests interact with the IRC fixture via kubectl exec into the ircd pod,
 * hitting its HTTP side-channel on localhost:8080 (not exposed as a Service).
 *
 * Test 1: channel pod connected and joined #live-test
 * Test 2: inbound IRC message reaches the channel pod (via log polling)
 * Test 3: outbound IRC message path — skipped (requires multi-channel routing)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = 'kubeclaw-live';

// How long to wait for the ircd + IRC channel pod to be reachable after setup.
const PROVISIONED_TIMEOUT_MS = 20_000;

// Maximum time to poll channel-pod logs for an expected marker.
const LOG_POLL_TIMEOUT_MS = 60_000;

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
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Resolve the first running pod name for a label selector. */
function getPodName(labelSelector: string): string | null {
  const r = kubectl([
    'get', 'pods', '-n', NAMESPACE,
    '-l', labelSelector,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  const name = r.ok ? r.stdout.trim() : '';
  return name || null;
}

/**
 * Run a Node.js one-liner inside a pod via kubectl exec.
 * Uses the container named 'channel' if present (channel pods), otherwise
 * the container named 'capability' (capability pods).
 */
function nodeExec(
  podName: string,
  containerName: string,
  script: string,
  timeoutMs = 15_000,
): { ok: boolean; stdout: string; stderr: string } {
  return kubectl(
    ['exec', '-n', NAMESPACE, podName, '-c', containerName, '--', 'node', '-e', script],
    { timeout: timeoutMs },
  );
}

/**
 * Execute a curl command inside a pod via kubectl exec (the ircd container
 * is a node:20-slim image that has curl available).
 * Falls back to a Node.js http.get if curl is not present.
 */
function httpGetInPod(
  podName: string,
  containerName: string,
  url: string,
  timeoutMs = 10_000,
): { ok: boolean; body: string } {
  // Use Node's built-in http module — no curl dependency needed.
  const script = `
    const http = require('node:http');
    http.get(${JSON.stringify(url)}, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { process.stdout.write(data); process.exit(0); });
    }).on('error', (e) => { process.stderr.write(e.message); process.exit(1); });
  `;
  const r = nodeExec(podName, containerName, script, timeoutMs);
  return { ok: r.ok, body: r.stdout };
}

function httpPostInPod(
  podName: string,
  containerName: string,
  url: string,
  body: object,
  timeoutMs = 10_000,
): { ok: boolean; body: string } {
  const jsonBody = JSON.stringify(body);
  const script = `
    const http = require('node:http');
    const parsed = new URL(${JSON.stringify(url)});
    const payload = ${JSON.stringify(jsonBody)};
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
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
  const r = nodeExec(podName, containerName, script, timeoutMs);
  return { ok: r.ok, body: r.stdout };
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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('Minikube-live IRC: channel pod connects to test ircd and processes messages', () => {
  let provisioned = false;
  let ircdPodName: string | null = null;
  let ircChannelPodName: string | null = null;

  beforeAll(async () => {
    // Wait for both pods to exist and be reachable. The global setup already
    // waited for them to be Ready, so this should resolve immediately in a
    // healthy run — but a brief retry guards against timing edge cases.
    const deadline = Date.now() + PROVISIONED_TIMEOUT_MS;
    while (Date.now() < deadline) {
      ircdPodName = getPodName('app=kubeclaw-capability-test-ircd');
      ircChannelPodName = getPodName('app=kubeclaw-channel-irc');
      if (ircdPodName && ircChannelPodName) {
        provisioned = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!provisioned) {
      console.warn(
        `⚠️  IRC pods not found after ${PROVISIONED_TIMEOUT_MS}ms — ` +
        `ircdPod=${ircdPodName} ircChannelPod=${ircChannelPodName}`,
      );
    }
  });

  // ── 1. Channel pod connected to ircd and joined #live-test ────────────
  it('channel pod connected to ircd and joined the channel', async () => {
    expect(provisioned, 'IRC pods not found — globalSetup may have failed').toBe(true);

    // Poll the ircd's HTTP log endpoint (via kubectl exec) until it shows
    // a JOIN event from kubeclaw-bot.
    let logBody = '';
    const found = await pollUntil(
      () => {
        const r = httpGetInPod(
          ircdPodName!,
          'capability',
          'http://localhost:8080/irc/log',
          8_000,
        );
        if (!r.ok) return false;
        logBody = r.body;
        try {
          const parsed = JSON.parse(logBody) as { events: Array<{ type: string; from: string; channel: string }> };
          return parsed.events.some(
            (e) =>
              e.type === 'join' &&
              e.from.toLowerCase() === 'kubeclaw-bot' &&
              e.channel === '#live-test',
          );
        } catch {
          return false;
        }
      },
      3_000,
      60_000,
    );

    expect(
      found,
      `Expected JOIN event from kubeclaw-bot on #live-test in ircd log. Last log body: ${logBody}`,
    ).toBe(true);
  });

  // ── 2. Inbound IRC message reaches the channel pod ────────────────────
  it('inbound IRC message is stored by the channel pod', async () => {
    expect(provisioned, 'IRC pods not found — globalSetup may have failed').toBe(true);

    const marker = `hello-from-irc-test-${Date.now()}`;

    // Inject a PRIVMSG into #live-test via the ircd's HTTP side-channel.
    const inject = httpPostInPod(
      ircdPodName!,
      'capability',
      'http://localhost:8080/irc/inject',
      { channel: '#live-test', from: 'someuser', text: marker },
      10_000,
    );
    expect(
      inject.ok,
      `POST /irc/inject failed: ${inject.body}`,
    ).toBe(true);

    // Poll the IRC channel pod's logs for the "IRC message stored" log line
    // emitted by irc.ts handleMessage() on every inbound message.
    let channelLogs = '';
    const appeared = await pollUntil(
      () => {
        const r = kubectl([
          'logs', '-n', NAMESPACE,
          ircChannelPodName!,
          '-c', 'channel',
          '--tail=200',
        ], { timeout: 8_000 });
        channelLogs = r.ok ? r.stdout : '';
        // irc.ts line 210: logger.info({ jid, nick, target }, 'IRC message stored')
        // The structured log will contain both "IRC message stored" and the marker text.
        // The marker appears in the raw stdout since irc.ts also emits raw console.log
        // lines; the structured pino log contains the marker in the "content" field
        // indirectly (via opts.onMessage). We check for the log line *and* for the
        // marker being somewhere in the channel pod's logs after the inject.
        return (
          channelLogs.includes('IRC message stored') &&
          channelLogs.includes(marker)
        );
      },
      3_000,
      LOG_POLL_TIMEOUT_MS,
    );

    expect(
      appeared,
      `Expected 'IRC message stored' and marker '${marker}' in channel pod logs within ${LOG_POLL_TIMEOUT_MS}ms.\n` +
      `Last tail:\n${channelLogs.slice(-2000)}`,
    ).toBe(true);
  });

  // ── 3. Outbound IRC message via channel pod ───────────────────────────
  // Triggering an outbound IRC reply requires the full message → LLM →
  // router → IRC channel flow, which is multi-channel routing and out of
  // scope for this focused connectivity test.
  it.todo('outbound IRC message is sent by the channel pod when the LLM produces a reply');
});
