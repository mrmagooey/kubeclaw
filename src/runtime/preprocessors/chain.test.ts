import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runPreprocessorChain } from './chain.js';
import type { InboundPreprocessor } from './types.js';

const transform = (
  name: string,
  fn: (p: string) => string,
): InboundPreprocessor => ({
  name,
  effect: 'transform',
  async apply({ prompt }) {
    const out = fn(prompt);
    return { prompt: out, persistedContent: out };
  },
});

const augment = (
  name: string,
  fn: (p: string) => string,
): InboundPreprocessor => ({
  name,
  effect: 'augment',
  async apply({ prompt }) {
    return { prompt: fn(prompt) };
  },
});

describe('runPreprocessorChain', () => {
  it('is an identity for the empty chain', async () => {
    const out = await runPreprocessorChain([], 'g', 'hello');
    expect(out.prompt).toBe('hello');
    expect(out.persistedContent).toBe('hello');
  });

  it('runs transforms before augmenters regardless of registration order', async () => {
    const calls: string[] = [];
    const a = augment('aug', (p) => {
      calls.push('aug');
      return `AUG(${p})`;
    });
    const t = transform('xform', (p) => {
      calls.push('xform');
      return `T(${p})`;
    });
    const out = await runPreprocessorChain([a, t], 'g', 'x');
    expect(calls).toEqual(['xform', 'aug']);
    expect(out.prompt).toBe('AUG(T(x))');
  });

  it('persistedContent is post-transform, pre-augment', async () => {
    const t = transform('xform', (p) => `T(${p})`);
    const a = augment('aug', (p) => `AUG(${p})`);
    const out = await runPreprocessorChain([t, a], 'g', 'x');
    expect(out.prompt).toBe('AUG(T(x))');
    expect(out.persistedContent).toBe('T(x)');
  });

  it('augmenters retrieve against the transformed text', async () => {
    let seenByAugmenter = '';
    const t = transform('xform', () => 'TRANSCRIPT');
    const a: InboundPreprocessor = {
      name: 'aug',
      effect: 'augment',
      async apply({ prompt }) {
        seenByAugmenter = prompt;
        return { prompt: `CTX\n${prompt}` };
      },
    };
    await runPreprocessorChain([t, a], 'g', '[VoiceAttachment: attachments/raw/a.ogg]');
    expect(seenByAugmenter).toBe('TRANSCRIPT');
  });

  it('chains multiple transforms, each feeding the next', async () => {
    const t1 = transform('t1', (p) => `${p}-1`);
    const t2 = transform('t2', (p) => `${p}-2`);
    const out = await runPreprocessorChain([t1, t2], 'g', 'base');
    expect(out.prompt).toBe('base-1-2');
    expect(out.persistedContent).toBe('base-1-2');
  });

  it('ignores persistedContent set by an augmenter', async () => {
    const a: InboundPreprocessor = {
      name: 'bad-aug',
      effect: 'augment',
      async apply({ prompt }) {
        return { prompt: `AUG(${prompt})`, persistedContent: 'SHOULD_BE_IGNORED' };
      },
    };
    const out = await runPreprocessorChain([a], 'g', 'x');
    expect(out.prompt).toBe('AUG(x)');
    expect(out.persistedContent).toBe('x');
  });

  it('is non-fatal: a throwing transform is skipped and the chain continues', async () => {
    const boom: InboundPreprocessor = {
      name: 'boom',
      effect: 'transform',
      async apply() {
        throw new Error('kaboom');
      },
    };
    const a = augment('aug', (p) => `AUG(${p})`);
    const out = await runPreprocessorChain([boom, a], 'g', 'x');
    expect(out.prompt).toBe('AUG(x)');
    expect(out.persistedContent).toBe('x');
  });

  it('is non-fatal: a throwing augmenter leaves the running prompt unchanged', async () => {
    const t = transform('xform', (p) => `T(${p})`);
    const boom: InboundPreprocessor = {
      name: 'boom',
      effect: 'augment',
      async apply() {
        throw new Error('kaboom');
      },
    };
    const out = await runPreprocessorChain([t, boom], 'g', 'x');
    expect(out.prompt).toBe('T(x)');
    expect(out.persistedContent).toBe('T(x)');
  });
});
