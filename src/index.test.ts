import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getAllSessions,
  getAllRegisteredGroups,
  getRouterState,
  setRouterState,
  setRegisteredGroup,
  _initTestDatabase,
  getAllChats,
} from './db.js';
import {
  _setRegisteredGroups,
  _pushChannel,
  _resetState,
  registerGroup,
  getAvailableGroups,
} from './index.js';

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
    fatal: vi.fn(),
  },
}));

// specialists.js mock removed — specialists are no longer used in index.ts (dispatch moved to channel-runner)

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

vi.mock('./capabilities/index.js', () => ({
  installCapability: vi.fn().mockResolvedValue(undefined),
  startCapabilitySubsystem: vi.fn().mockResolvedValue(undefined),
  startDiscoveryWatcher: vi.fn(),
  stopDiscoveryWatcher: vi.fn(),
  startHealthProbes: vi.fn(),
}));

const mockGetAllChats = getAllChats as ReturnType<typeof vi.fn>;
const mockGetRouterState = getRouterState as ReturnType<typeof vi.fn>;
const mockSetRouterState = setRouterState as ReturnType<typeof vi.fn>;
const mockGetAllSessions = getAllSessions as ReturnType<typeof vi.fn>;
const mockGetAllRegisteredGroups = getAllRegisteredGroups as ReturnType<
  typeof vi.fn
>;
const mockSetRegisteredGroup = setRegisteredGroup as ReturnType<typeof vi.fn>;
const mockFs = await import('fs');

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
});
