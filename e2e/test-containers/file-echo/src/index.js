/**
 * File Echo Test Container
 *
 * Reads tasks from /workspace/input/task.json
 * Writes results to /workspace/output/result.json
 *
 * Loops continuously so the file-adapter can deliver follow-up tasks
 * after the initial task without restarting the container.
 *
 * Supports special commands:
 * - "CRASH" -> exits with error code
 * - "TIMEOUT" -> sleeps indefinitely
 */

import fs from 'fs';
import path from 'path';

const INPUT_DIR = process.env.NANOCLAW_INPUT_DIR || '/workspace/input';
const OUTPUT_DIR = process.env.NANOCLAW_OUTPUT_DIR || '/workspace/output';
const POLL_INTERVAL = parseInt(
  process.env.NANOCLAW_POLL_INTERVAL || '1000',
  10,
);

const RESULT_FILE = path.join(OUTPUT_DIR, 'result.json');

function log(message) {
  console.error(`[file-echo] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The file-adapter writes tasks as:
 *   task.json         (initial task)
 *   task_1.json       (first follow-up)
 *   task_2.json       (second follow-up)
 * etc.
 *
 * We look for any task_*.json or task.json file, in order of creation time.
 */
async function waitForTask(taskCounter) {
  const filename = taskCounter === 0 ? 'task.json' : `task_${taskCounter}.json`;
  const taskFile = path.join(INPUT_DIR, filename);

  log(`Waiting for task file: ${taskFile}`);

  while (true) {
    try {
      if (fs.existsSync(taskFile)) {
        const content = fs.readFileSync(taskFile, 'utf-8');
        log(`Found task file ${filename}: ${content.substring(0, 200)}...`);
        return { task: JSON.parse(content), taskFile };
      }
    } catch (err) {
      log(`Error reading task file: ${err.message}`);
    }

    await sleep(POLL_INTERVAL);
  }
}

function processTask(task) {
  // Support both the new file-adapter format (task.prompt / task.sessionId) and
  // the old format (task.input.messages[].content) for backward compatibility.
  const content =
    task.prompt ||
    (task.input?.messages || []).filter((m) => m.role === 'user').pop()
      ?.content ||
    '';
  const sessionId = task.sessionId || task.input?.sessionId;

  log(`Processing task: "${content.substring(0, 50)}..."`);

  // Handle special commands
  if (content === 'CRASH') {
    log('CRASH command received - exiting with error');
    process.exit(1);
  }

  if (content === 'TIMEOUT') {
    log('TIMEOUT command received - sleeping indefinitely');
    // Never resolve - simulates timeout
    return new Promise(() => {});
  }

  // Normal echo response
  const result = {
    status: 'success',
    result: {
      text: `Echo: ${content}`,
    },
    newSessionId:
      sessionId ||
      `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
  };

  return result;
}

function writeResult(result, taskFile) {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  log(`Writing result to: ${RESULT_FILE}`);
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // Clean up task file
  if (taskFile && fs.existsSync(taskFile)) {
    fs.unlinkSync(taskFile);
    log(`Cleaned up task file: ${path.basename(taskFile)}`);
  }
}

async function main() {
  log('File Echo Test Container starting...');
  log(`Input dir: ${INPUT_DIR}`);
  log(`Output dir: ${OUTPUT_DIR}`);
  log(`Poll interval: ${POLL_INTERVAL}ms`);

  let taskCounter = 0;

  // Loop to handle multiple tasks (initial + follow-ups delivered by the adapter)
  while (true) {
    try {
      // Wait for and process the next task
      const { task, taskFile } = await waitForTask(taskCounter);
      const result = processTask(task);

      // If result is a promise (TIMEOUT), it will never resolve
      if (result instanceof Promise) {
        await result;
      } else {
        writeResult(result, taskFile);
        log('Task completed successfully');
        taskCounter++;
      }
    } catch (err) {
      log(`Error processing task: ${err.message}`);

      const errorResult = {
        status: 'error',
        result: null,
        error: err.message,
      };

      writeResult(errorResult);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
