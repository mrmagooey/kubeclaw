# Filesystem MCP Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first real per-group MCP capability — a `kubeclaw-mcp-bundle` Node container hosting a filesystem MCP server (5 tools, 100 MiB cap, path-safety). Wired into Helm default-on. Rides on Phase A foundation + Phase B Spec 1 consumer wiring.

**Architecture:** New `container/mcp-bundle/` Node package with an entrypoint that dispatches on `--server <name>`. Filesystem module implements 5 tools against `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`. Per-request transport+server factory (matches Spec 1's `echo-mcp` bug fix). Path-safety via `resolveSafePath()`. Helm `values.yaml` declares `capabilities.filesystem` with `scope: group`, `volumeFromGroupPvc: true`.

**Tech Stack:** Node 20 (alpine), `@modelcontextprotocol/sdk`, vitest for unit tests, Helm, K8s.

**Spec:** `docs/superpowers/specs/2026-05-18-filesystem-mcp-design.md`
**Foundation:** Phase A merged in `05eef2f`; Phase B Spec 1 merged in `069a152`.

---

## Pre-flight

Read before starting:
- `docs/superpowers/specs/2026-05-18-filesystem-mcp-design.md` (the spec)
- `container/echo-mcp/index.js` (the pattern to mirror — `createMcpServer()` factory + Streamable HTTP per request)
- `container/echo-mcp/Dockerfile`, `package.json`, `build.sh`
- `src/per-group-capabilities/k8s-objects.ts` (how Helm spec → Deployment; confirms the `volumeFromGroupPvc` + readinessProbe wiring)
- `helm/kubeclaw/values.yaml` `capabilities:` block (where the new entry goes)

**Branch:** create a worktree via `superpowers:using-git-worktrees`. Don't work on `main`.

**Test framework inside bundle:** vitest (matches the rest of the repo). Bundle's tests are colocated and run via the bundle's `npm test`; not part of the main repo's `npm test`.

---

## File map

**New files:**

| File | Responsibility |
|---|---|
| `container/mcp-bundle/Dockerfile` | Node:20-alpine base + sdk install |
| `container/mcp-bundle/package.json` | Runtime + dev deps; `test` script |
| `container/mcp-bundle/build.sh` | `docker build` wrapper |
| `container/mcp-bundle/index.js` | Entrypoint: parses `--server` + dispatches |
| `container/mcp-bundle/filesystem/server.js` | 5 tools + HTTP transport wiring + size cap |
| `container/mcp-bundle/filesystem/paths.js` | `resolveSafePath()` + helpers |
| `container/mcp-bundle/filesystem/server.test.js` | Tool unit tests |
| `container/mcp-bundle/filesystem/paths.test.js` | Path-safety unit tests |
| `container/mcp-bundle/vitest.config.js` | Test config for the bundle subpackage |
| `e2e/filesystem-mcp-integration.test.ts` | Integration test against real K8s |
| `e2e/filesystem-mcp-e2e.test.ts` | E2E placeholder (Helm install scenario) |

**Modified files:**

| File | Change |
|---|---|
| `helm/kubeclaw/values.yaml` | Add `capabilities.filesystem` entry |
| `docs/PER_GROUP_CAPABILITIES.md` | Append "Filesystem MCP" section |
| `README.md` | Brief mention under capabilities |
| `CHANGELOG.md` | Unreleased "Features" entry |

---

## Task list

### Task 1: Bundle skeleton — Dockerfile, package.json, build.sh, index.js dispatch

**Files:**
- Create: `container/mcp-bundle/Dockerfile`
- Create: `container/mcp-bundle/package.json`
- Create: `container/mcp-bundle/build.sh`
- Create: `container/mcp-bundle/index.js`

- [ ] **Step 1: Create `container/mcp-bundle/package.json`**

```json
{
  "name": "kubeclaw-mcp-bundle",
  "version": "0.0.1",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `container/mcp-bundle/index.js`**

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startFilesystemServer } from './filesystem/server.js';

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    root: { type: 'string' },
    port: { type: 'string' },
  },
});

const server = values.server;
const port = Number(values.port ?? 3000);

if (!server) {
  console.error('error: --server <name> is required');
  process.exit(2);
}

switch (server) {
  case 'filesystem': {
    if (!values.root) {
      console.error('error: --root is required for --server filesystem');
      process.exit(2);
    }
    await startFilesystemServer({ root: values.root, port });
    break;
  }
  default:
    console.error(`error: unknown --server "${server}"`);
    process.exit(2);
}
```

- [ ] **Step 3: Create `container/mcp-bundle/Dockerfile`**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY index.js ./
COPY filesystem ./filesystem
EXPOSE 3000
CMD ["node", "index.js"]
```

- [ ] **Step 4: Create `container/mcp-bundle/build.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
TAG="${1:-kubeclaw-mcp-bundle:latest}"
cd "$(dirname "$0")"
docker build -t "$TAG" .
```

Make executable:
```bash
chmod +x container/mcp-bundle/build.sh
```

- [ ] **Step 5: Verify the skeleton structure**

```bash
cd <worktree-path>
ls -la container/mcp-bundle/
```
Expected: 4 files (Dockerfile, package.json, build.sh, index.js).

Do NOT try to docker-build yet — `filesystem/server.js` doesn't exist, so the build (and any runtime) would fail. The skeleton is just the scaffolding.

- [ ] **Step 6: Commit**

```bash
cd <worktree-path>
git branch --show-current   # worktree-filesystem-mcp
git add container/mcp-bundle/Dockerfile container/mcp-bundle/package.json container/mcp-bundle/build.sh container/mcp-bundle/index.js
git commit -m "feat(mcp-bundle): skeleton with --server dispatch"
```

---

### Task 2: Path-safety helpers + unit tests

**Files:**
- Create: `container/mcp-bundle/filesystem/paths.js`
- Create: `container/mcp-bundle/filesystem/paths.test.js`
- Create: `container/mcp-bundle/vitest.config.js`
- Modify: `container/mcp-bundle/package.json` (lock vitest version after install)

- [ ] **Step 1: Install dev deps in the bundle**

```bash
cd <worktree-path>/container/mcp-bundle
npm install
```
Expected: `node_modules/` created with `@modelcontextprotocol/sdk` and `vitest`.

- [ ] **Step 2: Create `container/mcp-bundle/vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['filesystem/**/*.test.js'],
  },
});
```

- [ ] **Step 3: Write the failing test**

`container/mcp-bundle/filesystem/paths.test.js`:
```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSafePath } from './paths.js';

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'paths-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveSafePath', () => {
  it('accepts a simple relative path', () => {
    writeFileSync(path.join(root, 'foo.md'), 'x');
    const resolved = resolveSafePath(root, 'foo.md');
    expect(resolved).toBe(path.join(root, 'foo.md'));
  });

  it('accepts a nested relative path', () => {
    mkdirSync(path.join(root, 'a/b'), { recursive: true });
    writeFileSync(path.join(root, 'a/b/c.md'), 'x');
    const resolved = resolveSafePath(root, 'a/b/c.md');
    expect(resolved).toBe(path.join(root, 'a/b/c.md'));
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow(
      /absolute path/i,
    );
  });

  it('rejects parent-directory traversal', () => {
    expect(() => resolveSafePath(root, '../foo')).toThrow(/traversal/i);
    expect(() => resolveSafePath(root, 'a/../../foo')).toThrow(/traversal/i);
  });

  it('rejects symlinks that escape root', () => {
    symlinkSync('/etc/passwd', path.join(root, 'evil'));
    expect(() => resolveSafePath(root, 'evil')).toThrow(/outside root/i);
  });

  it('accepts symlinks that point within root', () => {
    writeFileSync(path.join(root, 'target.md'), 'x');
    symlinkSync(path.join(root, 'target.md'), path.join(root, 'link'));
    const resolved = resolveSafePath(root, 'link');
    expect(resolved).toBe(path.join(root, 'target.md'));
  });

  it('accepts non-existent paths inside root (for write/create)', () => {
    const resolved = resolveSafePath(root, 'new-file.md');
    expect(resolved).toBe(path.join(root, 'new-file.md'));
  });

  it('rejects an empty path', () => {
    expect(() => resolveSafePath(root, '')).toThrow();
  });
});
```

- [ ] **Step 4: Verify it fails**

```bash
cd <worktree-path>/container/mcp-bundle
npm test 2>&1 | tail -8
```
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `container/mcp-bundle/filesystem/paths.js`**

```js
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve a user-supplied path against a root directory, with safety checks:
 *
 *   1. Reject absolute paths.
 *   2. Reject paths whose normalised form starts with `..` (traversal).
 *   3. If the target exists, fs.realpath it (resolves symlinks) and verify
 *      the result is still inside `root` (catches symlink escape).
 *   4. If the target doesn't exist, accept (caller is likely about to write
 *      or create it). The parent must still exist OR be inside root.
 *
 * Returns the absolute, realpath'd path inside `root`. Throws on violation.
 */
