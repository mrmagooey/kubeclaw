/**
 * In-cluster mock LLM server (standalone ESM, no dependencies beyond node:http).
 *
 * Endpoints:
 *   POST /v1/chat/completions   — returns queued tool_calls or a default text response
 *   GET  /v1/models             — returns a static model list
 *   GET  /health                — returns {"status":"ok"}
 *   POST /control/queue-tool-call — body: {"name":"fn","arguments":{...}}
 *   POST /control/clear         — clears both response queue and tool-call queue
 */

import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '11434', 10);

// ── Tool-call queue ───────────────────────────────────────────────────────────

/** @type {{ name: string; arguments: Record<string, unknown> }[]} */
let pendingToolCalls = [];
let toolCallIdCounter = 0;

// ── Default text response ─────────────────────────────────────────────────────

const DEFAULT_RESPONSE_CONTENT = "Hello! I'm your KubeClaw assistant. How can I help you today?";

function buildTextResponse(model) {
  return {
    id: `mock-chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'test/model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: DEFAULT_RESPONSE_CONTENT,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

function buildToolCallResponse(toolCall, model) {
  const callId = `call_mock_${String(++toolCallIdCounter).padStart(3, '0')}`;
  return {
    id: `mock-chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'test/model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      const model = data.model;

      if (pendingToolCalls.length > 0) {
        const toolCall = pendingToolCalls.shift();
        json(res, 200, buildToolCallResponse(toolCall, model));
      } else {
        json(res, 200, buildTextResponse(model));
      }

    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      json(res, 200, {
        object: 'list',
        data: [
          { id: 'test/model', object: 'model', created: 1700000000, owned_by: 'test' },
          { id: 'test/fast-model', object: 'model', created: 1700000000, owned_by: 'test' },
        ],
      });

    } else if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });

    } else if (url.pathname === '/control/queue-tool-call' && req.method === 'POST') {
      const raw = await readBody(req);
      const def = JSON.parse(raw);
      pendingToolCalls.push(def);
      json(res, 200, { queued: true, queueLength: pendingToolCalls.length });

    } else if (url.pathname === '/control/clear' && req.method === 'POST') {
      pendingToolCalls = [];
      toolCallIdCounter = 0;
      json(res, 200, { cleared: true });

    } else {
      json(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error('[mock-llm] Error handling request:', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-llm] Listening on port ${PORT}`);
});
