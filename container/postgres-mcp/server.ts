/**
 * Postgres-MCP server: exposes a read-only `query` tool over MCP,
 * token-gated via Bearer auth on the /mcp endpoint.
 *
 * Pure helpers (capRows, isAuthorized) are exported for unit testing.
 * The pg Pool and MCP wiring live inside main() and use dynamic imports
 * so the module can be loaded in tests without pg installed.
 */

// ─── Pure helpers (unit-testable, no external deps) ──────────────────────────

export interface CapRowsResult {
  rows: unknown[];
  truncated: boolean;
}

/**
 * Limits rows to `max`. Returns the (possibly sliced) rows plus a flag
 * indicating whether the result was truncated.
 */
export function capRows(rows: unknown[], max: number): CapRowsResult {
  if (rows.length > max) {
    return { rows: rows.slice(0, max), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * Returns true iff `authHeader` is exactly `"Bearer <expectedToken>"`.
 * Rejects undefined, a bare token, or a mismatched token.
 */
export function isAuthorized(
  authHeader: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!authHeader || !expectedToken) return false;
  return authHeader === `Bearer ${expectedToken}`;
}

// ─── Server wiring ────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // Dynamic imports so module loads in tests without pg / MCP SDK installed.
  const { default: pg } = await import('pg');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );
  const { createServer } = await import('http');

  const MAX_ROWS = parseInt(process.env.KUBECLAW_DB_MAX_ROWS ?? '1000', 10);
  const STATEMENT_TIMEOUT = parseInt(
    process.env.KUBECLAW_DB_STATEMENT_TIMEOUT_MS ?? '5000',
    10,
  );
  const MCP_TOKEN = process.env.KUBECLAW_MCP_TOKEN;

  // Create a Pool; statement_timeout is set per-connection via a query on acquire.
  const pool = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  });

  function createMcpServer() {
    const mcp = new Server(
      { name: 'postgres-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'query',
          description:
            'Run a read-only SQL query against the Postgres database. ' +
            `Results are capped at ${MAX_ROWS} rows.`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              sql: { type: 'string', description: 'SQL statement to execute.' },
            },
            required: ['sql'],
          },
        },
      ],
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name !== 'query') {
        throw new Error(`unknown tool: ${req.params.name}`);
      }

      const sql = req.params.arguments?.sql as string | undefined;
      if (!sql || typeof sql !== 'string') {
        throw new Error('query tool requires a non-empty "sql" argument');
      }

      const client = await pool.connect();
      try {
        // Enforce read-only mode and statement timeout for this transaction.
        await client.query(
          `SET statement_timeout = ${STATEMENT_TIMEOUT}; SET default_transaction_read_only = on;`,
        );
        const result = await client.query(sql);
        const { rows, truncated } = capRows(result.rows, MAX_ROWS);
        const payload = JSON.stringify({ rows, truncated });
        return {
          content: [{ type: 'text', text: payload }],
        };
      } finally {
        // Reset settings so client returns to pool in a clean state.
        try {
          await client.query(
            'SET statement_timeout = 0; SET default_transaction_read_only = off;',
          );
        } catch {
          // If reset fails (e.g. connection broken) just release anyway.
        }
        client.release();
      }
    });

    return mcp;
  }

  const httpServer = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.url === '/mcp') {
      if (!isAuthorized(req.headers.authorization, MCP_TOKEN)) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      // Stateless: fresh Server + transport per request (avoids message-ID collisions).
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

  const port = parseInt(process.env.PORT ?? '3000', 10);
  httpServer.listen(port, () =>
    console.log(`postgres-mcp listening on ${port}`),
  );
}

// Auto-start when executed directly (not imported by tests).
// In ESM, import.meta.url is the canonical URL of this module.
// When run as `node server.js`, process.argv[1] resolves to the same path.
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
if (resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((err) => {
    console.error('Fatal error in postgres-mcp:', err);
    process.exit(1);
  });
}
