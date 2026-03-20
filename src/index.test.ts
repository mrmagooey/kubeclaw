import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getAllSessions,
  getAllRegisteredGroups,
  getRouterState,
  setRouterState,
  setRegisteredGroup,
  _initTestDatabase,
} from './db.js';
import {
  _setRegisteredGroups,
  _processGroupMessages,
  _pushChannel,
  _resetState,
  registerGroup,
} from './index.js';
import { getAgentRunner } from './runtime/index.js';
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

vi.mock('./runtime/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getAgentRunner: vi.fn(),
  };
});

const mockGetRouterState = getRouterState as ReturnType<typeof vi.fn>;
const mockSetRouterState = setRouterState as ReturnType<typeof vi.fn>;
const mockGetAllSessions = getAllSessions as ReturnType<typeof vi.fn>;
const mockGetAllRegisteredGroups = getAllRegisteredGroups as ReturnType<
  typeof vi.fn
>;
const mockSetRegisteredGroup = setRegisteredGroup as ReturnType<typeof vi.fn>;
const mockFs = await import('fs');
const mockGetAgentRunner = getAgentRunner as ReturnType<typeof vi.fn>;
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
      mockGetAgentRunner.mockReturnValue(mockAgentRunner);

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
      const specialists = [{ name: 'Research', prompt: 'You are a researcher.' }];
      mockLoadSpecialists.mockReturnValue(specialists);
      mockDetectMentionedSpecialists.mockReturnValue([]);

      await _processGroupMessages(chatJid);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const callArgs = mockRunAgent.mock.calls[0];
      expect(callArgs[1].prompt).toBe('formatted prompt');
    });

    it('calls runAgent once with specialist-prefixed prompt when one specialist is mentioned', async () => {
      const specialists = [{ name: 'Research', prompt: 'You are a researcher.' }];
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
});
