import { describe, it, expect, vi, afterEach } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

// Mock the LLM runner so we can assert it is never invoked during /search dispatch.
const runAgentSpy = vi.fn().mockResolvedValue({ status: 'success' });
const writeTasksSnapshotSpy = vi.fn();
const writeGroupsSnapshotSpy = vi.fn();
const fakeRunner = {
  runAgent: runAgentSpy,
  writeTasksSnapshot: writeTasksSnapshotSpy,
  writeGroupsSnapshot: writeGroupsSnapshotSpy,
  configureMcp: vi.fn(),
};
vi.mock('./runtime/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runtime/index.js')>();
  return {
    ...original,
    getDirectLLMRunner: () => fakeRunner,
    shutdownAllRunners: vi.fn(),
  };
});

// Mock Redis IPC watchers — they try to connect on module import.
vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
}));
vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({ publish: vi.fn() })),
  getChannelStatusChannel: vi.fn(() => 'kubeclaw:channel-status:test'),
}));

import {
  folderPrefixForChannel,
  processGroupMessages,
  _testInjectState,
  _testResetState,
} from './channel-runner.js';
import { isSearchCommand, handleSearchCommand } from './runtime/search-command.js';

describe('folderPrefixForChannel', () => {
  it('returns "oauth" for oauth-webchat', () => {
    expect(folderPrefixForChannel('oauth-webchat')).toBe('oauth');
  });

  it('returns the established prefix for known channels', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('http')).toBe('http');
  });

  it('falls back to first 3 chars for unknown channels', () => {
    expect(folderPrefixForChannel('matrix')).toBe('mat');
  });
});

describe('/search dispatch', () => {
  it('isSearchCommand identifies /search messages', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
    expect(isSearchCommand('/skills list')).toBe(false);
    expect(isSearchCommand('regular message')).toBe(false);
  });

  it('handleSearchCommand returns a no-results message for unknown query', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();
    const out = handleSearchCommand('test-group', '/search xqzz_channel_runner_dispatch');
    expect(out).toMatch(/no results/i);
  });
});

describe('/search dispatch end-to-end via processGroupMessages', () => {
  const CHAT_JID = 'dispatch-test@g.us';
  const GROUP_FOLDER = 'tg_dispatch-test';
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    _testResetState();
    runAgentSpy.mockClear();
    sendMessageSpy.mockClear();
  });

  it('sends search result via channel.sendMessage and does NOT invoke the LLM', async () => {
    // Initialize the real sql.js DB and populate it with conversation history + a message.
    const {
      _initTestDatabase,
      storeChatMetadata,
      storeMessage,
      appendConversationMessage,
    } = await import('./db.js');
    await _initTestDatabase();

    // Register the chat so getMessagesSince has a home.
    storeChatMetadata(CHAT_JID, new Date().toISOString(), 'Dispatch Test Group', 'telegram', true);

    // Seed conversation history so /search has rows to return.
    appendConversationMessage(GROUP_FOLDER, 'user', 'the cluster uses kubernetes for scheduling');
    appendConversationMessage(GROUP_FOLDER, 'assistant', 'yes kubernetes is configured');

    // Store the incoming /search message in the messages table.
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    storeMessage({
      id: 'dispatch-search-msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content: '/search kubernetes',
      timestamp: msgTimestamp,
      is_from_me: false,
    });

    // Build a fake channel that owns the test JID.
    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };

    // Inject the registered group and fake channel into module-level state.
    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Dispatch Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false, // bypass trigger check so /search is processed
        },
      },
      [fakeChannel as any],
    );

    const result = await processGroupMessages(CHAT_JID);

    // The function should complete successfully.
    expect(result).toBe(true);

    // sendMessage must have been called with a search result string.
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toMatch(/kubernetes/i);

    // The LLM runner must NOT have been invoked — /search is intercepted before runAgent.
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it('forwards a non-search message to the LLM (regression guard)', async () => {
    const { _initTestDatabase, storeChatMetadata, storeMessage } = await import('./db.js');
    await _initTestDatabase();

    storeChatMetadata(CHAT_JID, new Date().toISOString(), 'Dispatch Test Group', 'telegram', true);

    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    storeMessage({
      id: 'dispatch-regular-msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content: 'hello world regular message',
      timestamp: msgTimestamp,
      is_from_me: false,
    });

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Dispatch Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    await processGroupMessages(CHAT_JID);

    // For a normal message the LLM runner IS invoked (verifying /search intercept is not over-broad).
    expect(runAgentSpy).toHaveBeenCalled();
    // sendMessage was NOT called directly by processGroupMessages (the LLM mock handles output).
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
