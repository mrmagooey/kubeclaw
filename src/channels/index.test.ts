import { describe, it, vi } from 'vitest';

// Mock channel modules so importing channels/index.ts doesn't require their dependencies
vi.mock('./irc.js', () => ({}));
vi.mock('./http.js', () => ({}));

describe('channels/index barrel', () => {
  it('imports without error', async () => {
    // This import covers the barrel file's import './irc.js' statement
    await import('./index.js');
  });
});
