#!/usr/bin/env node
// Mock LLM server — mimics OpenAI-compatible API for integration tests.
// Uses only Node.js built-in modules. Requires Node 20+.

'use strict';

const http = require('node:http');

const PORT = parseInt(process.env.PORT ?? '8080', 10);

const MODELS_RESPONSE = JSON.stringify({
  object: 'list',
  data: [
    {
      id: 'mock-model',
      object: 'model',
      created: 1234567890,
      owned_by: 'mock',
    },
  ],
});

function makeToolCallsResponse(toolName, toolArgs) {
  const actualToolName = toolName || 'web_search';
  const actualToolArgs = toolArgs || '{"query":"mock search query"}';

  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1234567890,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_mock',
              type: 'function',
              function: {
                name: actualToolName,
                arguments: actualToolArgs,
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

function makeTextResponse(content) {
  const actualContent = content !== undefined ? content : 'Mock response.';

  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1234567890,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: actualContent },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractTaskId(text) {
  // Extract the first task-[a-z0-9]+ pattern from the text
  const match = text.match(/task-[a-z0-9]+/i);
  return match ? match[0] : 'PLACEHOLDER_TASK_ID';
}

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const msg = messages[i];
      return typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    }
  }
  return '';
}

function classifyRequest(body) {
  try {
    const parsed = JSON.parse(body);
    const messages = parsed.messages ?? [];

    // Count tool rounds
    const toolRoundCount = messages.filter((m) => m.role === 'tool').length;

    // Get the last user message
    const lastUserMsg = getLastUserMessage(messages);

    // Rule 1: Task fired signal
    if (/TASK_FIRED_OK/i.test(lastUserMsg)) {
      return 'task_fired';
    }

    // Rule 2: Recall (with history)
    if (/what code/i.test(lastUserMsg)) {
      const hasBanana42 = messages.some(
        (m) => m.role === 'assistant' && m.content && m.content.includes('BANANA42'),
      );
      if (hasBanana42) {
        return 'recall';
      }
    }

    // Rule 3: Remember
    if (/remember the code/i.test(lastUserMsg)) {
      return 'remember';
    }

    // Rules 4-13: Check toolRoundCount for tool-triggering rules
    if (toolRoundCount === 0) {
      // Rule 5: Schedule task
      if (/schedule|cron|interval/i.test(lastUserMsg)) {
        return 'schedule_task';
      }

      // Rule 6: List tasks
      if (/list.*task/i.test(lastUserMsg)) {
        return 'list_tasks';
      }

      // Rule 7: Cancel task
      if (/cancel.*task/i.test(lastUserMsg)) {
        return 'cancel_task';
      }

      // Rule 8: Pause task
      if (/pause.*task/i.test(lastUserMsg)) {
        return 'pause_task';
      }

      // Rule 9: Resume task
      if (/resume.*task/i.test(lastUserMsg)) {
        return 'resume_task';
      }

      // Rule 10: Bash
      if (/bash|shell command|run a command/i.test(lastUserMsg)) {
        return 'bash';
      }

      // Rule 11: Multi-tool web_search first round
      if (/search then fetch/i.test(lastUserMsg)) {
        return 'web_search';
      }

      // Rule 13: web_search (existing)
      if (/web_search|search/i.test(lastUserMsg)) {
        return 'web_search';
      }
    }

    // Rule 12: Multi-tool web_fetch second round
    if (toolRoundCount === 1) {
      // Check if any prior user message matches "search then fetch"
      const hasSearchThenFetch = messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && /search then fetch/i.test(m.content),
      );
      if (hasSearchThenFetch) {
        return 'web_fetch';
      }
    }

    // Rule 14: Default
    return 'plain';
  } catch {
    // ignore parse errors — fall through to plain response
    return 'plain';
  }
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  process.stderr.write(`[mock-llm] ${method} ${url}\n`);

  // GET /health
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // GET /v1/models
  if (method === 'GET' && url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(MODELS_RESPONSE);
    return;
  }

  // POST /v1/embeddings — return zero-vector embeddings for RAG compatibility
  if (method === 'POST' && url === '/v1/embeddings') {
    let body = '';
    try { body = await readBody(req); } catch { /* ignore */ }
    let inputs = [];
    try {
      const parsed = JSON.parse(body);
      inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    } catch { inputs = ['']; }
    const zeroVec = new Array(1536).fill(0);
    const data = inputs.map((_, i) => ({ object: 'embedding', embedding: zeroVec, index: i }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data,
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 },
    }));
    return;
  }

  // POST /v1/chat/completions
  if (method === 'POST' && url === '/v1/chat/completions') {
    let body = '';
    try {
      body = await readBody(req);
    } catch (err) {
      process.stderr.write(`[mock-llm] error reading body: ${err}\n`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }

    const classification = classifyRequest(body);
    let responseBody;

    switch (classification) {
      case 'task_fired':
        responseBody = makeTextResponse('TASK_FIRED_OK');
        break;
      case 'recall':
        responseBody = makeTextResponse('The code is BANANA42');
        break;
      case 'remember':
        responseBody = makeTextResponse('I will remember: BANANA42');
        break;
      case 'schedule_task':
        responseBody = makeToolCallsResponse(
          'schedule_task',
          '{"prompt":"Say TASK_FIRED_OK","schedule_type":"interval","schedule_value":"5000"}',
        );
        break;
      case 'list_tasks':
        responseBody = makeToolCallsResponse('list_tasks', '{}');
        break;
      case 'cancel_task': {
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        const lastUserMsg = getLastUserMessage(messages);
        const taskId = extractTaskId(lastUserMsg);
        responseBody = makeToolCallsResponse(
          'cancel_task',
          JSON.stringify({ task_id: taskId }),
        );
        break;
      }
      case 'pause_task': {
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        const lastUserMsg = getLastUserMessage(messages);
        const taskId = extractTaskId(lastUserMsg);
        responseBody = makeToolCallsResponse(
          'pause_task',
          JSON.stringify({ task_id: taskId, action: 'pause' }),
        );
        break;
      }
      case 'resume_task': {
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        const lastUserMsg = getLastUserMessage(messages);
        const taskId = extractTaskId(lastUserMsg);
        responseBody = makeToolCallsResponse(
          'resume_task',
          JSON.stringify({ task_id: taskId, action: 'resume' }),
        );
        break;
      }
      case 'bash':
        responseBody = makeToolCallsResponse('bash', '{"command":"echo hello world"}');
        break;
      case 'web_search':
        responseBody = makeToolCallsResponse('web_search', '{"query":"mock search query"}');
        break;
      case 'web_fetch':
        responseBody = makeToolCallsResponse('web_fetch', '{"url":"https://example.com"}');
        break;
      case 'plain':
      default:
        responseBody = makeTextResponse();
        break;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(responseBody);
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  process.stderr.write(`[mock-llm] listening on port ${PORT}\n`);
});
