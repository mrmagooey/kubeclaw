/**
 * NanoClaw Sidecar Adapter
 *
 * Runs alongside an arbitrary user container in a Kubernetes Pod. Uses
 * file-based IPC (shared emptyDir) to pass tasks in and receive results out,
 * then delivers output to the orchestrator via Redis pub/sub.
 *
 * Input protocol:
 *   - Stdin: initial TaskInput JSON from orchestrator
 *   - Follow-ups: Redis Streams (nanoclaw:input:{jobId})
 *
 * Output protocol:
 *   - Redis Pub/Sub on nanoclaw:messages:{groupFolder} (AgentOutputMessage envelope)
 *
 * File protocol:
 *   - Input:  /workspace/input/task.json (initial), task_1.json, task_2.json (follow-ups)
 *   - Output: /workspace/output/result.json
 */

import { FileIPC } from './file-ipc.js';
import { TaskInput, TaskOutput, SidecarConfig } from './types.js';
import { RedisIPCClient } from './redis-ipc.js';

// Configuration from environment
const config: SidecarConfig = {
  inputDir: process.env.NANOCLAW_INPUT_DIR || '/workspace/input',
  outputDir: process.env.NANOCLAW_OUTPUT_DIR || '/workspace/output',
  pollIntervalMs: parseInt(process.env.NANOCLAW_POLL_INTERVAL || '1000', 10),
  timeoutMs: parseInt(process.env.NANOCLAW_TIMEOUT || '1800000', 10),
};

const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
const REDIS_URL = process.env.REDIS_URL;
const REDIS_USERNAME = process.env.REDIS_USERNAME;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const JOB_ID = process.env.NANOCLAW_JOB_ID || '';
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';

function log(message: string): void {
  console.error(`[sidecar-adapter] ${message}`);
}

/**
 * Read all data from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Main loop: handle initial task via file IPC, then follow-ups via Redis Streams
 */
async function main(): Promise<void> {
  log('Sidecar adapter starting...');
  log(`Input dir: ${config.inputDir}`);
  log(`Output dir: ${config.outputDir}`);
  log(`Poll interval: ${config.pollIntervalMs}ms`);
  log(`Timeout: ${config.timeoutMs}ms`);

  // Validate Redis config
  if (!REDIS_URL || !REDIS_USERNAME || !REDIS_PASSWORD || !JOB_ID || !GROUP_FOLDER) {
    log('Missing required env vars: REDIS_URL, REDIS_USERNAME, REDIS_PASSWORD, NANOCLAW_JOB_ID, NANOCLAW_GROUP_FOLDER');
    process.exit(1);
  }

  const redisClient = new RedisIPCClient({
    url: REDIS_URL,
    username: REDIS_USERNAME,
    password: REDIS_PASSWORD,
    jobId: JOB_ID,
    groupFolder: GROUP_FOLDER,
  });

  try {
    await redisClient.connect();
  } catch (err) {
    log(`Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const fileIPC = new FileIPC(config.inputDir, config.outputDir, config.pollIntervalMs);

  try {
    // Read initial task from stdin
    const stdinData = await readStdin();
    const initialTask = await fileIPC.readInitialTask(stdinData);
    log(`Received initial task for group: ${initialTask.groupFolder}`);

    // Write initial task file for user container
    fileIPC.writeTaskFile(initialTask, 0);

    let sessionId = initialTask.sessionId;
    let lastActivity = Date.now();

    // Process initial task
    log('Waiting for output from user container...');
    const output = await fileIPC.waitForOutput(config.timeoutMs);
    if (output.newSessionId) sessionId = output.newSessionId;

    await redisClient.sendOutput({ ...output, newSessionId: sessionId });

    // Check if the initial task completed the session
    if (output.status === 'success' && output.result === null) {
      log('Completion marker received, exiting');
      await redisClient.sendCompleted();
      return;
    }

    lastActivity = Date.now();

    // Listen for follow-ups via Redis Streams
    log('Listening for follow-up messages...');
    let taskSequence = 1;

    for await (const message of redisClient.listenForMessages()) {
      if (Date.now() - lastActivity > IDLE_TIMEOUT) {
        log('Idle timeout reached, exiting');
        break;
      }

      if (message.type === 'close') {
        log('Received close signal, exiting');
        break;
      }

      if (message.type === 'followup' && message.prompt) {
        log(`Processing follow-up #${taskSequence}: ${message.prompt.substring(0, 50)}...`);

        if (message.sessionId) sessionId = message.sessionId;

        const followupTask: TaskInput = {
          ...initialTask,
          prompt: message.prompt,
          sessionId,
        };

        fileIPC.writeTaskFile(followupTask, taskSequence++);

        log('Waiting for follow-up output...');
        const followupOutput = await fileIPC.waitForOutput(config.timeoutMs);
        if (followupOutput.newSessionId) sessionId = followupOutput.newSessionId;

        await redisClient.sendOutput({ ...followupOutput, newSessionId: sessionId });
        lastActivity = Date.now();

        if (followupOutput.status === 'success' && followupOutput.result === null) {
          log('Completion marker received, exiting');
          await redisClient.sendCompleted();
          break;
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Fatal error: ${errorMessage}`);
    try {
      await redisClient.sendOutput({
        status: 'error',
        result: null,
        error: errorMessage,
      });
    } catch (_) {}
    process.exit(1);
  } finally {
    fileIPC.cleanupAllTasks();
    try {
      await redisClient.sendCompleted();
    } catch (_) {
      // Best-effort: ignore if already sent or connection lost
    }
    await redisClient.disconnect();
  }

  log('Sidecar adapter exiting');
}

process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting');
  process.exit(0);
});

main();
