/**
 * Unit tests for the read_user_profile local tool handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mock db.js so the handler never touches SQLite ----
const mockGetGroupProfile = vi.hoisted(() => vi.fn());

vi.mock('../../db.js', () => ({
  getGroupProfile: mockGetGroupProfile,
}));

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// ---- Tests ----------------------------------------------------------------

describe('readUserProfileHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns serialised GroupProfile when a row exists', async () => {
    mockGetGroupProfile.mockReturnValue({
      groupFolder: 'alice-group',
      timezone: 'America/New_York',
      location: 'Brooklyn, NY',
      cuisineLikes: 'Japanese, Thai',
      cuisineDislikes: 'Liver',
      dietaryRestrictions: 'no shellfish',
      budgetTier: 'mid-range',
      updatedAt: '2026-05-28T10:00:00.000Z',
    });

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'alice-group',
        chatJid: 'alice@test',
        isMain: true,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    const parsed = JSON.parse(result);
    expect(parsed.groupFolder).toBe('alice-group');
    expect(parsed.timezone).toBe('America/New_York');
    expect(parsed.location).toBe('Brooklyn, NY');
    expect(parsed.cuisineLikes).toBe('Japanese, Thai');
    expect(parsed.budgetTier).toBe('mid-range');
    expect(mockGetGroupProfile).toHaveBeenCalledWith('alice-group');
  });

  it('returns "{}" when no profile row exists', async () => {
    mockGetGroupProfile.mockReturnValue(null);

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'unknown-group',
        chatJid: 'nobody@test',
        isMain: false,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{}');
    expect(mockGetGroupProfile).toHaveBeenCalledWith('unknown-group');
  });

  it('returns {"error":"profile_unavailable"} and logs error when getGroupProfile throws', async () => {
    mockGetGroupProfile.mockImplementation(() => {
      throw new Error('db not ready');
    });

    const { readUserProfileHandler } = await import('./read-user-profile.js');
    const { logger } = await import('../../logger.js');
    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: 'error-group',
        chatJid: 'x@test',
        isMain: false,
        prompt: '',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{"error":"profile_unavailable"}');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'error-group' }),
      expect.stringContaining('getGroupProfile threw'),
    );
  });
});
