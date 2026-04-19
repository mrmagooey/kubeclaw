/**
 * NanoClaw HTTP Adapter - Main Entry Point
 *
 * This sidecar adapter enables NanoClaw to communicate with tool containers
 * that expose HTTP REST APIs. Uses Redis for bidirectional communication
 * with the orchestrator (follow-up support).
 *
 * Flow:
 * 1. Read Redis connection details from env vars
 * 2. Connect to Redis with ACL credentials
 * 3. Read initial task from stdin (backward compat)
 * 4. Poll GET /agent/health until the agent is ready
 * 5. POST /agent/task with the task payload
 * 6. Send response via Redis (not stdout)
 * 7. Listen for follow-ups via Redis Streams
 * 8. Send follow-ups as additional HTTP POSTs
 * 9. Send responses via Redis
 * 10. Handle close signal
 */

import {
  ContainerInput,
  ContainerOutput,
  readStdin,
  parseContainerInput,
  toAgentTaskRequest,
  toContainerOutput,
  writeMarkedOutput,
} from './protocol.js';
import { waitForHealthy } from './health-check.js';
import { sendTask, ClientError, RetryExhaustedError } from './http-client.js';
import { RedisIPCClient, RedisMessage } from './redis-ipc.js';

// Configuration from environment variables
const AGENT_URL = process.env.KUBECLAW_AGENT_URL || 'http://localhost:8080';
const REQUEST_TIMEOUT = parseInt(
  process.env.KUBECLAW_REQUEST_TIMEOUT || '300000',
  10,
);
const HEALTH_POLL_INTERVAL = parseInt(
  process.env.KUBECLAW_HEALTH_POLL_INTERVAL || '1000',
  10,
);
const HEALTH_POLL_TIMEOUT = parseInt(
  process.env.KUBECLAW_HEALTH_POLL_TIMEOUT || '30000',
  10,
);
const MAX_RETRIES = parseInt(process.env.KUBECLAW_MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.KUBECLAW_RETRY_DELAY || '1000', 10);
const HEALTH_ENDPOINT = process.env.KUBECLAW_HEALTH_ENDPOINT || '/agent/health';
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
  console.error(`[http-adapter] ${message}`);
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
 * Send a task to the agent via HTTP
 */
async function sendAgentTask(
  containerInput: ContainerInput,
): Promise<{ output: ContainerOutput; sessionId: string | undefined }> {
  const request = toAgentTaskRequest(containerInput);

  const response = await sendTask(request, {
    baseUrl: AGENT_URL,
    requestTimeout: REQUEST_TIMEOUT,
    maxRetries: MAX_RETRIES,
    retryDelay: RETRY_DELAY,
  });

  log(`Agent responded: status=${response.status}`);

  // Convert response to container output
  const output = toContainerOutput(response);

  return { output, sessionId: response.sessionId };
}

/**
 * Main processing flow
 */
async function main(): Promise<void> {
  log('Starting HTTP adapter...');
  log(`Agent URL: ${AGENT_URL}`);
  log(`Health endpoint: ${HEALTH_ENDPOINT}`);
  log(`Request timeout: ${REQUEST_TIMEOUT}ms`);
  log(`Health poll interval: ${HEALTH_POLL_INTERVAL}ms`);
  log(`Health poll timeout: ${HEALTH_POLL_TIMEOUT}ms`);
  log(`Max retries: ${MAX_RETRIES}`);
  log(`Retry delay: ${RETRY_DELAY}ms`);

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

  // Read task from stdin (backward compatibility)
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
    // Wait for agent health
    log('Checking agent health...');
    await waitForHealthy({
      url: `${AGENT_URL}${HEALTH_ENDPOINT}`,
      pollInterval: HEALTH_POLL_INTERVAL,
      timeout: HEALTH_POLL_TIMEOUT,
    });

    // Send initial task to agent
    log('Sending initial task to agent...');
    const { output, sessionId: newSessionId } =
      await sendAgentTask(containerInput);
    sessionId = newSessionId || sessionId;
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

        // Send follow-up task to agent
        const { output: followupOutput, sessionId: updatedSessionId } =
          await sendAgentTask(followupInput);
        sessionId = updatedSessionId || sessionId;
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
    let errorMsg: string;

    if (err instanceof ClientError) {
      errorMsg = err.message;
    } else if (err instanceof RetryExhaustedError) {
      errorMsg = err.message;
    } else {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    log(`Error: ${errorMsg}`);
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMsg,
    };
    await sendOutput(redisClient, output);
    await redisClient.disconnect();
    process.exit(1);
  }

  try {
    await redisClient.sendCompleted();
  } catch (_) {
    // Best-effort: ignore if already sent or connection lost
  }
  await redisClient.disconnect();
  log('HTTP adapter exiting');
}

// Run main
main().catch((err) => {
  console.error(`[http-adapter] Fatal error: ${err}`);
  process.exit(1);
});