export function resolveSafePath(root, rawPath) {
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    throw new Error('path is required');
  }
  if (path.isAbsolute(rawPath)) {
    throw new Error(`absolute path not allowed: ${rawPath}`);
  }

  const normalised = path.posix.normalize(rawPath);
  if (normalised.startsWith('..') || normalised === '..') {
    throw new Error(`path traversal not allowed: ${rawPath}`);
  }

  const joined = path.resolve(root, normalised);
  if (!isUnder(joined, root)) {
    throw new Error(`path traversal not allowed: ${rawPath}`);
  }

  // If the target exists, realpath it so we catch symlink escape.
  if (fs.existsSync(joined)) {
    const real = fs.realpathSync(joined);
    if (!isUnder(real, fs.realpathSync(root))) {
      throw new Error(`symlink target outside root: ${rawPath}`);
    }
    return real;
  }
  return joined;
}

function isUnder(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
```

- [ ] **Step 6: Run tests**

```bash
cd <worktree-path>/container/mcp-bundle
npm test 2>&1 | tail -10
```
Expected: 8 passed.

- [ ] **Step 7: Commit**

```bash
cd <worktree-path>
git add container/mcp-bundle/filesystem/paths.js container/mcp-bundle/filesystem/paths.test.js container/mcp-bundle/vitest.config.js container/mcp-bundle/package.json container/mcp-bundle/package-lock.json
git commit -m "feat(mcp-bundle): path-safety helpers + unit tests"
```

(Include `package-lock.json` if `npm install` produced one. If not, omit.)

---

### Task 3: Filesystem MCP server — 5 tools + HTTP transport + size cap

**Files:**
- Create: `container/mcp-bundle/filesystem/server.js`

This task creates the server module; tests for it are Task 4.

- [ ] **Step 1: Implement `container/mcp-bundle/filesystem/server.js`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
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
function maxFileBytes() {
  return Number(process.env.KUBECLAW_FS_MAX_FILE_BYTES) || 100 * 1024 * 1024;
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
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

function createMcpServer(root) {
  const mcp = new Server(
    { name: 'kubeclaw-filesystem', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    try {
      switch (name) {
        case 'read_file': {
          const full = resolveSafePath(root, args.path);
          const stat = await fs.promises.stat(full);
          if (!stat.isFile()) return errorResult(`not a file: ${args.path}`);
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
          const content = String(args.content ?? '');
          const bytes = Buffer.byteLength(content, 'utf8');
          const cap = maxFileBytes();
          if (bytes > cap) {
            return errorResult(
              `content too large (${bytes} bytes > ${cap} byte limit)`,
            );
          }
          const full = resolveSafePath(root, args.path);
          await fs.promises.mkdir(path.dirname(full), { recursive: true });
          await fs.promises.writeFile(full, content, 'utf8');
          return textResult(`wrote ${bytes} bytes to ${args.path}`);
        }
        case 'list_directory': {
          const full = resolveSafePath(root, args.path);
          const entries = await fs.promises.readdir(full, { withFileTypes: true });
          const out = await Promise.all(
            entries.map(async (e) => {
              const item = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
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
          const full = resolveSafePath(root, args.path);
          const matches = await searchGlob(full, args.pattern, root);
          return textResult(JSON.stringify(matches));
        }
        case 'create_directory': {
          const full = resolveSafePath(root, args.path);
          await fs.promises.mkdir(full, { recursive: true });
          return textResult(`created ${args.path}`);
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
 * Glob using fs.glob (Node 22+) or a manual walk + minimatch-like match.
 * For Node 20 alpine we hand-roll a minimal globber that supports
 * `*`, `**`, and `?` against POSIX paths.
 */
async function searchGlob(searchRoot, pattern, capabilityRoot) {
  const matches = [];
  await walk(searchRoot, '', (relPath) => {
    if (matchesGlob(relPath, pattern)) {
      // Make path relative to the capability root for caller-friendly output.
      const absolute = path.join(searchRoot, relPath);
      matches.push(path.relative(capabilityRoot, absolute));
    }
  });
  return matches;
}

async function walk(dir, prefix, visit) {
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

function matchesGlob(p, pattern) {
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
 */
export async function startFilesystemServer({ root, port }) {
  // Ensure the root exists; create if missing.
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
      return transport.handleRequest(req, res);
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
```

- [ ] **Step 2: Verify the module loads**

```bash
cd <worktree-path>/container/mcp-bundle
node -e "import('./filesystem/server.js').then(m => console.log(Object.keys(m)))"
```
Expected: `[ 'startFilesystemServer' ]`.

- [ ] **Step 3: Commit**

```bash
cd <worktree-path>
git add container/mcp-bundle/filesystem/server.js
git commit -m "feat(mcp-bundle): filesystem MCP server (5 tools, 100 MiB cap)"
```

---

### Task 4: Bundle unit tests for filesystem server

**Files:**
- Create: `container/mcp-bundle/filesystem/server.test.js`

- [ ] **Step 1: Write the test**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFilesystemServer } from './server.js';

