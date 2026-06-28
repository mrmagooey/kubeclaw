/**
 * Database MCP server: exposes a read-only `query` tool and a gated
 * `execute` tool over MCP, token-gated via Bearer auth on the /mcp endpoint.
 *
 * Read-only enforcement is ROLE-BASED: the `query` tool runs on a pool
 * authenticated as a Postgres role with SELECT-only grants (PG_RO_USER /
 * PG_RO_PASSWORD). The `execute` tool runs on a pool authenticated as the
 * read-write role (PGUSER / PGPASSWORD). SET default_transaction_read_only is
 * kept on the ro pool as defence-in-depth only.
 *
 * Pure helpers (capRows, isAuthorized, buildToolHandlers) are exported for
 * unit testing. The pg Pools and MCP wiring live inside start() and use
 * dynamic imports so the module can be loaded in tests without pg installed.
 */

// ─── Role bootstrap SQL (pure helper, no external deps) ──────────────────────

/** Regex that matches safe Postgres identifier characters. */
export const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Returns the idempotent SQL to grant a read-only Postgres role the minimum
 * permissions needed to SELECT from all current and future tables in the
 * `public` schema.
 *
 * The role name is validated against a strict safe-identifier regex because
 * it is interpolated directly into the SQL string (identifiers cannot be
 * parameterized). The role password is handled separately by `start()` via a
 * parameterized `ALTER ROLE ... PASSWORD $1` query — never string-interpolated.
 *
 * @throws if roUser contains characters outside `^[a-z_][a-z0-9_]*$`
 */
export function buildRoleBootstrapSql(roUser: string): string {
  if (!SAFE_IDENTIFIER_RE.test(roUser)) {
    throw new Error(
      `Unsafe Postgres role identifier: "${roUser}". ` +
        'Must match ^[a-z_][a-z0-9_]*$.',
    );
  }
  return [
    `GRANT CONNECT ON DATABASE kubeclaw TO ${roUser};`,
    `GRANT USAGE ON SCHEMA public TO ${roUser};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roUser};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${roUser};`,
  ].join('\n');
}

// ─── Pure helpers (unit-testable, no external deps) ──────────────────────────

export interface CapRowsResult {
  rows: unknown[];
  truncated: boolean;
}

/**
 * Limits rows to `max`. Returns the (possibly sliced) rows plus a flag
 * indicating whether the result was truncated.
 *
 * If `max` is not a positive finite number (≤ 0, NaN, Infinity) the rows are
 * returned as-is with truncated: false.
 */
