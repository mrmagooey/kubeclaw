import http from 'http';
import { URL } from 'url';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const LOCK_FILE = path.join(process.cwd(), 'e2e', '.mock-llm-lock');
const PID_FILE = path.join(process.cwd(), 'e2e', '.mock-llm-pid');

export interface MockResponseTemplate {
  role: 'assistant';
  content: string;
}

export interface MockLLMConfig {
  port: number;
  responses: Record<string, MockResponseTemplate>;
  defaultResponse: MockResponseTemplate;
  delay?: number;
  errorRate?: number;
}

let server: http.Server | null = null;
let serverRunning = false;
let config: MockLLMConfig | null = null;
let usageCount = 0;

const DEFAULT_RESPONSES: Record<string, MockResponseTemplate> = {
  default: {
    role: 'assistant',
    content: "Hello! I'm your NanoClaw assistant. How can I help you today?",
  },
  greeting: {
    role: 'assistant',
    content: 'Hi there! Nice to meet you!',
  },
  help: {
    role: 'assistant',
    content: "I'm here to help! What would you like to do?",
  },
  error: {
    role: 'assistant',
    content: "I'm sorry, I encountered an error processing your request.",
  },
};

export function createMockLLMServer(
  overrides: Partial<MockLLMConfig> = {},
): MockLLMConfig {
  config = {
    port: 11434,
    responses: DEFAULT_RESPONSES,
    defaultResponse: DEFAULT_RESPONSES.default,
    delay: 0,
    errorRate: 0,
    ...overrides,
  };
  return config;
}

function findMatchingResponse(
  messages: { content?: string; role?: string }[],
): string {
  if (!config) return JSON.stringify(DEFAULT_RESPONSES.default);

  const lastMessage =
    messages[messages.length - 1]?.content?.toLowerCase() || '';

  for (const [key, response] of Object.entries(config.responses)) {
    if (key !== 'default' && lastMessage.includes(key)) {
      return JSON.stringify(response);
    }
  }

  return JSON.stringify(config.defaultResponse);
}

function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (config?.errorRate && Math.random() < config.errorRate) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const messages = data.messages || [];

      const responseContent = findMatchingResponse(messages);
      const response = {
        id: `mock-chat-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model || 'test/model',
        choices: [
          {
            index: 0,
            message: JSON.parse(responseContent),
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };

      const sendResponse = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      };

      if (config?.delay) {
        setTimeout(sendResponse, config.delay);
      } else {
        sendResponse();
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}

function handleModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const models = {
    object: 'list',
    data: [
      {
        id: 'test/model',
        object: 'model',
        created: 1700000000,
        owned_by: 'test',
      },
      {
        id: 'test/fast-model',
        object: 'model',
        created: 1700000000,
        owned_by: 'test',
      },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(models));
}

function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

async function isMockServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function acquireLock(port: number): Promise<boolean> {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
      try {
        process.kill(pid, 0);
        const isRunning = await isMockServerRunning(port);
        if (isRunning) {
          console.log(`[Mock LLM] Server already running (PID: ${pid})`);
          return false;
        }
      } catch {
        console.log(`[Mock LLM] Stale lock file, PID ${pid} no longer exists`);
      }
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
}

export async function startMockLLMServer(
  overrides: Partial<MockLLMConfig> = {},
): Promise<number> {
  const port = overrides.port || 11434;

  if (serverRunning && server) {
    usageCount++;
    console.log(
      `[Mock LLM] Server already running in this process, reusing (count: ${usageCount})`,
    );
    return config?.port || port;
  }

  const mockAlreadyRunning = await isMockServerRunning(port);
  if (mockAlreadyRunning) {
    console.log(`[Mock LLM] Server already running on port ${port}, reusing`);
    serverRunning = true;
    usageCount = 1;
    config = createMockLLMServer(overrides);
    return port;
  }

  const gotLock = await acquireLock(port);
  if (!gotLock) {
    console.log(
      `[Mock LLM] Another process started server on port ${port}, waiting for it...`,
    );
    await new Promise((r) => setTimeout(r, 2000));
    const verifyRunning = await isMockServerRunning(port);
    if (verifyRunning) {
      serverRunning = true;
      usageCount = 1;
      config = createMockLLMServer(overrides);
      return port;
    }
  }

  config = createMockLLMServer(overrides);

  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${config?.port}`);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization',
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        handleChatCompletions(req, res);
      } else if (url.pathname === '/v1/models' && req.method === 'GET') {
        handleModels(req, res);
      } else if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    server.on('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Another fork won the race and is already listening; reuse it
        server = null;
        serverRunning = true;
        usageCount = 1;
        console.log(
          `[Mock LLM] Port ${port} already in use (race), reusing`,
        );
        resolve(port);
      } else {
        reject(err);
      }
    });

    const port = config?.port || 11434;
    server.listen(port, () => {
      serverRunning = true;
      console.log(`[Mock LLM] Server running on port ${port}`);
      resolve(port);
    });
  });
}

export async function stopMockLLMServer(): Promise<void> {
  usageCount--;

  if (usageCount > 0) {
    console.log(
      `[Mock LLM] Server still in use (count: ${usageCount}), not stopping`,
    );
    return;
  }

  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        serverRunning = false;
        releaseLock();
        console.log('[Mock LLM] Server stopped');
        resolve();
      });
    } else {
      serverRunning = false;
      releaseLock();
      resolve();
    }
  });
}

process.on('exit', () => {
  releaseLock();
});

process.on('SIGINT', () => {
  releaseLock();
  process.exit(0);
});

export function setResponseTemplate(
  key: string,
  response: MockResponseTemplate,
): void {
  if (config) {
    config.responses[key] = response;
  }
}

export function clearResponseTemplates(): void {
  if (config) {
    config.responses = { ...DEFAULT_RESPONSES };
  }
}
