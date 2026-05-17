import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
} from './token-estimate.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up for strings not divisible by 4', () => {
    // 'hello' = 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('returns exact division when divisible', () => {
    // 'abcd' = 4 chars → 1
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('handles a realistic message', () => {
    const msg = 'The quick brown fox jumps over the lazy dog.'; // 44 chars → 11
    expect(estimateTokens(msg)).toBe(11);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums tokens across all messages including role label overhead', () => {
    const msgs = [
      { role: 'user' as const, content: 'Hi' },       // 'user' (4) + 'Hi' (2) = 6 chars → 2
      { role: 'assistant' as const, content: 'Hello!' }, // 'assistant' (9) + 'Hello!' (6) = 15 chars → 4
    ];
    // total chars = 6 + 15 = 21 → ceil(21/4) = 6
    expect(estimateMessagesTokens(msgs)).toBe(6);
  });

  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
