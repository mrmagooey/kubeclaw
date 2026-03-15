/**
 * NanoClaw Sidecar Adapter
 *
 * This container runs as a sidecar in Kubernetes, providing file-based IPC
 * between NanoClaw orchestrator and arbitrary user containers.
 *
 * Input protocol:
 *   - Stdin: TaskInput JSON from orchestrator
 *   - File input: Additional task files written to /workspace/input/
 *
 * Output protocol:
 *   - File output: User container writes results to /workspace/output/
 *   - Stdout: Sidecar wraps results in NanoClaw markers and writes to stdout
 *
 * File protocol:
 *   - Input: /workspace/input/task.json (initial), task_1.json, task_2.json (follow-ups)
 *   - Output: /workspace/output/result.json
 */

import fs from 'fs';
import { FileIPC } from './file-ipc.js';
import { ProtocolHandler } from './protocol.js';
import { TaskInput, TaskOutput, SidecarConfig } from './types.js';

// Configuration from environment
const config: SidecarConfig = {
  inputDir: process.env.NANOCLAW_INPUT_DIR || '/workspace/input',
  outputDir: process.env.NANOCLAW_OUTPUT_DIR || '/workspace/output',
  pollIntervalMs: parseInt(process.env.NANOCLAW_POLL_INTERVAL || '1000', 10),
  timeoutMs: parseInt(process.env.NANOCLAW_TIMEOUT || '1800000', 10), // 30min default
};

const protocol = new ProtocolHandler();
const fileIPC = new FileIPC(
  config.inputDir,
  config.outputDir,
  config.pollIntervalMs,
);

/**
 * Read all data from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Main loop: handle initial task, then wait for follow-ups
 */
async function main(): Promise<void> {
  protocol.log('Sidecar adapter starting...');
  protocol.log(`Input dir: ${config.inputDir}`);
  protocol.log(`Output dir: ${config.outputDir}`);
  protocol.log(`Poll interval: ${config.pollIntervalMs}ms`);
  protocol.log(`Timeout: ${config.timeoutMs}ms`);

  try {
    // Read initial task from stdin
    const stdinData = await readStdin();
    const initialTask = await fileIPC.readInitialTask(stdinData);

    protocol.log(`Received initial task for group: ${initialTask.groupFolder}`);

    // Write initial task to file for user container
    fileIPC.writeTaskFile(initialTask, 0);

    // Track session state
    let sessionId = initialTask.sessionId;
    let taskSequence = 1;

    // Main loop: wait for output, then wait for new tasks
    while (true) {
      try {
        // Wait for user container to produce output
        protocol.log('Waiting for output from user container...');
        const output = await fileIPC.waitForOutput(config.timeoutMs);

        // Update session if provided
        if (output.newSessionId) {
          sessionId = output.newSessionId;
        }

        // Write output to stdout with markers
        protocol.writeOutput(output);

        protocol.log('Output written to stdout, waiting for next input...');

        // Wait for follow-up task or timeout
        const nextTask = await fileIPC.waitForNewTask(config.timeoutMs);

        if (nextTask === null) {
          // Timeout - no new tasks
          protocol.log('Timeout waiting for next task, exiting');
          break;
        }

        // Process the follow-up task
        protocol.log(`Received follow-up task #${nextTask.sequence}`);

        // Clean up the processed task file
        fileIPC.cleanupTaskFile(nextTask.filename);

        // Write follow-up to input directory for user container
        fileIPC.writeTaskFile(nextTask.input, taskSequence++);

        protocol.log('Follow-up task written to input directory');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        protocol.log(`Error in main loop: ${errorMessage}`);

        // Write error to stdout and exit
        protocol.writeError(errorMessage);
        process.exit(1);
      }
    }

    // Write final completion marker
    protocol.writeCompletion(sessionId);
    protocol.log('Sidecar adapter completed successfully');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    protocol.log(`Fatal error: ${errorMessage}`);
    protocol.writeError(errorMessage);
    process.exit(1);
  } finally {
    // Clean up any remaining task files
    fileIPC.cleanupAllTasks();
  }
}

// Handle SIGTERM and SIGINT gracefully
process.on('SIGTERM', () => {
  protocol.log('Received SIGTERM, cleaning up...');
  fileIPC.cleanupAllTasks();
  process.exit(0);
});

process.on('SIGINT', () => {
  protocol.log('Received SIGINT, cleaning up...');
  fileIPC.cleanupAllTasks();
  process.exit(0);
});

// Run main
main();
