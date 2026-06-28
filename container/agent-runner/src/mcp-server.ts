/**
 * KubeClaw MCP Server dispatcher entrypoint.
 *
 * Usage:
 *   node dist/mcp-server.js --server filesystem [--root /data] [--port 3000]
 *   node dist/mcp-server.js --server database [--port 3000]
 *
 * Dispatches to the appropriate MCP capability server based on --server.
 * Exits with code 2 on missing or unknown --server.
 */

import { parseArgs as nodeParseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Pure argument parser — exported so tests can exercise it without running main().
 *
 * @param argv - argument list (e.g. process.argv.slice(2))
 * @returns parsed options with defaults applied
 * @throws Error when --server is missing or empty
 */
export function parseArgs(argv: string[]): {
  server: string;
  root: string;
  port: number;
} {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      server: { type: 'string' as const },
      root: { type: 'string' as const },
      port: { type: 'string' as const },
    },
  });

  if (!values.server) {
    throw new Error('--server <name> is required');
  }

  return {
    server: values.server,
    root: values.root ?? '/data',
    port: Number(values.port ?? 3000),
  };
}

/**
 * Parse args, writing an error to stderr and exiting with code 2 on failure.
 * Typed to return the parsed result (never undefined) because the only other
 * path is process.exit() which returns `never`.
 */
function parseArgsOrExit(argv: string[]): {
  server: string;
  root: string;
  port: number;
} {
  try {
    return parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  }
}

/**
 * Dispatch to the selected MCP capability server.
 *
 * @param argv - argument list (defaults to process.argv.slice(2))
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { server, root, port } = parseArgsOrExit(argv);

  switch (server) {
    case 'filesystem':
      await import('./mcp/filesystem/server.js').then((m) =>
        m.start({ root, port }),
      );
      break;
    case 'database':
      await import('./mcp/database/server.js').then((m) => m.start({ port }));
      break;
    default:
      process.stderr.write(
        `error: unknown --server "${server}". Valid servers: filesystem, database\n`,
      );
      process.exit(2);
  }
}

// Entrypoint guard: only invoke main() when this file is the entry script,
// not when it is imported by a test or another module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    process.exit(1);
  });
}
