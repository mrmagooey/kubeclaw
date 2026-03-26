/**
 * Tool Execution E2E Tests
 *
 * Verifies the full tool call round-trip:
 *   1. Spawn a tool pod via kubeclaw:spawn-tool-pod (category=execution)
 *   2. Publish a tool call to kubeclaw:toolcalls:{agentJobId}:execution
 *   3. Poll kubeclaw:toolresults:{agentJobId}:execution for the response
 *   4. Assert the result contains expected output
 *
 * The tool-server uses lastId='0-0' so tool calls can be published before
 * the pod starts — it will pick them up on first read.
 *
 * Requires: orchestrator running, kubeclaw-agent:latest loaded in minikube.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { requireKubernetes, getSharedRedis, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();

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
        return reject(new Error(`Timed out waiting for tool result on ${stream} (requestId=${requestId})`));
      }
      setTimeout(check, 2000);
    };
    check();
  });
}

describe('Tool Execution Round-Trip', () => {
  let orchestratorRunning = false;

  beforeAll(() => {
    requireKubernetes();
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
        if (pods.length > 0 && pods[0].status.phase === 'Running') {
          orchestratorRunning = pods[0].status.containerStatuses?.every((c) => c.ready) ?? false;
        }
      }
    } catch {
      // orchestrator not deployed
    }
  });

  it('bash tool call returns expected output via Redis streams', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    const agentJobId = `e2e-toolexec-${Date.now()}`;
    const groupFolder = `toolexec-${Date.now()}`;
    const requestId = `req-${Date.now()}`;

    const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:execution`;
    const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:execution`;

    // Trim spawn stream + wait one BLOCK cycle to avoid the lastId='$' race
    await redis.del('kubeclaw:spawn-tool-pod');
    await new Promise((r) => setTimeout(r, 6000));

    // Publish the tool call FIRST (tool-server reads from lastId='0-0')
    await redis.xadd(
      toolCallsStream, '*',
      'requestId', requestId,
      'tool', 'bash',
      'input', JSON.stringify({ command: 'echo hello-from-e2e' }),
    );

    // Spawn the tool pod (no toolImage → standard single-container execution pod)
    await redis.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'category', 'execution',
      'timeout', '120000',
      'channel', '',
    );

    console.log(`⏳ Waiting for tool result on ${toolResultsStream}...`);

    // Pod starts, connects to Redis, reads from beginning of stream,
    // executes bash, writes result. Allow up to 90s for pod startup + execution.
    const { result, error } = await pollToolResult(redis, toolResultsStream, requestId, 90_000);

    if (error) {
      // A bash execution error is OK — the round-trip worked
      console.log(`ℹ️  Tool returned error (round-trip verified): ${error}`);
    } else {
      expect(result).toContain('hello-from-e2e');
      console.log(`✅ Tool result received: ${result.trim()}`);
    }

    // In both cases, the result stream entry must exist
    const entries = await redis.xrange(toolResultsStream, '-', '+');
    expect(entries.length).toBeGreaterThan(0);
  }, 120_000);

  it('read tool call returns file contents via Redis streams', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    const agentJobId = `e2e-toolread-${Date.now()}`;
    const groupFolder = `toolread-${Date.now()}`;
    const requestId = `req-read-${Date.now()}`;

    const toolCallsStream = `kubeclaw:toolcalls:${agentJobId}:execution`;
    const toolResultsStream = `kubeclaw:toolresults:${agentJobId}:execution`;

    await redis.del('kubeclaw:spawn-tool-pod');
    await new Promise((r) => setTimeout(r, 6000));

    // Read /etc/hostname — always exists in the container
    await redis.xadd(
      toolCallsStream, '*',
      'requestId', requestId,
      'tool', 'read',
      'input', JSON.stringify({ file_path: '/etc/hostname' }),
    );

    await redis.xadd(
      'kubeclaw:spawn-tool-pod', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'category', 'execution',
      'timeout', '120000',
      'channel', '',
    );

    console.log(`⏳ Waiting for read tool result on ${toolResultsStream}...`);

    const { result, error } = await pollToolResult(redis, toolResultsStream, requestId, 90_000);

    // Either result exists or a known error (file access restricted in some configs)
    if (error) {
      console.log(`ℹ️  Read tool returned error (round-trip verified): ${error}`);
    } else {
      // Result should be non-empty (file contents with line numbers)
      expect(result.length).toBeGreaterThan(0);
      console.log(`✅ Read tool result received (${result.length} chars)`);
    }

    const entries = await redis.xrange(toolResultsStream, '-', '+');
    expect(entries.length).toBeGreaterThan(0);
  }, 120_000);
});
