/**
 * NanoClaw OpenRouter Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Uses OpenAI SDK with OpenRouter API for LLM inference.
 * Implements manual conversation loop with tool calling support.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per tool result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  allowedTools?: string[];
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// Environment configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_REFERER =
  process.env.OPENROUTER_HTTP_REFERER || 'https://nanoclaw.local';
const OPENROUTER_TITLE = process.env.OPENROUTER_X_TITLE || 'NanoClaw';

// Secrets to strip from Bash tool subprocess environments
const SECRET_ENV_VARS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

class MessageStream {
  private queue: string[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push(text);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

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

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[openrouter-agent] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch {
    // ignore
  }

  return null;
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function archiveConversation(
  messages: ConversationMessage[],
  sessionId: string,
  assistantName?: string,
  transcriptPath?: string,
): void {
  try {
    if (messages.length === 0) return;

    const summary = transcriptPath
      ? getSessionSummary(sessionId, transcriptPath)
      : null;
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(
      `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatTranscriptMarkdown(
  messages: ConversationMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    if (msg.role === 'tool') continue; // Skip tool results in markdown

    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function sanitizeBashCommand(command: string): string {
  const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
  return unsetPrefix + command;
}

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  for (const pattern of allowedTools) {
    if (pattern === toolName) return true;
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(toolName)) return true;
    }
  }
  return false;
}

async function discoverMcpTools(
  mcpClient: Client,
  allowedTools?: string[],
): Promise<ToolDefinition[]> {
  const toolsResponse = await mcpClient.listTools();
  const allTools = toolsResponse.tools || [];

  const tools: ToolDefinition[] = allTools
    .filter(
      (tool: { name: string }) =>
        !allowedTools || isToolAllowed(tool.name, allowedTools),
    )
    .map(
      (tool: {
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }) => ({
        name: tool.name,
        description: tool.description || `Execute ${tool.name}`,
        parameters: (tool.inputSchema as {
          type: 'object';
          properties: Record<string, unknown>;
          required?: string[];
        }) || {
          type: 'object',
          properties: {},
          required: [],
        },
      }),
    );

  log(
    `Discovered ${tools.length} MCP tools${allowedTools ? ` (filtered from ${allTools.length})` : ''}`,
  );
  return tools;
}

function mcpToolsToOpenAIFormat(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function executeTool(
  mcpClient: Client,
  toolName: string,
  args: Record<string, unknown>,
  hooks?: {
    beforeToolUse?: (
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  },
): Promise<string> {
  // Apply beforeToolUse hook for Bash tool
  if (toolName === 'Bash' && hooks?.beforeToolUse) {
    args = await hooks.beforeToolUse(toolName, args);
  }

  try {
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: args,
    });

    // Extract text content from result
    const content = result.content || [];
    const textParts = content
      .filter((c: { type?: string; text?: string }) => c.type === 'text')
      .map((c: { text?: string }) => c.text || '');

    return textParts.join('\n');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return `Error executing ${toolName}: ${errorMessage}`;
  }
}

async function runConversation(
  openai: OpenAI,
  model: string,
  messages: ConversationMessage[],
  tools: ChatCompletionTool[],
  mcpClient: Client,
  containerInput: ContainerInput,
  hooks?: {
    beforeToolUse?: (
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    beforeCompact?: (messages: ConversationMessage[]) => Promise<void>;
  },
  stream?: MessageStream,
): Promise<{
  messages: ConversationMessage[];
  shouldContinue: boolean;
  closedDuringQuery: boolean;
}> {
  const maxIterations = 50;
  let iterations = 0;
  let closedDuringQuery = false;

  while (iterations < maxIterations) {
    iterations++;

    // Check for IPC messages or close sentinel
    if (stream) {
      if (shouldClose()) {
        log('Close sentinel detected during conversation');
        closedDuringQuery = true;
        break;
      }
      const ipcMessages = drainIpcInput();
      for (const text of ipcMessages) {
        log(`Piping IPC message into conversation (${text.length} chars)`);
        messages.push({ role: 'user', content: text });
      }
    }

    // Call beforeCompact hook if configured
    if (hooks?.beforeCompact && messages.length > 10) {
      await hooks.beforeCompact(messages);
    }

    // Make API call with error handling
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model,
        messages: messages as ChatCompletionMessageParam[],
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        stream: false,
        // Add timeout via AbortController
        signal: AbortSignal.timeout(120000), // 2 minute timeout per request
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStatus = (err as { status?: number }).status;

      // Handle specific OpenRouter/HTTP errors
      if (errorStatus === 401) {
        log('API Error: 401 Unauthorized - Invalid OpenRouter API key');
        writeOutput({
          status: 'error',
          result: null,
          error:
            'Invalid OpenRouter API key. Please check your OPENROUTER_API_KEY configuration.',
        });
      } else if (errorStatus === 429) {
        log('API Error: 429 Rate Limit Exceeded');
        writeOutput({
          status: 'error',
          result: null,
          error: 'Rate limit exceeded. Please wait a moment and try again.',
        });
      } else if (errorStatus === 402) {
        log('API Error: 402 Payment Required - Insufficient credits');
        writeOutput({
          status: 'error',
          result: null,
          error:
            'Insufficient OpenRouter credits. Please add credits at https://openrouter.ai/settings/credits',
        });
      } else if (errorStatus === 404) {
        log(`API Error: 404 Model not found - ${model}`);
        writeOutput({
          status: 'error',
          result: null,
          error: `Model "${model}" not found. Please check the model ID at https://openrouter.ai/models`,
        });
      } else if (errorStatus >= 500) {
        log(`API Error: ${errorStatus} Server Error`);
        writeOutput({
          status: 'error',
          result: null,
          error:
            'OpenRouter server error. Please try again later or switch models.',
        });
      } else if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('Abort')
      ) {
        log('API Error: Request timeout');
        writeOutput({
          status: 'error',
          result: null,
          error:
            'Request timed out. The model may be overloaded. Please try again.',
        });
      } else {
        log(`API Error: ${errorMessage}`);
        writeOutput({
          status: 'error',
          result: null,
          error: `OpenRouter API error: ${errorMessage}`,
        });
      }

      // Don't continue the loop on API errors
      return { messages, shouldContinue: false, closedDuringQuery };
    }

    const response = completion.choices[0];

    if (!response.message) {
      log('No message in response');
      break;
    }

    // Add assistant message
    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: response.message.content || '',
    };

    if (response.message.tool_calls) {
      assistantMessage.tool_calls = response.message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    messages.push(assistantMessage);

    // Write output for user-facing content
    if (response.message.content) {
      writeOutput({
        status: 'success',
        result: response.message.content,
      });
    }

    // Handle tool calls
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      for (const toolCall of response.message.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;

        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        log(`Executing tool: ${toolName}`);

        const toolResult = await executeTool(
          mcpClient,
          toolName,
          toolArgs,
          hooks,
        );

        // Add tool result to messages
        messages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: toolCall.id,
          name: toolName,
        });
      }
      // Continue loop to get next response
      continue;
    }

    // No tool calls, conversation is complete
    break;
  }

  if (iterations >= maxIterations) {
    log('Max iterations reached, stopping conversation');
  }

  return { messages, shouldContinue: !closedDuringQuery, closedDuringQuery };
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  // Initialize OpenAI client with OpenRouter
  const openai = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_TITLE,
    },
  });

  // Connect to MCP server
  const mcpTransport = new StdioClientTransport({
    command: 'node',
    args: [mcpServerPath],
    env: {
      ...process.env,
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    } as Record<string, string>,
  });

  const mcpClient = new Client({
    name: 'nanoclaw-openrouter',
    version: '1.0.0',
  });
  await mcpClient.connect(mcpTransport);

  try {
    // Discover tools from MCP server
    const allowedTools = containerInput.allowedTools || [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'NotebookEdit',
      'send_message',
      'schedule_task',
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
      'update_task',
      'register_group',
    ];

    const mcpTools = await discoverMcpTools(mcpClient, allowedTools);
    const openaiTools = mcpToolsToOpenAIFormat(mcpTools);

    log(`Starting conversation with ${openaiTools.length} tools`);

    // Load global CLAUDE.md as system context
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let systemContent = '';

    if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      systemContent = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    // Build conversation history
    const messages: ConversationMessage[] = [];

    if (systemContent) {
      messages.push({
        role: 'system',
        content: systemContent,
      });
    }

    // Add initial user message
    messages.push({
      role: 'user',
      content: prompt,
    });

    // Setup hooks
    const hooks: {
      beforeToolUse?: (
        toolName: string,
        args: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      beforeCompact?: (messages: ConversationMessage[]) => Promise<void>;
    } = {
      beforeToolUse: async (_toolName, args) => {
        if (args.command && typeof args.command === 'string') {
          return {
            ...args,
            command: sanitizeBashCommand(args.command),
          };
        }
        return args;
      },
      beforeCompact: async (msgs) => {
        const newSessionId = sessionId || `session-${Date.now()}`;
        const transcriptPath = `/workspace/group/.transcript-${newSessionId}.jsonl`;
        archiveConversation(
          msgs,
          newSessionId,
          containerInput.assistantName,
          transcriptPath,
        );
      },
    };

    // Create message stream for IPC
    const stream = new MessageStream();

    // Run conversation
    const result = await runConversation(
      openai,
      OPENROUTER_MODEL,
      messages,
      openaiTools,
      mcpClient,
      containerInput,
      hooks,
      stream,
    );

    const newSessionId = sessionId || `session-${Date.now()}`;

    // Save conversation state
    const transcriptPath = `/workspace/group/.transcript-${newSessionId}.jsonl`;
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify(messages));

    return {
      newSessionId,
      closedDuringQuery: result.closedDuringQuery,
    };
  } finally {
    await mcpClient.close();
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  // Validate environment configuration first
  if (!OPENROUTER_API_KEY) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'OPENROUTER_API_KEY environment variable is not set. Please configure your OpenRouter API key.',
    });
    process.exit(1);
  }

  // Validate API key format (OpenRouter keys start with 'sk-or-v1-')
  if (!OPENROUTER_API_KEY.startsWith('sk-or-v1-')) {
    log(
      'Warning: OPENROUTER_API_KEY does not have the expected format (should start with sk-or-v1-)',
    );
  }

  // Validate model format (should include provider prefix like "openai/")
  if (!OPENROUTER_MODEL.includes('/')) {
    log(
      `Warning: Model "${OPENROUTER_MODEL}" may be invalid. OpenRouter models should use "provider/model-name" format (e.g., "openai/gpt-4o")`,
    );
  }

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // If _close was consumed during the query, exit immediately
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
