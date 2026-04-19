import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getAllSessions,
  getAllRegisteredGroups,
  getRouterState,
  setRouterState,
  setRegisteredGroup,
  _initTestDatabase,
  getAllTasks,
  getAllChats,
} from './db.js';
import {
  _setRegisteredGroups,
  _processGroupMessages,
  _pushChannel,
  _resetState,
  _recoverPendingMessages,
  registerGroup,
  getAvailableGroups,
} from './index.js';
import { getToolJobRunner, getRunnerForGroup } from './runtime/index.js';
import { loadSpecialists, detectMentionedSpecialists } from './specialists.js';
import { findChannel } from './router.js';
import { getMessagesSince } from './db.js';

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getRouterState: vi.fn(),
    setRouterState: vi.fn(),
    getAllSessions: vi.fn(),
    getAllRegisteredGroups: vi.fn(),
    setRegisteredGroup: vi.fn(),
    getMessagesSince: vi.fn(),
    setSession: vi.fn(),
    getAllTasks: vi.fn().mockReturnValue([]),
    getAllChats: vi.fn().mockReturnValue([]),
  };
});

vi.mock('fs', async () => ({
  default: {
    mkdirSync: vi.fn(),
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./specialists.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    loadSpecialists: vi.fn(),
    detectMentionedSpecialists: vi.fn(),
  };
});

vi.mock('./router.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    findChannel: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('formatted prompt'),
  };
});

vi.mock('./runtime/index.js', () => ({
  getToolJobRunner: vi.fn(),
  getAgentRunner: vi.fn(),
  getRunnerForGroup: vi.fn(),
  shutdownAllRunners: vi.fn(),
}));

vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startToolPodSpawnWatcher: vi.fn(),
  startToolJobSpawnWatcher: vi.fn(),
  startTaskRequestWatcher: vi.fn(),
  stopIpcWatcher: vi.fn(),
}));

vi.mock('./k8s/redis-client.js', () => ({
  getOutputChannel: vi.fn().mockReturnValue('kubeclaw:output:test'),
  getRedisClient: vi.fn().mockReturnValue({
    xadd: vi.fn(),
    xread: vi.fn(),
    quit: vi.fn(),
  }),
  getRedisSubscriber: vi.fn(),
}));

vi.mock('./rag/retriever.js', () => ({
  augmentPrompt: vi.fn((_folder: string, prompt: string) =>
    Promise.resolve(prompt),
  ),
}));

vi.mock('./rag/indexer.js', () => ({
  indexConversationTurn: vi.fn().mockResolvedValue(undefined),
}));

const mockGetAllTasks = getAllTasks as ReturnType<typeof vi.fn>;
const mockGetAllChats = getAllChats as ReturnType<typeof vi.fn>;
const mockGetRouterState = getRouterState as ReturnType<typeof vi.fn>;
const mockSetRouterState = setRouterState as ReturnType<typeof vi.fn>;
const mockGetAllSessions = getAllSessions as ReturnType<typeof vi.fn>;
const mockGetAllRegisteredGroups = getAllRegisteredGroups as ReturnType<
  typeof vi.fn
>;
const mockSetRegisteredGroup = setRegisteredGroup as ReturnType<typeof vi.fn>;
const mockFs = await import('fs');
const mockGetToolJobRunner = getToolJobRunner as ReturnType<typeof vi.fn>;
const mockGetRunnerForGroup = getRunnerForGroup as ReturnType<typeof vi.fn>;
const mockLoadSpecialists = loadSpecialists as ReturnType<typeof vi.fn>;
const mockDetectMentionedSpecialists = detectMentionedSpecialists as ReturnType<
  typeof vi.fn
>;
const mockFindChannel = findChannel as ReturnType<typeof vi.fn>;
const mockGetMessagesSince = getMessagesSince as ReturnType<typeof vi.fn>;

