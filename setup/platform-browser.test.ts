import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecSync, mockPlatform, mockReadFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockPlatform: vi.fn().mockReturnValue('linux'),
  mockReadFileSync: vi.fn().mockReturnValue('Linux'),
}));

vi.mock('child_process', () => ({ execSync: mockExecSync }));
vi.mock('os', () => ({ default: { platform: mockPlatform } }));
vi.mock('fs', () => ({ default: { readFileSync: mockReadFileSync } }));

import { openBrowser } from './platform.js';

describe('openBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to sensible defaults after each test clears mock state
    mockExecSync.mockReturnValue('');
    mockPlatform.mockReturnValue('linux');
    mockReadFileSync.mockReturnValue('Linux');
  });

  // --- unknown platform ---

  it('returns false on unknown platform', () => {
    mockPlatform.mockReturnValue('win32');
    expect(openBrowser('https://example.com')).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // --- macOS ---

  it('returns true on macOS via open command', () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecSync.mockReturnValue('');
    expect(openBrowser('https://example.com')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'open "https://example.com"',
      { stdio: 'ignore' },
    );
  });

  it('returns false on macOS when open command throws', () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecSync.mockImplementation(() => {
      throw new Error('open: not found');
    });
    expect(openBrowser('https://example.com')).toBe(false);
  });

  // --- Linux with xdg-open ---

  it('returns true on Linux when xdg-open is available', () => {
    mockPlatform.mockReturnValue('linux');
    // commandExists('xdg-open') -> execSync('command -v xdg-open') succeeds
    // then execSync('xdg-open "url"') succeeds
    mockExecSync.mockReturnValue('');
    expect(openBrowser('https://example.com')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'xdg-open "https://example.com"',
      { stdio: 'ignore' },
    );
  });

  it('passes the URL as a JSON-stringified argument', () => {
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue('');
    openBrowser('https://example.com/path?q=a b');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('"https://example.com/path?q=a b"'),
      expect.any(Object),
    );
  });

  // --- Linux WSL with wslview ---

  it('returns true on WSL with wslview when xdg-open is absent', () => {
    mockPlatform.mockReturnValue('linux');
    // /proc/version contains 'microsoft' -> isWSL() returns true
    mockReadFileSync.mockReturnValue('Linux version 5.15 microsoft WSL2');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('xdg-open')) throw new Error('not found');
      // command -v wslview and wslview itself both succeed
      return '';
    });
    expect(openBrowser('https://example.com')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'wslview "https://example.com"',
      { stdio: 'ignore' },
    );
  });

  // --- Linux WSL via cmd.exe fallback ---

  it('returns true on WSL via cmd.exe when xdg-open and wslview are absent', () => {
    mockPlatform.mockReturnValue('linux');
    mockReadFileSync.mockReturnValue('Linux version 5.15 microsoft WSL2');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('cmd.exe')) return ''; // cmd.exe succeeds
      throw new Error('not found');             // all command -v checks fail
    });
    expect(openBrowser('https://example.com')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('cmd.exe'),
      { stdio: 'ignore' },
    );
  });

  it('returns false on WSL when all methods fail', () => {
    mockPlatform.mockReturnValue('linux');
    mockReadFileSync.mockReturnValue('Linux version 5.15 microsoft WSL2');
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(openBrowser('https://example.com')).toBe(false);
  });

  // --- Linux non-WSL without xdg-open ---

  it('returns false on plain Linux without xdg-open', () => {
    mockPlatform.mockReturnValue('linux');
    // /proc/version has no WSL markers -> isWSL() returns false
    mockReadFileSync.mockReturnValue('Linux version 5.15 Ubuntu');
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(openBrowser('https://example.com')).toBe(false);
  });
});
