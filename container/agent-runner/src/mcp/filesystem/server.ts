import fs from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveSafePath } from './paths.js';

/**
 * Read the file-size cap on each call (not at module load) so tests can
 * stub it via process.env without restarting the module.
 */
function maxFileBytes(): number {
  return Number(process.env.KUBECLAW_FS_MAX_FILE_BYTES) || 100 * 1024 * 1024;
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file under /data. Returns UTF-8 text. Rejects files larger than the configured limit (default 100 MiB).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to /data' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file under /data (overwriting). Creates parent directories as needed. Rejects content larger than the configured limit (default 100 MiB).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to /data' },
        content: { type: 'string', description: 'File content (UTF-8)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List the entries in a directory. Returns an array of {name, type, size?}.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to /data' } },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description:
      'Find files matching a glob pattern under a directory. Returns paths relative to the search root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search, relative to /data' },
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.md"' },
      },
      required: ['path', 'pattern'],
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory (recursive; idempotent).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to /data' } },
      required: ['path'],
    },
  },
];

function createMcpServer(root: string): Server {
  const mcp = new Server(
    { name: 'kubeclaw-filesystem', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'read_file': {
          const full = resolveSafePath(root, args['path'] as string);
          const stat = await fs.promises.stat(full);
          if (!stat.isFile()) return errorResult(`not a file: ${args['path']}`);
          const cap = maxFileBytes();
          if (stat.size > cap) {
            return errorResult(
              `file too large (${stat.size} bytes > ${cap} byte limit)`,
            );
          }
          const content = await fs.promises.readFile(full, 'utf8');
          return textResult(content);
        }
        case 'write_file': {
          const content = String(args['content'] ?? '');
          const bytes = Buffer.byteLength(content, 'utf8');
          const cap = maxFileBytes();
          if (bytes > cap) {
            return errorResult(
              `content too large (${bytes} bytes > ${cap} byte limit)`,
            );
          }
          const full = resolveSafePath(root, args['path'] as string);
          await fs.promises.mkdir(path.dirname(full), { recursive: true });
          await fs.promises.writeFile(full, content, 'utf8');
          return textResult(`wrote ${bytes} bytes to ${args['path']}`);
        }
        case 'list_directory': {
          const full = resolveSafePath(root, args['path'] as string);
          const entries = await fs.promises.readdir(full, { withFileTypes: true });
          const out = await Promise.all(
            entries.map(async (e) => {
              const item: { name: string; type: string; size?: number } = {
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
              };
              if (!e.isDirectory()) {
                try {
                  const s = await fs.promises.stat(path.join(full, e.name));
                  item.size = s.size;
                } catch {
                  /* ignore stat failures (e.g. broken symlink) */
                }
              }
              return item;
            }),
          );
          return textResult(JSON.stringify(out));
        }
        case 'search_files': {
          const full = resolveSafePath(root, args['path'] as string);
          const matches = await searchGlob(full, args['pattern'] as string, root);
          return textResult(JSON.stringify(matches));
        }
        case 'create_directory': {
          const full = resolveSafePath(root, args['path'] as string);
          await fs.promises.mkdir(full, { recursive: true });
          return textResult(`created ${args['path']}`);
        }
        default:
          return errorResult(`unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  return mcp;
}

/**
 * Glob walker — hand-rolled minimal implementation that supports
 * `*`, `**`, and `?` against POSIX paths. Output paths are relative to
 * `capabilityRoot`.
 */
async function searchGlob(searchRoot: string, pattern: string, capabilityRoot: string): Promise<string[]> {
  const matches: string[] = [];
  await walk(searchRoot, '', (relPath) => {
    if (matchesGlob(relPath, pattern)) {
      const absolute = path.join(searchRoot, relPath);
      matches.push(path.relative(capabilityRoot, absolute));
    }
  });
  return matches;
}

async function walk(dir: string, prefix: string, visit: (rel: string) => void): Promise<void> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(path.join(dir, e.name), rel, visit);
    } else {
      visit(rel);
    }
  }
}

function matchesGlob(p: string, pattern: string): boolean {
  // Convert glob to regex: ** → .*, * → [^/]*, ? → [^/]
  const re =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__DOUBLESTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLESTAR__/g, '.*')
      .replace(/\?/g, '[^/]') +
    '$';
  return new RegExp(re).test(p);
}

/**
 * Start the filesystem MCP server listening on `port`, serving files
 * under `root`. Per-request transport+server factory pattern (matches the
 * echo-mcp container; required by MCP SDK >=1.10 stateless mode).
 *
 * Returns the underlying http.Server so callers (e.g. tests) can close it.
 */
export async function startFilesystemServer(opts: { root: string; port: number }): Promise<HttpServer> {
  const { root, port } = opts;
  await fs.promises.mkdir(root, { recursive: true });

  const httpServer = createHttpServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.url === '/mcp') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcp = createMcpServer(root);
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      await mcp.close();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`kubeclaw-filesystem listening on ${port}, root=${root}`);
      resolve(httpServer);
    });
  });
}

/**
 * Dispatcher-facing entrypoint. Boots the HTTP server and resolves when
 * the server is listening. Does not return the server handle — the process
 * is expected to run indefinitely.
 */
export async function start(opts: { root: string; port: number }): Promise<void> {
  await startFilesystemServer(opts);
}
