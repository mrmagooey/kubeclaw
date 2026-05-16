import { describe, it, expect, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import { folderPrefixForChannel, dispatchSkillsCommandIfApplicable } from './channel-runner.js';

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

describe('runAgent — /skills intercept', () => {
  it('dispatches /skills commands without invoking the LLM runner', async () => {
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      '/skills list',
      'jid1',
      async (o: any) => {
        outputs.push(o.result ?? o.message ?? o.text ?? o.raw ?? '');
      },
    );
    expect(handled).toBe(true);
    expect(outputs.join('\n')).toMatch(/no skills/i);
  });

  it('returns false (and does not output) for non-/skills prompts', async () => {
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      'hello',
      'jid1',
      async (o: any) => {
        outputs.push(o.result ?? o.message ?? o.text ?? o.raw ?? '');
      },
    );
    expect(handled).toBe(false);
    expect(outputs).toEqual([]);
  });
});
