/**
 * Agent Job Spawn Watcher E2E Tests
 *
 * Verifies that the orchestrator's startAgentJobSpawnWatcher() correctly:
 *   - Reads from kubeclaw:spawn-agent-job stream
 *   - Runs the agent job via jobRunner.runAgentJob()
 *   - Writes result to kubeclaw:agent-job-result:{agentJobId} with
 *     `result` and `status` fields
 *
 * The agent job will fail quickly (bad API key) — that's intentional;
 * we only verify the result stream gets written.
 *
 * Requires: orchestrator running in cluster.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { requireKubernetes, getSharedRedis, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();
const RESULT_STREAM_TTL_MS = 120_000; // orchestrator keeps streams for 2 min

function pollStream(
  redis: import('ioredis').default,
  stream: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        // Read all entries from the beginning
        const results = await redis.xrange(stream, '-', '+');
        if (results.length > 0) {
          const [, fields] = results[0];
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          return resolve(obj);
        }
      } catch {
        // stream may not exist yet
      }
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for entries on ${stream}`));
      }
      setTimeout(check, 3000);
    };
    check();
  });
}

describe('Agent Job Spawn Watcher', () => {
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

  it('result is written to kubeclaw:agent-job-result:{agentJobId} after job completes', async (ctx) => {
    if (!orchestratorRunning) ctx.skip();
    const redis = getSharedRedis();
    if (!redis) ctx.skip();

    const agentJobId = `e2e-ajr-${Date.now()}`;
    const groupFolder = `ajr-test-${Date.now()}`;
    const resultStream = `kubeclaw:agent-job-result:${agentJobId}`;

    // Wait one BLOCK cycle so the watcher's lastId='$' is past our publish
    await new Promise((r) => setTimeout(r, 6000));

    await redis.xadd(
      'kubeclaw:spawn-agent-job', '*',
      'agentJobId', agentJobId,
      'groupFolder', groupFolder,
      'chatJid', 'e2e-test@e2e',
      'prompt', 'Reply with the single word: DONE',
      'channel', '',
    );

    console.log(`⏳ Waiting for result on ${resultStream}...`);

    // The agent job runs in K8s and will fail (bad API key), but the
    // orchestrator must still write the result/error to the result stream.
    // activeDeadlineSeconds for the job is ~70s (IDLE_TIMEOUT+30s when
    // CONTAINER_TIMEOUT is overridden to 30s in the helm install).
    // We allow up to 120s for the whole cycle.
    const fields = await pollStream(redis, resultStream, RESULT_STREAM_TTL_MS);

    expect(fields).toHaveProperty('result');
    expect(fields).toHaveProperty('status');

    // status should be one of the known terminal values
    expect(['completed', 'error', 'timeout', 'failed']).toContain(fields.status);

    console.log(`✅ Agent job result received: status=${fields.status}`);
  }, 150_000);
});
