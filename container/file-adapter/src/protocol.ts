/**
 * NanoClaw File Adapter - Protocol Handling
 *
 * Handles the NanoClaw protocol markers for stdin/stdout communication
 * with the orchestrator.
 */

// Marker constants matching the main agent runner
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Container input from orchestrator (via stdin)
 */
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

/**
 * Container output to orchestrator (via stdout with markers)
 */
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Task file format written to /workspace/input/task.json
 */
export interface TaskFile {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

/**
 * Result file format read from /workspace/output/result.json
 */
export interface ResultFile {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Wrap output with NanoClaw markers and write to stdout
 */
export function writeMarkedOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Read all data from stdin until EOF
 */
export async function readStdin(): Promise<string> {
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
 * Parse container input from JSON string
 */
export function parseContainerInput(data: string): ContainerInput {
  const parsed = JSON.parse(data);

  // Validate required fields
  if (!parsed.prompt) throw new Error('Missing required field: prompt');
  if (!parsed.groupFolder)
    throw new Error('Missing required field: groupFolder');
  if (!parsed.chatJid) throw new Error('Missing required field: chatJid');
  if (typeof parsed.isMain !== 'boolean')
    throw new Error('Missing or invalid field: isMain');

  return parsed as ContainerInput;
}

/**
 * Convert container input to task file format
 */
export function toTaskFile(input: ContainerInput): TaskFile {
  return {
    prompt: input.prompt,
    sessionId: input.sessionId,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask,
    assistantName: input.assistantName,
    secrets: input.secrets,
  };
}

/**
 * Convert result file to container output
 */
export function toContainerOutput(result: ResultFile): ContainerOutput {
  return {
    status: result.status,
    result: result.result,
    newSessionId: result.newSessionId,
    error: result.error,
  };
}