export function capRows(rows: unknown[], max: number): CapRowsResult {
  if (!Number.isFinite(max) || max <= 0) {
    return { rows, truncated: false };
  }
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

// ─── Pool abstraction (narrow interface for testability) ──────────────────────

/**
 * Minimal interface that both a real pg.Pool and a test fake must satisfy.
 * We only need the ability to run a SQL string and get rows back.
 */
export interface QueryPool {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

// ─── Tool handler wiring (pure function, testable without pg) ─────────────────

export interface ToolHandlerInput {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolHandlerOutput {
  content: Array<{ type: string; text: string }>;
}

/**
 * Builds the MCP CallTool handler function given two pools and config.
 * This is a pure factory — no live pg or MCP SDK required.
 */
export function buildToolHandlers(opts: {
  roPool: QueryPool;
  rwPool: QueryPool;
  maxRows: number;
  statementTimeoutMs: number;
}): (req: ToolHandlerInput) => Promise<ToolHandlerOutput> {
  const { roPool, rwPool, maxRows, statementTimeoutMs } = opts;

  return async (req) => {
    const toolName = req.name;
    if (toolName !== 'query' && toolName !== 'execute') {
      throw new Error(`unknown tool: ${toolName}`);
    }

    const sql = req.arguments?.sql;
    if (!sql || typeof sql !== 'string') {
      throw new Error(`${toolName} tool requires a non-empty "sql" argument`);
    }

    const pool = toolName === 'query' ? roPool : rwPool;

    // Apply statement timeout as a session-level SET before each query.
    // For query (ro pool), also set default_transaction_read_only = on as
    // defence-in-depth (real enforcement is the DB role).
    const setupSql =
      toolName === 'query'
        ? `SET statement_timeout = ${statementTimeoutMs}; SET default_transaction_read_only = on;`
        : `SET statement_timeout = ${statementTimeoutMs};`;

    await pool.query(setupSql);
    const result = await pool.query(sql);
    const { rows, truncated } = capRows(result.rows, maxRows);
    const payload = JSON.stringify({ rows, truncated });
    return {
      content: [{ type: 'text', text: payload }],
    };
  };
}

// ─── Server wiring ────────────────────────────────────────────────────────────

export async function start(opts: { port: number }): Promise<void> {
  // ── Startup validation ────────────────────────────────────────────────────
  const MCP_TOKEN = process.env.KUBECLAW_MCP_TOKEN;
  if (!MCP_TOKEN) {
    console.error(
      'FATAL: KUBECLAW_MCP_TOKEN is unset or empty. ' +
        'The /mcp endpoint would permanently return 401. Refusing to start.',
    );
    process.exit(1);
  }

  const PG_RO_USER = process.env.PG_RO_USER;
  const PG_RO_PASSWORD = process.env.PG_RO_PASSWORD;
  if (!PG_RO_USER || !PG_RO_PASSWORD) {
    console.error(
      'FATAL: PG_RO_USER and/or PG_RO_PASSWORD are unset or empty. ' +
        'Cannot start read-only pool without read-only credentials.',
    );
    process.exit(1);
  }

  // Validate PG_RO_USER BEFORE any interpolation into SQL.
  // Identifiers cannot be parameterized in Postgres, so we enforce a strict
  // safe-identifier regex here. The same check runs inside buildRoleBootstrapSql
  // but we must guard here too, BEFORE the DO block interpolation below.
  if (!SAFE_IDENTIFIER_RE.test(PG_RO_USER)) {
    console.error(
      `FATAL: PG_RO_USER "${PG_RO_USER}" contains unsafe characters. ` +
        'Must match ^[a-z_][a-z0-9_]*$. Refusing to start.',
    );
    process.exit(1);
  }

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

  const pgHost = process.env.PGHOST;
  const pgPort = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined;
  const pgDatabase = process.env.PGDATABASE;

  // READ-ONLY pool: connected as the ro role (SELECT-only grants in Postgres).
  const roPool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: PG_RO_USER,
    password: PG_RO_PASSWORD,
    database: pgDatabase,
  });

  // READ-WRITE pool: connected as the rw role.
  const rwPool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: pgDatabase,
  });

  // ── Read-only role bootstrap ───────────────────────────────────────────────
  // Wait until Postgres is reachable (retry with back-off), then:
  //   1. CREATE the ro role guarded by a DO block (roles lack IF NOT EXISTS).
  //   2. ALTER ROLE ... PASSWORD $1 (PARAMETERIZED — never string-interpolated).
  //   3. Grant read-only permissions via buildRoleBootstrapSql.
  // This runs BEFORE the HTTP server starts serving.
  {
    const BOOTSTRAP_RETRIES = 30;
    const BOOTSTRAP_RETRY_DELAY_MS = 2000;
    let connected = false;
    for (let i = 0; i < BOOTSTRAP_RETRIES; i++) {
      try {
        await rwPool.query('SELECT 1');
        connected = true;
        break;
      } catch {
        if (i < BOOTSTRAP_RETRIES - 1) {
          console.log(
            `postgres-mcp: waiting for Postgres (attempt ${i + 1}/${BOOTSTRAP_RETRIES})…`,
          );
          await new Promise((r) => setTimeout(r, BOOTSTRAP_RETRY_DELAY_MS));
        }
      }
    }
    if (!connected) {
      console.error('FATAL: Postgres not reachable after retries. Exiting.');
      process.exit(1);
    }

    try {
      // Step 1: Create the ro role if it does not exist.
      // Roles have no IF NOT EXISTS, so we guard with a DO block.
      // PG_RO_USER was validated against ^[a-z_][a-z0-9_]*$ above (exits non-zero
      // if invalid), so interpolation here is safe. We additionally use
      // format('%I', ...) inside PL/pgSQL so the DO block itself uses
      // quote_ident semantics, providing defence-in-depth.
      await rwPool.query(`
        DO $$
        DECLARE
          _role text := ${`'${PG_RO_USER}'`};
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = _role) THEN
            EXECUTE format('CREATE ROLE %I LOGIN', _role);
          END IF;
        END
        $$;
      `);

      // Step 2: Set the password via a PARAMETERIZED query — the password
      // is never interpolated into SQL to prevent injection.
      // PG_RO_USER is regex-validated above; the ALTER ROLE identifier is safe.
      await rwPool.query(`ALTER ROLE "${PG_RO_USER}" PASSWORD $1`, [
        PG_RO_PASSWORD,
      ]);

      // Step 3: Grant read-only permissions.
      const grantSql = buildRoleBootstrapSql(PG_RO_USER);
      for (const stmt of grantSql.split('\n').filter((s) => s.trim())) {
        await rwPool.query(stmt);
      }

      console.log(
        `postgres-mcp: ro role "${PG_RO_USER}" bootstrapped successfully.`,
      );
    } catch (err) {
      console.error('FATAL: ro role bootstrap failed:', err);
      process.exit(1);
    }
  }

  const handleTool = buildToolHandlers({
    roPool,
    rwPool,
    maxRows: MAX_ROWS,
    statementTimeoutMs: STATEMENT_TIMEOUT,
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
            'Run a read-only SQL SELECT against the Postgres database. ' +
            `Results are capped at ${MAX_ROWS} rows. ` +
            'Executed by a SELECT-only Postgres role — write operations are rejected at the DB level.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              sql: { type: 'string', description: 'SQL SELECT statement to execute.' },
            },
            required: ['sql'],
          },
        },
        {
          name: 'execute',
          description:
            'Run a read-write SQL statement (INSERT, UPDATE, DELETE, DDL) against the Postgres database. ' +
            `Results are capped at ${MAX_ROWS} rows. ` +
            'Executed by the read-write Postgres role. Availability is controlled by the capability allowedTools list.',
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
      return handleTool({
        name: req.params.name,
        arguments: req.params.arguments as Record<string, unknown> | undefined,
      });
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

  httpServer.listen(opts.port, () =>
    console.log(`postgres-mcp listening on ${opts.port}`),
  );
}
