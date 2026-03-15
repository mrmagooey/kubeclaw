/**
 * Types for the NanoClaw sidecar adapter
 */

export interface TaskInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface TaskOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface SidecarConfig {
  inputDir: string;
  outputDir: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface FileTask {
  filename: string;
  input: TaskInput;
  sequence: number;
}
