import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getAllSessions,
  getAllRegisteredGroups,
  getRouterState,
  setRouterState,
  setRegisteredGroup,
  _initTestDatabase,
} from './db.js';
import { _setRegisteredGroups, registerGroup } from './index.js';

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getRouterState: vi.fn(),
    setRouterState: vi.fn(),
    getAllSessions: vi.fn(),
    getAllRegisteredGroups: vi.fn(),
    setRegisteredGroup: vi.fn(),
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
});
