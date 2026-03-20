/**
 * NanoClaw File Adapter - Main Entry Point
 *
 * This sidecar adapter enables NanoClaw to run arbitrary containers without
 * HTTP interfaces. It uses file-based IPC via shared volumes and Redis for
 * bidirectional communication with the orchestrator (follow-up support).
 *
 * Flow:
 * 1. Read Redis connection details from env vars
 * 2. Connect to Redis with ACL credentials
 * 3. Read initial task from stdin (backward compat)
 * 4. Write to /workspace/input/task.json
 * 5. Poll for /workspace/output/result.json
 * 6. Send result via Redis (not stdout markers)
 * 7. Listen for follow-up messages via Redis Streams
 * 8. For each follow-up: process via file IPC -> send result via Redis
 * 9. On _close sentinel: disconnect and exit
 */

import {
  ContainerInput,
  ContainerOutput,
  readStdin,
  parseContainerInput,
  toTaskFile,
  toContainerOutput,
  writeMarkedOutput,
} from './protocol.js';
import { FileIPC } from './file-ipc.js';
import { RedisIPCClient, RedisMessage } from './redis-ipc.js';

// Configuration from environment variables
const INPUT_DIR = process.env.KUBECLAW_INPUT_DIR || '/workspace/input';
const OUTPUT_DIR = process.env.KUBECLAW_OUTPUT_DIR || '/workspace/output';
const POLL_INTERVAL = parseInt(
  process.env.KUBECLAW_POLL_INTERVAL || '1000',
  10,
);
const TIMEOUT = parseInt(process.env.KUBECLAW_TIMEOUT || '300000', 10); // 5 minutes default
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30 minutes

// Redis configuration from environment
const REDIS_URL = process.env.REDIS_URL;
const REDIS_USERNAME = process.env.REDIS_USERNAME;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const KUBECLAW_JOB_ID = process.env.KUBECLAW_JOB_ID;

/**
 * Log to stderr (stdout is reserved for protocol output)
 * Exported for testing
 */
export function log(message: string): void {
  console.error(`[file-adapter] ${message}`);
}

/**
 * Validate required environment variables
 * Exported for testing
 */
export function validateEnv(): string[] {
  const missing: string[] = [];

  if (!process.env.REDIS_URL) missing.push('REDIS_URL');
  if (!process.env.REDIS_USERNAME) missing.push('REDIS_USERNAME');
  if (!process.env.REDIS_PASSWORD) missing.push('REDIS_PASSWORD');
  if (!process.env.KUBECLAW_JOB_ID) missing.push('KUBECLAW_JOB_ID');

  return missing;
}

/**
 * Send output via Redis (primary) and stdout (fallback)
 * Exported for testing
 */
