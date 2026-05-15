import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

// In-memory log of all text values recorded via record_test_message.
const messages = [];

/**
 * Build a fresh McpServer + transport for each stateless POST request.
 * The SDK example pattern for stateless mode is: create server, create transport,
 * connect, handleRequest — then tear down on response close.
 */
function makeServer() {
  const server = new McpServer(
    { name: 'kubeclaw-test-mcp-server', version: '1.0.0' },
    { capabilities: {} },
  );

  server.registerTool(
    'record_test_message',
    {
      description: 'Records a text message for later inspection by the test suite.',
      inputSchema: {
        text: z.string().describe('The message text to record'),
      },
    },
    async ({ text }) => {
      messages.push(text);
      console.log(`[record_test_message] recorded: ${JSON.stringify(text)}`);
      return {
        content: [{ type: 'text', text: 'recorded:' + text }],
      };
    },
  );

  return server;
}

// Plain express app — no DNS-rebinding middleware, appropriate for a test fixture that
// must accept traffic from inside k8s under arbitrary service DNS names.
const app = express();
app.use(express.json());

// MCP Streamable HTTP transport — stateless (no sessionIdGenerator).
app.post('/mcp', async (req, res) => {
  const server = makeServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error('[POST /mcp] error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET /mcp — required by the MCP spec for SSE GET streams; we return 405 since
// we're stateless and don't support server-initiated notifications.
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

// DELETE /mcp — required by spec for session termination; also 405 in stateless mode.
app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
});

// Test-only side channel: returns all messages recorded by record_test_message.
app.get('/test/log', (_req, res) => {
  console.log(`[GET /test/log] returning ${messages.length} message(s)`);
  res.json({ messages });
});

// Health check — good hygiene even though the k8s readiness probe uses tcpSocket.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Only start listening when executed directly (not when imported for parse checks).
async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`kubeclaw-test-mcp-server listening on port ${port}`);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down.');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('Shutting down.');
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
