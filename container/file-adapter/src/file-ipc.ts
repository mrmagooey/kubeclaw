/**
 * NanoClaw File Adapter - File IPC
 *
 * Handles file-based IPC using polling (not inotify) for maximum portability.
 * Watches for task files in /workspace/input/ and reads result files from
 * /workspace/output/
 */

import fs from 'fs';
import path from 'path';
import { TaskFile, ResultFile } from './protocol.js';

export interface FileIPCOptions {
  inputDir: string;
  outputDir: string;
  pollInterval: number; // milliseconds
  timeout: number; // milliseconds
}

export class FileIPC {
  private options: FileIPCOptions;
  private taskCounter: number = 0;

  constructor(options: FileIPCOptions) {
    this.options = options;
    this.ensureDirectories();
  }

  /**
   * Ensure input and output directories exist
   */
  private ensureDirectories(): void {
    fs.mkdirSync(this.options.inputDir, { recursive: true });
    fs.mkdirSync(this.options.outputDir, { recursive: true });
  }

  /**
   * Write a task file to the input directory
   * Uses sequential naming for follow-up messages (task.json, task_1.json, task_2.json, etc.)
   */
  writeTask(task: TaskFile): string {
    const filename =
      this.taskCounter === 0 ? 'task.json' : `task_${this.taskCounter}.json`;

    const filePath = path.join(this.options.inputDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
    this.taskCounter++;

    return filePath;
  }

  /**
   * Poll for result file with timeout
   * Returns the result or null if timeout
   */
  async waitForResult(): Promise<ResultFile | null> {
    const resultPath = path.join(this.options.outputDir, 'result.json');
    const startTime = Date.now();
    const timeout = this.options.timeout;

    return new Promise((resolve) => {
      const poll = () => {
        // Check if we've exceeded timeout
        if (Date.now() - startTime > timeout) {
          resolve(null);
          return;
        }

        // Check if result file exists
        if (fs.existsSync(resultPath)) {
          try {
            const content = fs.readFileSync(resultPath, 'utf-8');
            const result: ResultFile = JSON.parse(content);
            resolve(result);
            return;
          } catch (err) {
            // File might be partially written, continue polling
            console.error(`[file-adapter] Error reading result file: ${err}`);
          }
        }

        // Poll again after interval
        setTimeout(poll, this.options.pollInterval);
      };

      poll();
    });
  }

  /**
   * Clean up input and output files after processing
   */
  cleanupFiles(): void {
    // Clean up all task files
    try {
      const inputFiles = fs
        .readdirSync(this.options.inputDir)
        .filter((f) => f.startsWith('task') && f.endsWith('.json'));

      for (const file of inputFiles) {
        try {
          fs.unlinkSync(path.join(this.options.inputDir, file));
        } catch {
          // Ignore errors during cleanup
        }
      }
    } catch {
      // Directory might not exist
    }

    // Clean up result file
    try {
      const resultPath = path.join(this.options.outputDir, 'result.json');
      if (fs.existsSync(resultPath)) {
        fs.unlinkSync(resultPath);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Get the current task sequence number
   */
  getTaskCounter(): number {
    return this.taskCounter;
  }

  /**
   * Reset the task counter (useful for testing)
   */
  resetTaskCounter(): void {
    this.taskCounter = 0;
  }
}
