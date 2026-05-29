import { describe, it, expect } from 'vitest';
import { validateSpecialist, parseSpecialists } from './types.js';

describe('validateSpecialist', () => {
  it('accepts a minimal valid specialist', () => {
    expect(
      validateSpecialist({ name: 'CodeReview', prompt: 'be sharp' }),
    ).toEqual({ ok: true });
  });

  it('rejects empty name', () => {
    expect(validateSpecialist({ name: '', prompt: 'x' })).toEqual({
      ok: false,
      error: expect.stringContaining('name'),
    });
  });

  it('rejects name with disallowed characters', () => {
    expect(validateSpecialist({ name: 'Code Review', prompt: 'x' }).ok).toBe(
      false,
    );
    expect(validateSpecialist({ name: '1Bad', prompt: 'x' }).ok).toBe(false);
  });

  it('rejects empty prompt', () => {
    expect(validateSpecialist({ name: 'X', prompt: '' }).ok).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      validateSpecialist({ name: 'X', prompt: 'y', surprise: 1 } as any).ok,
    ).toBe(false);
  });

  it('accepts all optional fields with correct types', () => {
    const ok = validateSpecialist({
      name: 'Research',
      prompt: 'p',
      triggers: ['Researcher'],
      llmProvider: 'claude',
      memory: { isolated: true },
      claudemd: 'extra',
      tools: ['mcp:fetch'],
    });
    expect(ok).toEqual({ ok: true });
  });

  it('strips leading @ from trigger values (soft normalisation)', () => {
    const spec = {
      name: 'Research',
      prompt: 'p',
      triggers: ['@Researcher', '@Analysis', 'NoAt'],
    };
    const result = validateSpecialist(spec);
    expect(result).toEqual({ ok: true });
    // Normalisation mutates the triggers in-place
    expect(spec.triggers).toEqual(['Researcher', 'Analysis', 'NoAt']);
  });

  it('rejects memory with unknown subfields', () => {
    const r = validateSpecialist({
      name: 'X',
      prompt: 'p',
      memory: { isolated: true, surprise: 1 },
    } as any);
    expect(r.ok).toBe(false);
  });

  it('accepts maxToolRounds as a positive integer', () => {
    expect(
      validateSpecialist({ name: 'X', prompt: 'p', maxToolRounds: 3 }),
    ).toEqual({ ok: true });
  });

  it('accepts maxToolOutputBytes as a positive integer', () => {
    expect(
      validateSpecialist({ name: 'X', prompt: 'p', maxToolOutputBytes: 10000 }),
    ).toEqual({ ok: true });
  });

  it('rejects maxToolRounds that is zero', () => {
    const r = validateSpecialist({ name: 'X', prompt: 'p', maxToolRounds: 0 } as any);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/maxToolRounds/);
  });

  it('rejects maxToolRounds that is negative', () => {
    const r = validateSpecialist({ name: 'X', prompt: 'p', maxToolRounds: -1 } as any);
    expect(r.ok).toBe(false);
  });

  it('rejects maxToolRounds that is a float', () => {
    const r = validateSpecialist({ name: 'X', prompt: 'p', maxToolRounds: 2.5 } as any);
    expect(r.ok).toBe(false);
  });

  it('rejects maxToolOutputBytes that is zero', () => {
    const r = validateSpecialist({ name: 'X', prompt: 'p', maxToolOutputBytes: 0 } as any);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/maxToolOutputBytes/);
  });

  it('rejects unknown field that looks similar to a budget field', () => {
    const r = validateSpecialist({ name: 'X', prompt: 'p', maxRounds: 5 } as any);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('unknown field');
  });
});

describe('parseSpecialists', () => {
  it('parses the wire format', () => {
    const r = parseSpecialists(
      JSON.stringify({
        version: 1,
        generation: 1,
        specialists: [{ name: 'A', prompt: 'p' }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.specialists).toHaveLength(1);
  });

  it('rejects wire format with duplicate names', () => {
    const r = parseSpecialists(
      JSON.stringify({
        version: 1,
        generation: 1,
        specialists: [
          { name: 'A', prompt: 'p' },
          { name: 'A', prompt: 'q' },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects wrong version', () => {
    const r = parseSpecialists(
      JSON.stringify({ version: 2, generation: 1, specialists: [] }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('Researcher baseline specialist', () => {
  it('validateSpecialist accepts the full Researcher stanza', () => {
    const researcher = {
      name: 'Researcher',
      prompt:
        'You are a web-research specialist. When given a topic or question:\n' +
        '1. Search for relevant, current information using available search tools.\n' +
        '2. Fetch and read promising sources to gather details.\n' +
        '3. Synthesise findings into a concise, structured summary with:\n' +
        '   - A one-paragraph executive summary.\n' +
        '   - Key facts as a bulleted list.\n' +
        '   - Source URLs cited inline.\n' +
        'Stay factual; note when information is uncertain or conflicting.\n',
      triggers: ['researcher'],
      llmProvider: 'openrouter',
      memory: { isolated: false },
      tools: ['web_search', 'web_fetch'],
    };
    expect(validateSpecialist(researcher)).toEqual({ ok: true });
  });

  it('parseSpecialists accepts wire format containing the Researcher stanza', () => {
    const wire = JSON.stringify({
      version: 1,
      generation: 0,
      specialists: [
        {
          name: 'Researcher',
          prompt:
            'You are a web-research specialist. When given a topic or question:\n' +
            '1. Search for relevant, current information using available search tools.\n' +
            '2. Fetch and read promising sources to gather details.\n' +
            '3. Synthesise findings into a concise, structured summary with:\n' +
            '   - A one-paragraph executive summary.\n' +
            '   - Key facts as a bulleted list.\n' +
            '   - Source URLs cited inline.\n' +
            'Stay factual; note when information is uncertain or conflicting.\n',
          triggers: ['researcher'],
          llmProvider: 'openrouter',
          memory: { isolated: false },
          tools: ['web_search', 'web_fetch'],
        },
      ],
    });
    const result = parseSpecialists(wire);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.specialists).toHaveLength(1);
      expect(result.specialists[0].name).toBe('Researcher');
      expect(result.specialists[0].memory?.isolated).toBe(false);
      expect(result.specialists[0].tools).toEqual(['web_search', 'web_fetch']);
      expect(result.specialists[0].triggers).toEqual(['researcher']);
    }
  });
});
