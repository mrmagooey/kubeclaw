import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'http';

function createMcpServer() {
  const mcp = new Server(
    { name: 'echo', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Returns the input string.',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'echo') {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    return {
      content: [{ type: 'text', text: String(req.params.arguments?.msg ?? '') }],
    };
  });

  return mcp;
}

const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (req.url === '/mcp') {
    // In MCP SDK >=1.10, stateless transports cannot be reused across requests.
    // Create a fresh Server + transport per request to avoid message-ID collisions.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcp = createMcpServer();
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    await mcp.close();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log('echo-mcp listening on 3000'));
