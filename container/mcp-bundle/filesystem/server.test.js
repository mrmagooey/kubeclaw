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
    // The server reads the env on each call (maxFileBytes() in server.js),
    // so this works without restarting the server.
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
