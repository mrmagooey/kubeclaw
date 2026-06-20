import { describe, it } from 'vitest';

describe('channels/index barrel', () => {
  it('imports without error', async () => {
    // No compiled-in channels remain; the barrel file is a no-op stub.
    await import('./index.js');
  });
});
