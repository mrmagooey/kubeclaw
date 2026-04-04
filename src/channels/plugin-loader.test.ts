import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRegisterChannel } = vi.hoisted(() => ({
  mockRegisterChannel: vi.fn(),
}));

vi.mock('./registry.js', () => ({
  registerChannel: mockRegisterChannel,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { loadChannelPlugins } from './plugin-loader.js';
import { logger } from '../logger.js';

describe('loadChannelPlugins', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-plugin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns early if directory does not exist', async () => {
    await loadChannelPlugins('/nonexistent/path/that/does/not/exist');
    expect(mockRegisterChannel).not.toHaveBeenCalled();
  });

  it('loads a .js plugin and calls its default export with pluginContext', async () => {
    // Write a real ES module plugin to the temp dir
    const pluginPath = path.join(tmpDir, 'test-channel.js');
    fs.writeFileSync(
      pluginPath,
      `export default function register(ctx) { ctx.registerChannel('test', () => null); }\n`,
    );

    await loadChannelPlugins(tmpDir);

    expect(mockRegisterChannel).toHaveBeenCalledWith(
      'test',
      expect.any(Function),
    );
    expect(logger.info).toHaveBeenCalledWith(
      { plugin: 'test-channel.js' },
      'Channel plugin loaded',
    );
  });

  it('skips non-.js files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), 'not a plugin');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'plugin.ts'), 'export default () => {}');

    await loadChannelPlugins(tmpDir);

    expect(mockRegisterChannel).not.toHaveBeenCalled();
  });

  it('logs error and continues when a plugin fails to load', async () => {
    // A plugin that throws during registration
    const badPlugin = path.join(tmpDir, 'bad-plugin.js');
    fs.writeFileSync(
      badPlugin,
      `export default function() { throw new Error('boom'); }\n`,
    );

    // A good plugin after the bad one
    const goodPlugin = path.join(tmpDir, 'good-plugin.js');
    fs.writeFileSync(
      goodPlugin,
      `export default function(ctx) { ctx.registerChannel('good', () => null); }\n`,
    );

    await loadChannelPlugins(tmpDir);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'bad-plugin.js' }),
      'Failed to load channel plugin',
    );
    expect(mockRegisterChannel).toHaveBeenCalledWith(
      'good',
      expect.any(Function),
    );
  });

  it('skips plugins that have no default export', async () => {
    const pluginPath = path.join(tmpDir, 'no-default.js');
    fs.writeFileSync(pluginPath, `export const name = 'no-default';\n`);

    await loadChannelPlugins(tmpDir);

    expect(mockRegisterChannel).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('loads multiple plugins from the same directory', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'irc.js'),
      `export default function(ctx) { ctx.registerChannel('irc', () => null); }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'slack.js'),
      `export default function(ctx) { ctx.registerChannel('slack', () => null); }\n`,
    );

    await loadChannelPlugins(tmpDir);

    expect(mockRegisterChannel).toHaveBeenCalledTimes(2);
    expect(mockRegisterChannel).toHaveBeenCalledWith(
      'irc',
      expect.any(Function),
    );
    expect(mockRegisterChannel).toHaveBeenCalledWith(
      'slack',
      expect.any(Function),
    );
  });
});
