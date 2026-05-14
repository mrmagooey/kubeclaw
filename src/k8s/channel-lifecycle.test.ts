import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeSubscriber extends EventEmitter {
  public subscribed: string[] = [];
  subscribe = vi.fn((channel: string, cb?: (err: Error | null) => void) => {
    this.subscribed.push(channel);
    cb?.(null);
  });
}

let fakeSubscriber: FakeSubscriber;

vi.mock('./redis-client.js', () => ({
  getRedisSubscriber: () => fakeSubscriber,
  getChannelStatusChannel: (name: string) => `kubeclaw:channel-status:${name}`,
}));

const mockPublishControlCommand = vi.fn();
vi.mock('./ipc-redis.js', () => ({
  publishControlCommand: mockPublishControlCommand,
}));

const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function loadModule() {
  const mod = await import('./channel-lifecycle.js');
  return mod;
}

beforeEach(() => {
  fakeSubscriber = new FakeSubscriber();
  mockPublishControlCommand.mockReset();
  mockReadFileSync.mockReset();
  vi.resetModules();
});

describe('startChannelStatusWatcher', () => {
  it('subscribes to one channel per name', async () => {
    const { startChannelStatusWatcher } = await loadModule();
    startChannelStatusWatcher(['telegram', 'slack', 'irc']);
    expect(fakeSubscriber.subscribed).toEqual([
      'kubeclaw:channel-status:telegram',
      'kubeclaw:channel-status:slack',
      'kubeclaw:channel-status:irc',
    ]);
  });

  it('dispatches parsed events to registered callbacks', async () => {
    const { startChannelStatusWatcher, onChannelStatus } = await loadModule();
    startChannelStatusWatcher(['telegram']);
    const seen: Array<[string, unknown]> = [];
    onChannelStatus((name, event) => seen.push([name, event]));

    fakeSubscriber.emit(
      'message',
      'kubeclaw:channel-status:telegram',
      JSON.stringify({ status: 'ready', detail: 'pod up' }),
    );

    expect(seen).toEqual([['telegram', { status: 'ready', detail: 'pod up' }]]);
  });

  it('ignores messages on unrelated channels', async () => {
    const { startChannelStatusWatcher, onChannelStatus } = await loadModule();
    startChannelStatusWatcher(['telegram']);
    const cb = vi.fn();
    onChannelStatus(cb);

    fakeSubscriber.emit(
      'message',
      'kubeclaw:not-status:telegram',
      JSON.stringify({ status: 'ready' }),
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not throw on malformed JSON payloads', async () => {
    const { startChannelStatusWatcher, onChannelStatus } = await loadModule();
    startChannelStatusWatcher(['telegram']);
    const cb = vi.fn();
    onChannelStatus(cb);

    expect(() =>
      fakeSubscriber.emit(
        'message',
        'kubeclaw:channel-status:telegram',
        '{ not json',
      ),
    ).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('watchChannelStatus', () => {
  it('subscribes to a single channel by name', async () => {
    const { watchChannelStatus } = await loadModule();
    watchChannelStatus('whatsapp');
    expect(fakeSubscriber.subscribed).toEqual([
      'kubeclaw:channel-status:whatsapp',
    ]);
  });
});

describe('configureChannel', () => {
  it('publishes a configure command with no skill document when the skill file is missing', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { configureChannel } = await loadModule();
    await configureChannel('telegram-1', 'telegram');
    expect(mockPublishControlCommand).toHaveBeenCalledTimes(1);
    expect(mockPublishControlCommand).toHaveBeenCalledWith('telegram-1', {
      command: 'configure',
      channelType: 'telegram',
      dependencies: undefined,
      skillDocument: undefined,
    });
  });

  it('parses dependencies from skill frontmatter and includes them in the command', async () => {
    const doc = [
      '---',
      'name: telegram',
      'dependencies:',
      '  - "node-telegram-bot-api"',
      '  - axios',
      '---',
      'body here',
      '',
    ].join('\n');
    mockReadFileSync.mockImplementation(() => doc);
    const { configureChannel } = await loadModule();
    await configureChannel('telegram-1', 'telegram');
    const arg = mockPublishControlCommand.mock.calls[0][1];
    expect(arg.command).toBe('configure');
    expect(arg.channelType).toBe('telegram');
    expect(arg.dependencies).toEqual(['node-telegram-bot-api', 'axios']);
    expect(arg.skillDocument).toBe(doc);
  });

  it('omits dependencies when frontmatter has none', async () => {
    const doc = '---\nname: x\n---\nbody\n';
    mockReadFileSync.mockImplementation(() => doc);
    const { configureChannel } = await loadModule();
    await configureChannel('inst', 'x');
    const arg = mockPublishControlCommand.mock.calls[0][1];
    expect(arg.dependencies).toBeUndefined();
    expect(arg.skillDocument).toBe(doc);
  });

  it('omits dependencies when there is no frontmatter at all', async () => {
    mockReadFileSync.mockImplementation(() => 'no frontmatter here\n');
    const { configureChannel } = await loadModule();
    await configureChannel('inst', 'x');
    const arg = mockPublishControlCommand.mock.calls[0][1];
    expect(arg.dependencies).toBeUndefined();
  });
});

describe('waitForChannelStatus', () => {
  it('resolves with the event when the target status arrives', async () => {
    const { startChannelStatusWatcher, waitForChannelStatus } =
      await loadModule();
    startChannelStatusWatcher(['telegram']);

    const promise = waitForChannelStatus('telegram', 'ready', 5000);
    fakeSubscriber.emit(
      'message',
      'kubeclaw:channel-status:telegram',
      JSON.stringify({ status: 'ready' }),
    );
    await expect(promise).resolves.toEqual({ status: 'ready' });
  });

  it('resolves with the error event when status=error arrives even if a different target was requested', async () => {
    const { startChannelStatusWatcher, waitForChannelStatus } =
      await loadModule();
    startChannelStatusWatcher(['telegram']);

    const promise = waitForChannelStatus('telegram', 'configured', 5000);
    fakeSubscriber.emit(
      'message',
      'kubeclaw:channel-status:telegram',
      JSON.stringify({ status: 'error', detail: 'boom' }),
    );
    await expect(promise).resolves.toEqual({
      status: 'error',
      detail: 'boom',
    });
  });

  it('ignores events for other channels', async () => {
    vi.useFakeTimers();
    const { startChannelStatusWatcher, waitForChannelStatus } =
      await loadModule();
    startChannelStatusWatcher(['telegram', 'slack']);

    const promise = waitForChannelStatus('telegram', 'ready', 1000);
    fakeSubscriber.emit(
      'message',
      'kubeclaw:channel-status:slack',
      JSON.stringify({ status: 'ready' }),
    );
    vi.advanceTimersByTime(1500);
    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('returns null on timeout', async () => {
    vi.useFakeTimers();
    const { waitForChannelStatus } = await loadModule();
    const promise = waitForChannelStatus('telegram', 'ready', 500);
    vi.advanceTimersByTime(600);
    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });
});