export async function sendOutput(
  redisClient: RedisIPCClient,
  output: ContainerOutput,
): Promise<void> {
  // Always try Redis first
  try {
    await redisClient.sendOutput(output);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to send output via Redis: ${errorMsg}`);
    // Fallback to stdout markers for backward compatibility
    writeMarkedOutput(output);
  }
}

/**
 * Process a single task via file IPC
 * Exported for testing
 */
export async function processTask(
  fileIPC: FileIPC,
  containerInput: ContainerInput,
  sessionId: string | undefined,
): Promise<{ output: ContainerOutput; sessionId: string | undefined }> {
  // Write task file
  const taskFile = toTaskFile(containerInput);
  const taskPath = fileIPC.writeTask(taskFile);
  log(`Wrote task file: ${taskPath}`);

  // Wait for result with timeout
  log('Waiting for result...');
  const result = await fileIPC.waitForResult();

  if (result === null) {
    log('Timeout waiting for result file');
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: 'Timeout waiting for user container output',
    };
    return { output, sessionId };
  }

  log(`Received result: status=${result.status}`);

  // Update session ID if provided
  if (result.newSessionId) {
    sessionId = result.newSessionId;
  }

  // Convert and return result
  const output = toContainerOutput(result);

  // Clean up files
  fileIPC.cleanupFiles();

  return { output, sessionId };
}

/**
 * Main processing loop
 */
async function main(): Promise<void> {
  log('Starting file adapter...');

  // Validate environment variables
  const missingEnv = validateEnv();
  if (missingEnv.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingEnv.join(', ')}`;
    log(`Environment validation failed: ${errorMsg}`);
    // Write error to stdout for backward compatibility
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: errorMsg,
    };
    writeMarkedOutput(output);
    process.exit(1);
  }
  log('Environment validation passed');

  log(`Input dir: ${INPUT_DIR}`);
  log(`Output dir: ${OUTPUT_DIR}`);
  log(`Poll interval: ${POLL_INTERVAL}ms`);
  log(`Timeout: ${TIMEOUT}ms`);
  log(`Redis URL: ${REDIS_URL}`);
  log(`Job ID: ${KUBECLAW_JOB_ID}`);

  // Initialize Redis client
  const redisClient = new RedisIPCClient({
    url: REDIS_URL!,
    username: REDIS_USERNAME!,
    password: REDIS_PASSWORD!,
    jobId: KUBECLAW_JOB_ID!,
    groupFolder: process.env.KUBECLAW_GROUP_FOLDER!,
  });

  // Connect to Redis
  try {
    await redisClient.connect();
    log('Connected to Redis');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to connect to Redis: ${errorMsg}`);
    // Fallback: write error to stdout and exit
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: `Redis connection failed: ${errorMsg}`,
    };
    writeMarkedOutput(output);
    process.exit(1);
  }

  // Initialize file IPC
  const fileIPC = new FileIPC({
    inputDir: INPUT_DIR,
    outputDir: OUTPUT_DIR,
    pollInterval: POLL_INTERVAL,
    timeout: TIMEOUT,
  });

  // Read initial input from stdin (backward compatibility)
  let containerInput: ContainerInput;
  try {
    const stdinData = await readStdin();
    containerInput = parseContainerInput(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
    log(`Prompt: ${containerInput.prompt.substring(0, 100)}...`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to parse input: ${errorMsg}`);
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: `Failed to parse input: ${errorMsg}`,
    };
    await sendOutput(redisClient, output);
    await redisClient.disconnect();
    process.exit(1);
  }

  // Track session state
  let sessionId = containerInput.sessionId;
  let lastActivity = Date.now();

  try {
    // Process initial task
    const { output, sessionId: newSessionId } = await processTask(
      fileIPC,
      containerInput,
      sessionId,
    );
    sessionId = newSessionId;
    lastActivity = Date.now();

    // Send initial result via Redis
    if (sessionId) {
      output.newSessionId = sessionId;
    }
    await sendOutput(redisClient, output);

    // Check if this was the final message (null result with success indicates end)
    if (output.status === 'success' && output.result === null) {
      log('Received completion marker, exiting');
      await redisClient.sendCompleted();
      await redisClient.disconnect();
      return;
    }

    // Listen for follow-up messages via Redis Streams
    log('Listening for follow-up messages...');

    for await (const message of redisClient.listenForMessages()) {
      // Check idle timeout
      if (Date.now() - lastActivity > IDLE_TIMEOUT) {
        log('Idle timeout reached, exiting');
        break;
      }

      if (message.type === 'close') {
        log('Received close signal, exiting');
        break;
      }

      if (message.type === 'followup' && message.prompt) {
        log(`Processing follow-up: ${message.prompt.substring(0, 50)}...`);

        // Update session ID if provided
        if (message.sessionId) {
          sessionId = message.sessionId;
        }

        // Create new container input for follow-up
        const followupInput: ContainerInput = {
          ...containerInput,
          prompt: message.prompt,
          sessionId,
        };

        // Process follow-up task
        const { output: followupOutput, sessionId: updatedSessionId } =
          await processTask(fileIPC, followupInput, sessionId);
        sessionId = updatedSessionId;
        lastActivity = Date.now();

        // Send follow-up result via Redis
        if (sessionId) {
          followupOutput.newSessionId = sessionId;
        }
        await sendOutput(redisClient, followupOutput);

        // Check if this was the final message
        if (
          followupOutput.status === 'success' &&
          followupOutput.result === null
        ) {
          log('Received completion marker, exiting');
          await redisClient.sendCompleted();
          break;
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Error in main loop: ${errorMsg}`);
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMsg,
    };
    await sendOutput(redisClient, output);
    process.exit(1);
  } finally {
    // Final cleanup — always signal completion so the orchestrator resolves
    fileIPC.cleanupFiles();
    try {
      await redisClient.sendCompleted();
    } catch (_) {
      // Best-effort: ignore if already sent or connection lost
    }
    await redisClient.disconnect();
  }

  log('File adapter exiting');
}

// Run main
main().catch((err) => {
  console.error(`[file-adapter] Fatal error: ${err}`);
  process.exit(1);
});