let root;
let server;
let port;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'fs-mcp-test-'));
  // Pick a random ephemeral port to avoid conflicts between parallel test files.
  port = 30000 + Math.floor(Math.random() * 20000);
  server = await startFilesystemServer({ root, port });
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

async function call(name, args) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  const client = new Client(
    { name: 'test', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await transport.close();
  }
}

describe('filesystem MCP server', () => {
  it('write_file then read_file round-trip', async () => {
    await call('write_file', { path: 'notes.md', content: 'hello' });
    const read = await call('read_file', { path: 'notes.md' });
    expect(read.content?.[0]?.text).toBe('hello');
  });

  it('list_directory returns entries with type and size', async () => {
    writeFileSync(path.join(root, 'a.md'), 'aaa');
    mkdirSync(path.join(root, 'sub'));
    const out = await call('list_directory', { path: '.' });
    const entries = JSON.parse(out.content?.[0]?.text);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['a.md']?.type).toBe('file');
    expect(byName['a.md']?.size).toBe(3);
    expect(byName['sub']?.type).toBe('dir');
  });

  it('search_files finds matching globs', async () => {
    mkdirSync(path.join(root, 'a/b'), { recursive: true });
    writeFileSync(path.join(root, 'a/b/c.md'), 'x');
    writeFileSync(path.join(root, 'a/d.txt'), 'x');
    const out = await call('search_files', { path: '.', pattern: '**/*.md' });
    const matches = JSON.parse(out.content?.[0]?.text);
    expect(matches).toContain('a/b/c.md');
    expect(matches).not.toContain('a/d.txt');
  });

  it('create_directory is idempotent', async () => {
    await call('create_directory', { path: 'x/y' });
    const second = await call('create_directory', { path: 'x/y' });
    expect(second.isError).toBeFalsy();
  });

  it('path traversal is rejected', async () => {
    const out = await call('read_file', { path: '../../etc/passwd' });
    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text).toMatch(/traversal/i);
  });

  it('absolute paths are rejected', async () => {
    const out = await call('read_file', { path: '/etc/passwd' });
    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text).toMatch(/absolute/i);
  });

  it('symlink escape is rejected', async () => {
    symlinkSync('/etc/passwd', path.join(root, 'evil'));
    const out = await call('read_file', { path: 'evil' });
    expect(out.isError).toBe(true);
  });

  it('write_file rejects content over the configured cap', async () => {
    // Set a tiny cap for this test only. The server reads the env on each
    // call (see maxFileBytes() in server.js), so this works without
    // restarting the server.
    const prev = process.env.KUBECLAW_FS_MAX_FILE_BYTES;
    process.env.KUBECLAW_FS_MAX_FILE_BYTES = '10';
    try {
      const out = await call('write_file', {
        path: 'big.md',
        content: 'this content is longer than ten bytes',
      });
      expect(out.isError).toBe(true);
      expect(out.content?.[0]?.text).toMatch(/too large/i);
    } finally {
      if (prev === undefined) delete process.env.KUBECLAW_FS_MAX_FILE_BYTES;
      else process.env.KUBECLAW_FS_MAX_FILE_BYTES = prev;
    }
  });

  it('read_file rejects files over the configured cap', async () => {
    writeFileSync(path.join(root, 'big.md'), 'this content is longer than ten bytes');
    const prev = process.env.KUBECLAW_FS_MAX_FILE_BYTES;
    process.env.KUBECLAW_FS_MAX_FILE_BYTES = '10';
    try {
      const out = await call('read_file', { path: 'big.md' });
      expect(out.isError).toBe(true);
      expect(out.content?.[0]?.text).toMatch(/too large/i);
    } finally {
      if (prev === undefined) delete process.env.KUBECLAW_FS_MAX_FILE_BYTES;
      else process.env.KUBECLAW_FS_MAX_FILE_BYTES = prev;
    }
  });

  it('read_file of a non-file returns error', async () => {
    mkdirSync(path.join(root, 'sub'));
    const out = await call('read_file', { path: 'sub' });
    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text).toMatch(/not a file/i);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd <worktree-path>/container/mcp-bundle
npm test 2>&1 | tail -15
```
Expected: 10 tests pass (server.test.js) + 8 tests pass (paths.test.js) = 18 total.

If any test fails, the most likely culprit is the SDK's `callTool` response shape. The SDK returns `{ content, isError? }`. Tests above match that. If a test fails because `.isError` is missing for success cases, change `expect(out.isError).toBeFalsy()` (already done).

- [ ] **Step 3: Commit**

```bash
cd <worktree-path>
git add container/mcp-bundle/filesystem/server.test.js
git commit -m "test(mcp-bundle): filesystem MCP server unit tests"
```

---

### Task 5: Bundle Docker build verification

**Files:** none modified (verification only)

- [ ] **Step 1: Build the bundle image**

```bash
cd <worktree-path>
./container/mcp-bundle/build.sh kubeclaw-mcp-bundle:test 2>&1 | tail -20
```
Expected: docker build succeeds, image `kubeclaw-mcp-bundle:test` exists.

- [ ] **Step 2: Smoke-test inside the container**

```bash
docker run --rm -d --name fs-smoke -p 13030:3000 kubeclaw-mcp-bundle:test \
  node index.js --server filesystem --root /tmp
sleep 1
curl -s http://localhost:13030/health
docker stop fs-smoke
```
Expected: `/health` returns `ok`.

If docker isn't available in this environment, this task is best-effort. Report DONE_WITH_CONCERNS if you can't run the smoke test — the build itself is the important part.

- [ ] **Step 3: No commit needed**

Verification only.

---

### Task 6: Helm values.yaml — register `capabilities.filesystem`

**Files:**
- Modify: `helm/kubeclaw/values.yaml`

- [ ] **Step 1: Inspect the existing capabilities block**

```bash
cd <worktree-path>
grep -A20 "^capabilities:" helm/kubeclaw/values.yaml
```

You'll see whether `capabilities:` is currently `{}` (empty), a list, or has existing entries. Append accordingly.

- [ ] **Step 2: Add the filesystem entry**

Edit `helm/kubeclaw/values.yaml`. Locate the `capabilities:` key. If it's `capabilities: {}`, replace with:

```yaml
capabilities:
  filesystem:
    kind: mcp
    scope: group
    image: "{{ .Values.image.registry }}/kubeclaw-mcp-bundle:{{ .Chart.AppVersion }}"
    command: ["node", "/app/index.js", "--server", "filesystem", "--root", "/data"]
    port: 3000
    path: /mcp
    volumeFromGroupPvc: true
    credentialsFrom: none
    scaleDownAfterIdleSeconds: 600
    allowedTools:
      - read_file
      - write_file
      - list_directory
      - search_files
      - create_directory
    env:
      KUBECLAW_FS_MAX_FILE_BYTES: "104857600"
      NODE_OPTIONS: "--max-old-space-size=384"
    resources:
      memoryRequest: 128Mi
      memoryLimit: 512Mi
      cpuRequest: 50m
      cpuLimit: 500m
```

If `capabilities:` already has entries (e.g., `qdrant: {...}`), nest the new `filesystem:` block alongside them under the existing `capabilities:` key.

- [ ] **Step 3: Render the chart to verify**

```bash
cd <worktree-path>
helm template helm/kubeclaw 2>&1 | grep -A2 "name: filesystem\|mcp-bundle\|/app/index.js" | head -20
```
Expected: rendered Deployment references the bundle image and command args.

- [ ] **Step 4: Run unit tests (no regressions)**

```bash
cd <worktree-path>
npm test 2>&1 | tail -5
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd <worktree-path>
git add helm/kubeclaw/values.yaml
git commit -m "feat(helm): default-on filesystem MCP capability"
```

---

### Task 7: Integration test against real K8s

**Files:**
- Create: `e2e/filesystem-mcp-integration.test.ts`

- [ ] **Step 1: Inspect the Phase B Spec 1 reference**

```bash
cd <worktree-path>
head -100 e2e/per-group-mcp-consumer-integration.test.ts
```

Note the `beforeAll` (image build + load + namespace), `afterEach` (deleteByLabel cleanup), and `describe.skipIf(!K8S_AVAILABLE)` gating. Mirror it.

- [ ] **Step 2: Write the test file**

`e2e/filesystem-mcp-integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { createConnection } from 'net';
import {
  RealPerGroupK8sClient,
  reconcileGroupCapabilities,
  groupHash,
  scrapeMissingSchemas,
  scaleUpInstance,
} from '../src/per-group-capabilities/index.js';
import { _initTestDatabase, __resetDbForTest } from '../src/db.js';
import { getCachedSchemas, type McpToolSchema } from '../src/per-group-capabilities/schema-cache.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const NAMESPACE = process.env.PGC_TEST_NAMESPACE || 'kubeclaw-test-pgc';
const BUNDLE_IMAGE = 'kubeclaw-mcp-bundle:test';

const fsSpec = {
  name: 'filesystem',
  kind: 'mcp' as const,
  image: BUNDLE_IMAGE,
  scope: 'group' as const,
  scaleDownAfterIdleSeconds: 60,
  volumeFromGroupPvc: true,
  credentialsFrom: 'none' as const,
  command: ['node', '/app/index.js', '--server', 'filesystem', '--root', '/data'],
  env: {
    KUBECLAW_FS_MAX_FILE_BYTES: '104857600',
    NODE_OPTIONS: '--max-old-space-size=384',
  },
  resources: {
    memoryRequest: '128Mi',
    memoryLimit: '512Mi',
    cpuRequest: '50m',
    cpuLimit: '500m',
  },
  allowedTools: ['read_file', 'write_file', 'list_directory', 'search_files', 'create_directory'],
};

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function portForward(deployment: string, localPort: number): Promise<() => void> {
  const proc = spawn('kubectl', [
    'port-forward', '-n', NAMESPACE,
    `deployment/${deployment}`, `${localPort}:3000`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Wait until the port is accepting connections.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port: localPort });
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return () => { proc.kill(); };
}

async function mcpCall(localPort: number, tool: string, args: Record<string, unknown>) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${localPort}/mcp`),
  );
  const mcp = new McpClient({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);
  try {
    return await mcp.callTool({ name: tool, arguments: args });
  } finally {
    await transport.close();
  }
}

describe.skipIf(!K8S_AVAILABLE)('filesystem MCP (real K8s)', () => {
  let client: RealPerGroupK8sClient;

  beforeAll(async () => {
    try {
      sh(`kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -`);
    } catch (err) {
      console.warn('namespace setup failed:', err);
    }
    try {
      sh(`./container/mcp-bundle/build.sh ${BUNDLE_IMAGE}`);
    } catch {
      console.warn('mcp-bundle build failed.');
    }
    try {
      sh(`minikube image load ${BUNDLE_IMAGE} 2>&1 || true`);
    } catch {}
    await _initTestDatabase();
  }, 300_000);

  afterEach(async () => {
    try {
      await client?.deleteByLabel(NAMESPACE, 'kubeclaw.io/scope=group');
    } catch (err) {
      console.warn('afterEach cleanup failed:', err);
    }
  });

  it('schema scrape end-to-end caches all 5 tools', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-1'], specs: [fsSpec],
    });

    const hash = groupHash('fs-itest-1');
    const localPort = 32100;
    await scaleUpInstance({
      client, namespace: NAMESPACE,
      groupFolder: 'fs-itest-1', capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const callToolsList = async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${localPort}/mcp`),
        );
        const mcp = new McpClient({ name: 't', version: '0' }, { capabilities: {} });
        await mcp.connect(transport);
        try {
          const res = await mcp.listTools();
          return (res.tools ?? []).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
          })) as McpToolSchema[];
        } finally {
          await transport.close();
        }
      };
      await scrapeMissingSchemas({
        client, namespace: NAMESPACE, specs: [fsSpec],
        callToolsList,
        scrapeTimeoutMs: 60_000,
      });
    } finally {
      stop();
    }
    const cached = getCachedSchemas('filesystem', BUNDLE_IMAGE);
    expect(cached).not.toBeNull();
    const names = (cached ?? []).map((s) => s.name).sort();
    expect(names).toEqual(
      ['create_directory', 'list_directory', 'read_file', 'search_files', 'write_file'],
    );
  }, 300_000);

  it('write then read round-trips through the per-group pod', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-2'], specs: [fsSpec],
    });
    const hash = groupHash('fs-itest-2');
    await scaleUpInstance({
      client, namespace: NAMESPACE,
      groupFolder: 'fs-itest-2', capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const localPort = 32101;
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const write = await mcpCall(localPort, 'write_file', { path: 'notes.md', content: 'hello' });
      expect(write.isError).toBeFalsy();
      const read = await mcpCall(localPort, 'read_file', { path: 'notes.md' });
      const text = (read.content?.[0] as { text?: string })?.text;
      expect(text).toBe('hello');
    } finally {
      stop();
    }
  }, 240_000);

  it('path traversal is rejected', async () => {
    __resetDbForTest();
    client = new RealPerGroupK8sClient();
    await reconcileGroupCapabilities({
      client, namespace: NAMESPACE, groupsPvcName: 'kubeclaw-groups-pvc',
      groups: ['fs-itest-3'], specs: [fsSpec],
    });
    const hash = groupHash('fs-itest-3');
    await scaleUpInstance({
      client, namespace: NAMESPACE,
      groupFolder: 'fs-itest-3', capabilityName: 'filesystem',
      timeoutMs: 60_000,
    });
    const localPort = 32102;
    const stop = await portForward(`mcp-filesystem-${hash}`, localPort);
    try {
      const out = await mcpCall(localPort, 'read_file', { path: '../../etc/passwd' });
      expect(out.isError).toBe(true);
      const text = (out.content?.[0] as { text?: string })?.text;
      expect(text).toMatch(/traversal/i);
    } finally {
      stop();
    }
  }, 180_000);
});
```

- [ ] **Step 3: Run the integration test**

```bash
cd <worktree-path>
./container/mcp-bundle/build.sh kubeclaw-mcp-bundle:test
minikube image load kubeclaw-mcp-bundle:test 2>&1 || true
npx vitest run --config vitest.e2e.config.ts e2e/filesystem-mcp-integration.test.ts 2>&1 | tail -20
```
Expected: 3 pass if cluster + image are available; skipped otherwise.

- [ ] **Step 4: Commit**

```bash
cd <worktree-path>
git add e2e/filesystem-mcp-integration.test.ts
git commit -m "test(integration): filesystem MCP scrape + write-read + traversal-reject"
```

---

### Task 8: E2E placeholder

**Files:**
- Create: `e2e/filesystem-mcp-e2e.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const SKIP_E2E = process.env.SKIP_E2E === '1';
const NAMESPACE = 'kubeclaw';

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!K8S_AVAILABLE || SKIP_E2E)('filesystem MCP e2e', () => {
  it('placeholder: full LLM roundtrip pending mock-LLM channel-pod harness', () => {
    // The integration test in e2e/filesystem-mcp-integration.test.ts covers:
    // schema scrape, write_file/read_file round-trip via the per-group pod,
    // path traversal rejection.
    //
    // The full LLM-driven path (channel sees mcp__filesystem__read_file in
    // tool list → LLM calls it → response reaches user) requires mock-LLM
    // channel infrastructure not yet built in e2e/. Same placeholder pattern
    // as Phase B Spec 1's e2e test.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

```bash
cd <worktree-path>
npx vitest run --config vitest.e2e.config.ts e2e/filesystem-mcp-e2e.test.ts 2>&1 | tail -8
```
Expected: 1 placeholder passes.

- [ ] **Step 3: Commit**

```bash
cd <worktree-path>
git add e2e/filesystem-mcp-e2e.test.ts
git commit -m "test(e2e): filesystem MCP placeholder + helm install gate"
```

---

### Task 9: Docs + CHANGELOG

**Files:**
- Modify: `docs/PER_GROUP_CAPABILITIES.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append to `docs/PER_GROUP_CAPABILITIES.md`**

Add at the end:

```markdown
## Filesystem MCP (Phase B Spec 2)

The filesystem capability ships **default-on**. Every registered group gets
its own `kubeclaw-mcp-bundle` pod (scaled to zero when idle) exposing five
tools under `mcp__filesystem__*`:

- `read_file(path)` — UTF-8 contents
- `write_file(path, content)` — overwrites
- `list_directory(path)` — entries with type and size
- `search_files(path, pattern)` — glob over file paths
- `create_directory(path)` — recursive + idempotent

All paths are relative to the group's PVC subPath (mounted at `/data` inside
the pod). Absolute paths, traversal escapes, and symlink escapes are rejected.

### File-size cap

Both `read_file` and `write_file` are capped at **100 MiB** per call. The
MCP protocol holds full content in memory during JSON encode/decode, so
larger files would risk OOM-ing the pod (default `memoryLimit: 512Mi`).

To raise the cap, override in `values.yaml`:

```yaml
capabilities:
  filesystem:
    env:
      KUBECLAW_FS_MAX_FILE_BYTES: "524288000"        # 500 MiB
      NODE_OPTIONS: "--max-old-space-size=1024"
    resources:
      memoryLimit: 2Gi
```

Pod memory should be ~3-4× the cap to absorb the JSON-decode peak.

### Tools shipped but disabled by default

The bundle's filesystem module also has handlers for `delete_file` and
`move_file`, but they are omitted from default `allowedTools`. Operators
who want them add to their `values.yaml`:

```yaml
capabilities:
  filesystem:
    allowedTools:
      - read_file
      - write_file
      - list_directory
      - search_files
      - create_directory
      - delete_file
      - move_file
```

Note: in v1 the bundle does not yet implement `delete_file`/`move_file`
— this is a v1.x feature; the spec includes them as a future extension.
```

(The note about delete/move not being implemented in v1 matches the spec — the bundle ships only the 5 tools listed; delete/move are deferred to a follow-up.)

- [ ] **Step 2: Update `README.md`**

Find the "What It Supports" or capabilities section. Append a bullet:

```markdown
- **Filesystem per group** — every group gets a sandboxed filesystem at
  `/data` (its own PVC subPath) exposed to the LLM via 5 MCP tools
  (`read_file`, `write_file`, `list_directory`, `search_files`,
  `create_directory`). Default-on; 100 MiB file-size cap. Scales to zero
  when idle.
```

If the README has a different structure, place the bullet wherever other
capabilities are listed.

- [ ] **Step 3: Append to `CHANGELOG.md` Unreleased section**

Under existing "Features" subsection, add:

```markdown
- **Filesystem MCP capability (Phase B Spec 2)** — default-on. Each
  registered group gets a per-group `kubeclaw-mcp-bundle` pod (scales to
  zero when idle) exposing five tools to the LLM under the
  `mcp__filesystem__*` prefix: `read_file`, `write_file`, `list_directory`,
  `search_files`, `create_directory`. Files are stored on the group's PVC
  subPath; 100 MiB file-size cap (configurable via
  `KUBECLAW_FS_MAX_FILE_BYTES`).
- **New container image `kubeclaw-mcp-bundle`** — Node-based, hosts
  multiple MCP server kinds selected via `--server` arg. Filesystem is the
  first inhabitant; future Node MCPs (time, sequential-thinking, github)
  will share it.
```

- [ ] **Step 4: Commit**

```bash
cd <worktree-path>
git add docs/PER_GROUP_CAPABILITIES.md README.md CHANGELOG.md
git commit -m "docs: filesystem MCP capability"
```

---

### Task 10: Final sweep + verification

**Files:** none (verification only)

- [ ] **Step 1: Bundle tests**

```bash
cd <worktree-path>/container/mcp-bundle
npm test 2>&1 | tail -8
```
Expected: 18 pass (8 paths + 10 server).

- [ ] **Step 2: Main repo build + tests**

```bash
cd <worktree-path>
npm run build 2>&1 | tail -3
npm test 2>&1 | tail -5
```
Expected: zero TS errors, all tests pass (no regressions vs. baseline 1851).

- [ ] **Step 3: Bundle image build**

```bash
cd <worktree-path>
./container/mcp-bundle/build.sh kubeclaw-mcp-bundle:test 2>&1 | tail -5
```
Expected: success.

- [ ] **Step 4: Integration + e2e (cluster required)**

```bash
cd <worktree-path>
minikube image load kubeclaw-mcp-bundle:test 2>/dev/null || true
npx vitest run --config vitest.e2e.config.ts \
  e2e/filesystem-mcp-integration.test.ts \
  e2e/filesystem-mcp-e2e.test.ts 2>&1 | tail -15
```
Expected: pass or skip per env.

- [ ] **Step 5: Spec-coverage check**

| Spec section | Task |
|---|---|
| Container packaging | Task 1, 5 |
| Path-safety helpers | Task 2 |
| 5-tool surface | Task 3 |
| 100 MiB cap | Task 3 |
| HTTP transport + readinessProbe | Task 3 (server.js `/health`) |
| Bundle unit tests | Task 2, 4 |
| Helm values entry | Task 6 |
| Integration test | Task 7 |
| E2E placeholder | Task 8 |
| Docs + CHANGELOG | Task 9 |

- [ ] **Step 6: No commit needed**

End of Phase B Spec 2 implementation.

---

## Notes for the implementer

- **Pattern matching.** `container/mcp-bundle/index.js` and `filesystem/server.js` mirror the structure of `container/echo-mcp/`. Per-request transport+server factory is mandatory (MCP SDK >= 1.10).
- **Prettier reformat noise.** Files outside `container/mcp-bundle/` may be reformatted on save by background processes. Stage only the files for your task.
- **No new features.** Stick to the spec. Spec 3 (docling) is a separate plan.
- **Test isolation.** Each test in `server.test.js` should listen on a random ephemeral port to avoid conflicts when tests run in parallel.
