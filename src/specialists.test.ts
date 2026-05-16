import { describe, it, expect } from 'vitest';

import { detectMentionedSpecialists } from './specialists.js';
import type { GlobalSpecialist } from './specialists/types.js';

describe('detectMentionedSpecialists', () => {
  const available: GlobalSpecialist[] = [
    { name: 'Research', prompt: 'You are a researcher.' },
    { name: 'Writer', prompt: 'You are a writer.' },
    { name: 'Coder', prompt: 'You are a coder.' },
  ];

  it('returns empty array for empty prompt', () => {
    expect(detectMentionedSpecialists('', available)).toEqual([]);
  });

  it('returns empty array when mentioned name is not in available', () => {
    expect(
      detectMentionedSpecialists('Hey @Unknown help me', available),
    ).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const result = detectMentionedSpecialists(
      '@research do some analysis',
      available,
    );
    expect(result).toEqual([
      { name: 'Research', prompt: 'You are a researcher.' },
    ]);
  });

  it('returns matched specialists in mention order (first encountered)', () => {
    const result = detectMentionedSpecialists(
      '@Writer and @Research please help',
      available,
    );
    // Order follows mention order (Writer first, then Research)
    expect(result.map((s) => s.name)).toEqual(['Writer', 'Research']);
  });

  it('deduplicates repeated mentions of the same specialist', () => {
    const result = detectMentionedSpecialists(
      '@Research @research please help',
      available,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Research');
  });

  it('returns multiple different matched specialists', () => {
    const result = detectMentionedSpecialists(
      '@Research @Coder both help',
      available,
    );
    expect(result.map((s) => s.name)).toEqual(['Research', 'Coder']);
  });

  it('does not match partial word: @ResearchExtra does not match Research', () => {
    // /@(\w+)/g captures the full word "ResearchExtra", which doesn't match "research"
    const result = detectMentionedSpecialists(
      '@ResearchExtra please help',
      available,
    );
    expect(result).toEqual([]);
  });

  it('returns empty array when no @ mentions present', () => {
    expect(
      detectMentionedSpecialists('Just a regular message', available),
    ).toEqual([]);
  });

  it('matches via triggers alias', () => {
    const withTriggers: GlobalSpecialist[] = [
      { name: 'Research', prompt: 'p', triggers: ['researcher', 'analyst'] },
    ];
    const result = detectMentionedSpecialists('@analyst please', withTriggers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Research');
  });
});
