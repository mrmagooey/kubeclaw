/**
 * NanoClaw HTTP Adapter - Protocol Handling
 *
 * Handles the NanoClaw protocol markers for stdin/stdout communication
 * with the orchestrator.
 */

// Marker constants matching the main agent runner
export const OUTPUT_START_MARKER = '---KUBECLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---KUBECLAW_OUTPUT_END---';

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
 * Request body sent to the agent's POST /agent/task endpoint
 */
export interface AgentTaskRequest {
  prompt: string;
  sessionId?: string;
  context: {
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
    assistantName: string;
  };
  secrets?: Record<string, string>;
}

/**
 * Expected response from the agent's POST /agent/task endpoint
 */
export interface AgentTaskResponse {
  status: 'success' | 'error';
  result?: string;
  sessionId?: string;
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

  if (!parsed.prompt) throw new Error('Missing required field: prompt');
  if (!parsed.groupFolder)
    throw new Error('Missing required field: groupFolder');
  if (!parsed.chatJid) throw new Error('Missing required field: chatJid');
  if (typeof parsed.isMain !== 'boolean')
    throw new Error('Missing or invalid field: isMain');

  return parsed as ContainerInput;
}

/**
 * Convert ContainerInput to AgentTaskRequest
 */
export function toAgentTaskRequest(input: ContainerInput): AgentTaskRequest {
  return {
    prompt: input.prompt,
    sessionId: input.sessionId,
    context: {
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      isMain: input.isMain,
      assistantName: input.assistantName || 'Andy',
    },
    secrets: input.secrets,
  };
}

/**
 * Convert AgentTaskResponse to ContainerOutput
 */
export function toContainerOutput(
  response: AgentTaskResponse,
): ContainerOutput {
  return {
    status: response.status,
    result: response.result || null,
    newSessionId: response.sessionId,
    error: response.error,
  };
}
