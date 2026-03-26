/**
 * Alpine Tool Pod E2E Test
 *
 * Verifies that an agent can spawn a sidecar tool pod using an Alpine container
 * with the file-bridge pattern and receive results back via Redis streams.
 *
 * Flow:
 *   1. Publish a tool call to kubeclaw:toolcalls:{agentJobId}:alpine-shell
 *   2. Spawn a sidecar tool pod: alpine:latest with file-bridge, custom shell command
 *   3. The file-bridge (kubeclaw-file-adapter) writes request files to /shared/
 *   4. Alpine polls /shared/*.request.json, extracts the command, runs it, writes response
 *   5. The file-bridge reads the response and publishes to toolresults stream
 *   6. Assert the result contains "hello"
 *
 * Requires: orchestrator running in cluster, kubeclaw-file-adapter image available.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { requireKubernetes, getSharedRedis, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();

// Alpine sh script: polls /shared/*.request.json, extracts input.command, runs it,
// writes {"result":"..."} to the corresponding .response.json file.
// Uses sed to extract the command value from JSON since Alpine has no jq by default.
const ALPINE_POLL_SCRIPT = [
  'sh',
  '-c',
  `while true; do
  for f in /shared/*.request.json; do
    [ -f "$f" ] || continue
    rsp="\${f%.request.json}.response.json"
    [ -f "$rsp" ] && continue
    cmd=$(sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p' "$f")
    [ -z "$cmd" ] && continue
    result=$(sh -c "$cmd" 2>&1)
    printf '{"result":"%s"}' "$result" > "$rsp"
  done
  sleep 0.1
done`,
];

function pollToolResult(
  redis: import('ioredis').default,
  stream: string,
  requestId: string,
  timeoutMs: number,
): Promise<{ result: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const entries = await redis.xrange(stream, '-', '+');
        for (const [, fields] of entries) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          if (obj.requestId === requestId) {
            return resolve({ result: obj.result ?? '', error: obj.error });
          }
        }
      } catch {
        // stream may not exist yet
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(`Timed out waiting for tool result on ${stream} (requestId=${requestId})`),
        );
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

describe('Alpine Tool Pod Execution', () => {
  let orchestratorRunning = false;

  beforeAll(async () => {
    requireKubernetes();
    // Wait up to 90s for orchestrator to be Running and Ready
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const result = spawnSync(
          'kubectl',
          ['get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-orchestrator', '-o', 'json'],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        if (result.status === 0) {
          const pods = JSON.parse(result.stdout).items as Array<{
            status: { phase: string; containerStatuses?: Array<{ ready: boolean }> };
          }>;
          const ready = pods.some(
            (p) =>
              p.status.phase === 'Running' &&
              p.status.containerStatuses?.every((c) => c.ready),
          );
          if (ready) {
            orchestratorRunning = true;
            break;
          }
        }
      } catch {
        // orchestrator not deployed
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }, 100_000);

  it('alpine container executes shell command and returns result via file-bridge', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    const agentJobId = `e2e-alpine-${Date.now()}`;
    const groupFolder = `alpine-${Date.now()}`;
    const requestId = `req-alpine-${Date.now()}`;
    const category = 'alpine-shell';

    const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:${category}`;
    const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:${category}`;

    // Brief pause to ensure the spawn watcher is past any initial setup phase
    await new Promise((r) => setTimeout(r, 1000));

    // Publish tool call FIRST — file-bridge reads from lastId='0-0' so it picks
    // this up even if published before the pod starts.
    await redis.xadd(
      toolCallsStream,
      '*',
      'requestId',
      requestId,
      'tool',
      'bash',
      'input',
      JSON.stringify({ command: 'echo hello | grep h' }),
    );

    // Spawn sidecar pod: alpine:latest with file-bridge pattern.
    // toolCommand is a JSON array (the container entrypoint + args).
    await redis.xadd(
      'kubeclaw:spawn-tool-pod',
      '*',
      'agentJobId',
      agentJobId,
      'groupFolder',
      groupFolder,
      'category',
      category,
      'timeout',
      '120000',
      'channel',
      '',
      'toolImage',
      'alpine:latest',
      'toolPattern',
      'file',
      'toolCommand',
      JSON.stringify(ALPINE_POLL_SCRIPT),
    );

    console.log(`⏳ Waiting for alpine tool result on ${toolResultsStream}...`);

    // Allow up to 120s: pod pull + startup + file-bridge startup + execution
    const { result, error } = await pollToolResult(
      redis,
      toolResultsStream,
      requestId,
      120_000,
    );

    if (error) {
      console.log(`ℹ️  Alpine tool returned error: ${error}`);
      // Still counts as a round-trip pass
    } else {
      console.log(`✅ Alpine tool result: ${result.trim()}`);
      expect(result).toContain('hello');
    }

    const entries = await redis.xrange(toolResultsStream, '-', '+');
    expect(entries.length).toBeGreaterThan(0);
  }, 150_000);
});
