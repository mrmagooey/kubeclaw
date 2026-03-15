/**
 * File-based IPC implementation for sidecar adapter
 * Uses polling (not inotify) for portability
 */

import fs from 'fs';
import path from 'path';
import { TaskInput, TaskOutput, FileTask } from './types.js';

const TASK_FILE_PATTERN = /^task(_\d+)?\.json$/;
const OUTPUT_FILE = 'result.json';

export class FileIPC {
  private inputDir: string;
  private outputDir: string;
  private pollIntervalMs: number;

  constructor(
    inputDir: string,
    outputDir: string,
    pollIntervalMs: number = 1000,
  ) {
    this.inputDir = inputDir;
    this.outputDir = outputDir;
    this.pollIntervalMs = pollIntervalMs;

    // Ensure directories exist
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.inputDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Read initial task from file or stdin
   */
  async readInitialTask(stdinData: string): Promise<TaskInput> {
    try {
      return JSON.parse(stdinData) as TaskInput;
    } catch (err) {
      throw new Error(
        `Failed to parse initial task from stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Write task to input directory for user container
   */
  writeTaskFile(task: TaskInput, sequence: number = 0): string {
    const filename = sequence === 0 ? 'task.json' : `task_${sequence}.json`;
    const filepath = path.join(this.inputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(task, null, 2));
    return filepath;
  }

  /**
   * Clean up processed task file
   */
  cleanupTaskFile(filename: string): void {
    try {
      const filepath = path.join(this.inputDir, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (err) {
      console.error(
        `[sidecar] Failed to cleanup task file ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Poll for output file from user container
   */
  async waitForOutput(timeoutMs: number): Promise<TaskOutput> {
    const startTime = Date.now();
    const outputPath = path.join(this.outputDir, OUTPUT_FILE);

    return new Promise((resolve, reject) => {
      const poll = () => {
        try {
          if (fs.existsSync(outputPath)) {
            const content = fs.readFileSync(outputPath, 'utf-8');

            // Clean up output file after reading
            try {
              fs.unlinkSync(outputPath);
            } catch (cleanupErr) {
              console.error(
                `[sidecar] Failed to cleanup output file: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
              );
            }

            try {
              const output = JSON.parse(content) as TaskOutput;
              resolve(output);
              return;
            } catch (parseErr) {
              reject(
                new Error(
                  `Failed to parse output file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                ),
              );
              return;
            }
          }
        } catch (err) {
          console.error(
            `[sidecar] Error polling output: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (Date.now() - startTime >= timeoutMs) {
          reject(new Error('Timeout waiting for output file'));
          return;
        }

        setTimeout(poll, this.pollIntervalMs);
      };

      poll();
    });
  }

  /**
   * Check for additional task files (follow-up messages)
   * Returns array of files sorted by sequence number
   */
  scanForAdditionalTasks(): FileTask[] {
    try {
      const files = fs
        .readdirSync(this.inputDir)
        .filter((f) => TASK_FILE_PATTERN.test(f))
        .sort();

      const tasks: FileTask[] = [];

      for (const filename of files) {
        if (filename === 'task.json') {
          // Skip initial task, only process follow-ups
          continue;
        }

        const filepath = path.join(this.inputDir, filename);
        try {
          const content = fs.readFileSync(filepath, 'utf-8');
          const input = JSON.parse(content) as TaskInput;

          // Extract sequence number
          const match = filename.match(/^task_(\d+)\.json$/);
          const sequence = match ? parseInt(match[1], 10) : 1;

          tasks.push({ filename, input, sequence });
        } catch (err) {
          console.error(
            `[sidecar] Failed to read task file ${filename}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Sort by sequence number
      return tasks.sort((a, b) => a.sequence - b.sequence);
    } catch (err) {
      console.error(
        `[sidecar] Error scanning for tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Wait for a new task file to appear
   */
  async waitForNewTask(timeoutMs: number): Promise<FileTask | null> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const poll = () => {
        const tasks = this.scanForAdditionalTasks();

        if (tasks.length > 0) {
          resolve(tasks[0]);
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          resolve(null);
          return;
        }

        setTimeout(poll, this.pollIntervalMs);
      };

      poll();
    });
  }

  /**
   * Clean up all task files (for cleanup on exit)
   */
  cleanupAllTasks(): void {
    try {
      const files = fs
        .readdirSync(this.inputDir)
        .filter((f) => TASK_FILE_PATTERN.test(f));

      for (const filename of files) {
        this.cleanupTaskFile(filename);
      }
    } catch (err) {
      console.error(
        `[sidecar] Failed to cleanup all tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Get input directory path
   */
  getInputDir(): string {
    return this.inputDir;
  }

  /**
   * Get output directory path
   */
  getOutputDir(): string {
    return this.outputDir;
  }
}