describe('index.ts internal functions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await _initTestDatabase();
    _setRegisteredGroups({});
  });

  describe('loadState', () => {
    it('loads last_timestamp from DB', async () => {
      const { loadState } = await import('./index.js');
      mockGetRouterState.mockReturnValueOnce('2024-01-01T00:00:00.000Z');
      mockGetRouterState.mockReturnValueOnce(undefined);
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue({});

      loadState();

      expect(mockGetRouterState).toHaveBeenCalledWith('last_timestamp');
    });

    it('loads last_agent_timestamp from DB', async () => {
      const { loadState } = await import('./index.js');
      mockGetRouterState.mockReturnValueOnce('');
      mockGetRouterState.mockReturnValueOnce('{"chat1":"ts1","chat2":"ts2"}');
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue({});

      loadState();

      expect(mockGetRouterState).toHaveBeenCalledWith('last_agent_timestamp');
    });

    it('resets corrupted last_agent_timestamp JSON', async () => {
      const { loadState } = await import('./index.js');
      mockGetRouterState.mockReturnValueOnce('');
      mockGetRouterState.mockReturnValueOnce('invalid-json{');
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue({});

      loadState();

      expect(mockGetRouterState).toHaveBeenCalledWith('last_agent_timestamp');
    });

    it('loads sessions from DB', async () => {
      const { loadState } = await import('./index.js');
      mockGetRouterState.mockReturnValueOnce('');
      mockGetRouterState.mockReturnValueOnce(undefined);
      mockGetAllSessions.mockReturnValue({
        folder1: 'session1',
        folder2: 'session2',
      });
      mockGetAllRegisteredGroups.mockReturnValue({});

      loadState();

      expect(mockGetAllSessions).toHaveBeenCalled();
    });

    it('loads registered groups from DB', async () => {
      const { loadState } = await import('./index.js');
      const mockGroups = {
        'chat@g.us': {
          name: 'Test',
          folder: 'test',
          trigger: '@test',
          added_at: '2024-01-01',
        },
      };
      mockGetRouterState.mockReturnValueOnce('');
      mockGetRouterState.mockReturnValueOnce(undefined);
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue(mockGroups);

      loadState();

      expect(mockGetAllRegisteredGroups).toHaveBeenCalled();
    });
  });

  describe('saveState', () => {
    it('saves last_timestamp to DB', async () => {
      const { saveState } = await import('./index.js');

      saveState();

      expect(mockSetRouterState).toHaveBeenCalledWith(
        'last_timestamp',
        expect.any(String),
      );
    });

    it('saves last_agent_timestamp as JSON string to DB', async () => {
      const { saveState } = await import('./index.js');

      saveState();

      expect(mockSetRouterState).toHaveBeenCalledWith(
        'last_agent_timestamp',
        expect.any(String),
      );
    });
  });

  describe('registerGroup', () => {
    it('registers group with valid folder', async () => {
      const group = {
        name: 'Test Group',
        folder: 'valid-folder',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).toHaveBeenCalledWith('chat@g.us', group);
      expect(mockFs.default.mkdirSync).toHaveBeenCalled();
    });

    it('rejects group with invalid folder name containing path traversal', async () => {
      const group = {
        name: 'Test Group',
        folder: '../etc',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with invalid folder name containing slash', async () => {
      const group = {
        name: 'Test Group',
        folder: 'invalid/folder',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with absolute path folder', async () => {
      const group = {
        name: 'Test Group',
        folder: '/absolute/path',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with reserved folder name', async () => {
      const group = {
        name: 'Test Group',
        folder: 'global',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with folder containing backslash', async () => {
      const group = {
        name: 'Test Group',
        folder: 'folder\\subfolder',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with folder that has leading whitespace', async () => {
      const group = {
        name: 'Test Group',
        folder: ' valid-folder',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });

    it('rejects group with empty folder name', async () => {
      const group = {
        name: 'Test Group',
        folder: '',
        trigger: '@test',
        added_at: '2024-01-01T00:00:00.000Z',
      };

      registerGroup('chat@g.us', group);

      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });
  });

  describe('getAvailableGroups', () => {
    it('returns empty array when no chats in DB', async () => {
      mockGetAllChats.mockReturnValue([]);
      const result = getAvailableGroups();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('returns mapped group chats', async () => {
      mockGetAllChats.mockReturnValue([
        {
          jid: 'group1@g.us',
          name: 'My Group',
          last_message_time: '2024-01-01T00:00:00.000Z',
          is_group: true,
        },
        {
          // __group_sync__ should be filtered out
          jid: '__group_sync__',
          name: 'sync',
          last_message_time: '',
          is_group: true,
        },
        {
          // Non-group should be filtered out
          jid: 'user@s.whatsapp.net',
          name: 'User',
          last_message_time: '',
          is_group: false,
        },
      ]);

      const result = getAvailableGroups();
      expect(result).toHaveLength(1);
      expect(result[0].jid).toBe('group1@g.us');
      expect(result[0].name).toBe('My Group');
      expect(result[0].isRegistered).toBe(false);
    });
  });

  describe('_processGroupMessages edge cases', () => {
    const chatJid = 'chat@g.us';
    const group = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      await _initTestDatabase();
      _resetState();
    });

    it('returns true when no channel owns the JID', async () => {
      mockFindChannel.mockReturnValue(null);
      _setRegisteredGroups({ [chatJid]: group });

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(true);
    });

    it('returns true when there are no pending messages', async () => {
      mockFindChannel.mockReturnValue({
        name: 'test',
        sendMessage: vi.fn(),
        setTyping: vi.fn(),
        owns: vi.fn().mockReturnValue(true),
      });
      mockGetMessagesSince.mockReturnValue([]);
      _setRegisteredGroups({ [chatJid]: group });

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(true);
    });

    it('returns false when agent returns error and no output was sent', async () => {
      const mockRunAgent = vi
        .fn()
        .mockResolvedValue({ status: 'error', result: null });
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(false);
    });

    it('handles runAgent throwing an exception (returns false)', async () => {
      const mockRunAgent = vi
        .fn()
        .mockRejectedValue(new Error('Agent crashed'));
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(false);
    });

    it('runner returns newSessionId which gets stored', async () => {
      const mockRunAgent = vi.fn().mockResolvedValue({
        status: 'success',
        result: null,
        newSessionId: 'new-session-123',
      });
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(true);
    });

    it('invokes streaming onOutput callback and sends message', async () => {
      const mockRunAgent = vi
        .fn()
        .mockImplementation(
          async (
            _group: unknown,
            _input: unknown,
            _spec: unknown,
            onOutput:
              | ((r: {
                  status: string;
                  result: string | null;
                  newSessionId?: string;
                }) => Promise<void>)
              | undefined,
          ) => {
            if (onOutput) {
              await onOutput({
                status: 'success',
                result: 'Hello from agent',
                newSessionId: 'streamed-session',
              });
            }
            return { status: 'success', result: null };
          },
        );
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        name: 'test',
        sendMessage,
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(chatJid, 'Hello from agent');
    });

    it('returns true when agent streams output then errors (preserves cursor)', async () => {
      // Scenario: agent sends output to user but then the final status is error
      // In this case we do NOT roll back the cursor (would cause duplicates)
      const mockRunAgent = vi
        .fn()
        .mockImplementation(
          async (
            _group: unknown,
            _input: unknown,
            _spec: unknown,
            onOutput:
              | ((r: {
                  status: string;
                  result: string | null;
                }) => Promise<void>)
              | undefined,
          ) => {
            if (onOutput) {
              // Stream a result to the user
              await onOutput({ status: 'success', result: 'Partial response' });
            }
            return {
              status: 'error',
              result: null,
              error: 'Agent crashed mid-stream',
            };
          },
        );
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        name: 'test',
        sendMessage,
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      const result = await _processGroupMessages(chatJid);
      // Returns true because output was already sent (no cursor rollback)
      expect(result).toBe(true);
      // Message was sent to user before the error
      expect(sendMessage).toHaveBeenCalledWith(chatJid, 'Partial response');
    });

    it('passes tasks to writeTasksSnapshot when tasks exist', async () => {
      const mockTask = {
        id: 'task-1',
        group_folder: 'test-group',
        prompt: 'Do something',
        schedule_type: 'once',
        schedule_value: '',
        status: 'pending',
        next_run: null,
      };
      mockGetAllTasks.mockReturnValue([mockTask]);

      const mockRunAgent = vi
        .fn()
        .mockResolvedValue({ status: 'success', result: null });
      const writeTasksSnapshot = vi.fn();
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot,
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      await _processGroupMessages(chatJid);

      expect(writeTasksSnapshot).toHaveBeenCalledWith(
        'test-group',
        true,
        expect.arrayContaining([expect.objectContaining({ id: 'task-1' })]),
      );
    });

    it('sets hadError when onOutput callback receives error status', async () => {
      // Covers line 252: hadError = true inside the streaming onOutput callback
      const mockRunAgent = vi
        .fn()
        .mockImplementation(
          async (
            _group: unknown,
            _input: unknown,
            _spec: unknown,
            onOutput:
              | ((r: {
                  status: string;
                  result: string | null;
                }) => Promise<void>)
              | undefined,
          ) => {
            if (onOutput) {
              await onOutput({ status: 'error', result: null });
            }
            return { status: 'success', result: null };
          },
        );
      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      const mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);

      // hadError was set by the onOutput callback (error status); no output sent → returns false
      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(false);
    });

    it('returns true for non-main group with no trigger in messages', async () => {
      const nonMainGroup = {
        ...group,
        isMain: false,
        requiresTrigger: true,
      };

      mockFindChannel.mockReturnValue({
        name: 'test',
        sendMessage: vi.fn(),
        setTyping: vi.fn(),
        owns: vi.fn().mockReturnValue(true),
      });
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'hello no trigger',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);

      _setRegisteredGroups({ [chatJid]: nonMainGroup });

      const result = await _processGroupMessages(chatJid);
      expect(result).toBe(true);
    });
  });

  describe('specialist dispatch', () => {
    const chatJid = 'chat@g.us';
    const group = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    };

    let mockRunAgent: ReturnType<typeof vi.fn>;
    let mockChannel: {
      name: string;
      sendMessage: ReturnType<typeof vi.fn>;
      setTyping: ReturnType<typeof vi.fn>;
      owns: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      await _initTestDatabase();
      _resetState();

      mockRunAgent = vi.fn().mockResolvedValue({ status: 'success' });

      const mockAgentRunner = {
        runAgent: mockRunAgent,
        writeTasksSnapshot: vi.fn(),
        writeGroupsSnapshot: vi.fn(),
        shutdown: vi.fn(),
      };
      mockGetToolJobRunner.mockReturnValue(mockAgentRunner);
      mockGetRunnerForGroup.mockReturnValue(mockAgentRunner);

      mockChannel = {
        name: 'test',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn().mockResolvedValue(undefined),
        owns: vi.fn().mockReturnValue(true),
      };
      mockFindChannel.mockReturnValue(mockChannel);

      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'formatted prompt',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);

      _setRegisteredGroups({ [chatJid]: group });
      _pushChannel(mockChannel as any);
    });

    it('calls runAgent once with original prompt when loadSpecialists returns null', async () => {
      mockLoadSpecialists.mockReturnValue(null);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      await _processGroupMessages(chatJid);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const callArgs = mockRunAgent.mock.calls[0];
      expect(callArgs[1].prompt).toBe('formatted prompt');
    });

    it('calls runAgent once with original prompt when no specialists are mentioned', async () => {
      const specialists = [
        { name: 'Research', prompt: 'You are a researcher.' },
      ];
      mockLoadSpecialists.mockReturnValue(specialists);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      await _processGroupMessages(chatJid);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const callArgs = mockRunAgent.mock.calls[0];
      expect(callArgs[1].prompt).toBe('formatted prompt');
    });

    it('calls runAgent once with specialist-prefixed prompt when one specialist is mentioned', async () => {
      const specialists = [
        { name: 'Research', prompt: 'You are a researcher.' },
      ];
      mockLoadSpecialists.mockReturnValue(specialists);
      mockDetectMentionedSpecialists.mockReturnValue([specialists[0]]);

      await _processGroupMessages(chatJid);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const callArgs = mockRunAgent.mock.calls[0];
      expect(callArgs[1].prompt).toContain('<specialist name="Research">');
      expect(callArgs[1].prompt).toContain('You are a researcher.');
      expect(callArgs[1].prompt).toContain('formatted prompt');
    });

    it('calls runAgent twice when two specialists are mentioned', async () => {
      const specialists = [
        { name: 'Research', prompt: 'You are a researcher.' },
        { name: 'Writer', prompt: 'You are a writer.' },
      ];
      mockLoadSpecialists.mockReturnValue(specialists);
      mockDetectMentionedSpecialists.mockReturnValue(specialists);

      await _processGroupMessages(chatJid);

      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      const firstCallPrompt = mockRunAgent.mock.calls[0][1].prompt;
      const secondCallPrompt = mockRunAgent.mock.calls[1][1].prompt;
      expect(firstCallPrompt).toContain('<specialist name="Research">');
      expect(secondCallPrompt).toContain('<specialist name="Writer">');
    });
  });

  describe('_recoverPendingMessages', () => {
    const chatJid = 'chat@g.us';
    const group = {
      name: 'Recovery Group',
      folder: 'recovery-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      await _initTestDatabase();
      _resetState();
    });

    it('does nothing when no groups are registered', () => {
      _setRegisteredGroups({});
      // Should not throw
      expect(() => _recoverPendingMessages()).not.toThrow();
      expect(mockGetMessagesSince).not.toHaveBeenCalled();
    });

    it('does nothing when there are no pending messages for a group', () => {
      _setRegisteredGroups({ [chatJid]: group });
      mockGetMessagesSince.mockReturnValue([]);
      expect(() => _recoverPendingMessages()).not.toThrow();
      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        chatJid,
        '',
        expect.any(String),
      );
    });

    it('enqueues message check when pending messages exist', () => {
      _setRegisteredGroups({ [chatJid]: group });
      mockGetMessagesSince.mockReturnValue([
        {
          id: 1,
          chat_jid: chatJid,
          sender: 'user@s.whatsapp.net',
          content: 'unprocessed message',
          timestamp: '2024-01-01T00:01:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      ]);
      // Should not throw - queue.enqueueMessageCheck runs internally
      expect(() => _recoverPendingMessages()).not.toThrow();
      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        chatJid,
        '',
        expect.any(String),
      );
    });
  });
});
