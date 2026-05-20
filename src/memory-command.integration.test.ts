/**
 * Integration test for /memory command.
 *
 * Uses a real tmpdir (no mocking of fs) to verify the full create/append/set/
 * empty/show cycle and per-group isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

// Import the real functions (no mocks for fs in this file)
import { isMemoryCommand, handleMemoryCommand } from './channel-runner.js';

// channel-runner.ts has a module-level guard that requires KUBECLAW_CHANNEL.
// This is a test file, so we set it before import (vitest handles hoisting).
import { vi } from 'vitest';
vi.hoisted(() => {
  if (!process.env.KUBECLAW_CHANNEL) {
    process.env.KUBECLAW_CHANNEL = 'test-integration';
  }
});

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: { runJob: vi.fn(), createToolJob: vi.fn(), deleteJob: vi.fn() },
}));
vi.mock('./runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn(),
  shutdownAllRunners: vi.fn(),
}));
vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getMessagesSince: vi.fn().mockReturnValue([]),
    getAllTasks: vi.fn().mockReturnValue([]),
    getAllChats: vi.fn().mockReturnValue([]),
    getAllSessions: vi.fn().mockReturnValue({}),
    getAllRegisteredGroups: vi.fn().mockReturnValue({}),
    getRouterState: vi.fn().mockReturnValue(''),
    setRouterState: vi.fn(),
    setRegisteredGroup: vi.fn(),
    setSession: vi.fn(),
    initDatabase: vi.fn().mockResolvedValue(undefined),
    storeMessage: vi.fn(),
    storeChatMetadata: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
    appendConversationHistory: vi.fn(),
    appendConversationMessage: vi.fn(),
    getNewMessages: vi.fn().mockReturnValue({ messages: [], newTimestamp: '' }),
    recordSpecialistUsage: vi.fn(),
  };
});
vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ publish: vi.fn().mockResolvedValue(0), quit: vi.fn() }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));

describe('/memory command integration — real tmpdir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-integration-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ── isMemoryCommand ──────────────────────────────────────────────────────────

  it('isMemoryCommand correctly identifies /memory commands', () => {
    expect(isMemoryCommand('/memory show')).toBe(true);
    expect(isMemoryCommand('/memory append hello')).toBe(true);
    expect(isMemoryCommand('/memory set something')).toBe(true);
    expect(isMemoryCommand('/memory')).toBe(true);
    expect(isMemoryCommand('/memorize this')).toBe(false);
    expect(isMemoryCommand('hello /memory')).toBe(false);
  });

  // ── AC1: show when absent ────────────────────────────────────────────────────

  it('AC1: /memory show returns "No memory set." when CLAUDE.md does not exist', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    const reply = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(reply).toBe('No memory set.');
  });

  it('AC1: /memory show returns file contents when CLAUDE.md exists', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'alice', 'CLAUDE.md'), 'my memory content', 'utf8');
    const reply = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(reply).toBe('my memory content');
  });

  // ── AC2: append creates file if absent, then confirm with show ──────────────

  it('AC2: /memory append creates file when absent', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    const reply = await handleMemoryCommand('alice', '/memory append first note', tmpDir);
    expect(reply).toBe('Memory updated.');

    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toContain('first note');
  });

  it('AC2: /memory append adds to existing content, subsequent show confirms', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'alice', 'CLAUDE.md'),
      'original content\n',
      'utf8',
    );
    await handleMemoryCommand('alice', '/memory append added line', tmpDir);
    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toContain('original content');
    expect(confirm).toContain('added line');
  });

  it('AC2: multiple appends accumulate in order', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await handleMemoryCommand('alice', '/memory append line one', tmpDir);
    await handleMemoryCommand('alice', '/memory append line two', tmpDir);
    await handleMemoryCommand('alice', '/memory append line three', tmpDir);
    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toContain('line one');
    expect(confirm).toContain('line two');
    expect(confirm).toContain('line three');
    // Order preserved
    const pos1 = confirm.indexOf('line one');
    const pos2 = confirm.indexOf('line two');
    const pos3 = confirm.indexOf('line three');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  // ── AC3: set overwrites entirely; subsequent show returns only new text ──────

  it('AC3: /memory set overwrites file, subsequent show returns only new text', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'alice', 'CLAUDE.md'),
      'old content to be replaced',
      'utf8',
    );
    const reply = await handleMemoryCommand('alice', '/memory set brand new content', tmpDir);
    expect(reply).toBe('Memory updated.');

    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toBe('brand new content');
    expect(confirm).not.toContain('old content');
  });

  it('AC3: /memory set creates file when it does not exist', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await handleMemoryCommand('alice', '/memory set from scratch', tmpDir);
    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toBe('from scratch');
  });

  // ── AC4: set "" truncates to empty; show returns "No memory set." ────────────

  it('AC4: /memory set with empty text truncates file', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'alice', 'CLAUDE.md'),
      'some existing text',
      'utf8',
    );
    const reply = await handleMemoryCommand('alice', '/memory set', tmpDir);
    expect(reply).toBe('Memory cleared.');

    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toBe('No memory set.');
  });

  it('AC4: /memory set " " (spaces only) behaves as empty', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'alice', 'CLAUDE.md'),
      'has content',
      'utf8',
    );
    // "/memory set " — trailing space only, regex strips it
    await handleMemoryCommand('alice', '/memory set ', tmpDir);
    const confirm = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(confirm).toBe('No memory set.');
  });

  // ── AC5: per-group isolation ─────────────────────────────────────────────────

  it('AC5: alice show does not return bob content', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'bob'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'bob', 'CLAUDE.md'),
      'bobs private note',
      'utf8',
    );
    const reply = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(reply).toBe('No memory set.');
    expect(reply).not.toContain('bobs private note');
  });

  it('AC5: alice append does not affect bobs file', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'bob'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'bob', 'CLAUDE.md'),
      'bobs original content',
      'utf8',
    );
    await handleMemoryCommand('alice', '/memory append alices note', tmpDir);
    const bobContent = await fsp.readFile(
      path.join(tmpDir, 'bob', 'CLAUDE.md'),
      'utf8',
    );
    expect(bobContent).toBe('bobs original content');
    expect(bobContent).not.toContain('alices note');
  });

  it('AC5: alice and bob maintain independent memory, full cycle', async () => {
    await fsp.mkdir(path.join(tmpDir, 'alice'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'bob'), { recursive: true });

    // Setup independent memories
    await handleMemoryCommand('alice', '/memory set alice memory contents', tmpDir);
    await handleMemoryCommand('bob', '/memory set bob memory contents', tmpDir);

    // Each shows their own
    const aliceShow = await handleMemoryCommand('alice', '/memory show', tmpDir);
    const bobShow = await handleMemoryCommand('bob', '/memory show', tmpDir);
    expect(aliceShow).toBe('alice memory contents');
    expect(bobShow).toBe('bob memory contents');

    // Alice appends — does not affect bob
    await handleMemoryCommand('alice', '/memory append alice extra', tmpDir);
    const bobShowAfter = await handleMemoryCommand('bob', '/memory show', tmpDir);
    expect(bobShowAfter).toBe('bob memory contents');
    expect(bobShowAfter).not.toContain('alice extra');

    // Bob sets new — does not affect alice
    await handleMemoryCommand('bob', '/memory set bob completely new', tmpDir);
    const aliceShowAfter = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(aliceShowAfter).toContain('alice memory contents');
    expect(aliceShowAfter).not.toContain('bob completely new');
  });

  // ── Directory creation ───────────────────────────────────────────────────────

  it('creates the group directory if it does not exist when appending', async () => {
    // Note: tmpDir exists but 'newgroup' subdir does not
    await handleMemoryCommand('newgroup', '/memory append hello', tmpDir);
    const confirm = await handleMemoryCommand('newgroup', '/memory show', tmpDir);
    expect(confirm).toContain('hello');
  });

  it('creates the group directory if it does not exist when setting', async () => {
    await handleMemoryCommand('brandnewgroup', '/memory set initial memory', tmpDir);
    const confirm = await handleMemoryCommand('brandnewgroup', '/memory show', tmpDir);
    expect(confirm).toBe('initial memory');
  });
});
