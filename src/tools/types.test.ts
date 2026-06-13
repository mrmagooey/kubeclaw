import { describe, it, expect } from 'vitest';
import { validateTool, parseToolCatalog } from './types.js';

const base = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: {} },
  image: 'ghcr.io/example/weather:1',
  pattern: 'http' as const,
};

describe('validateTool', () => {
  it('accepts a minimal valid tool', () => {
    expect(validateTool(base)).toEqual({ ok: true });
  });

  it('accepts channels as a string array', () => {
    expect(validateTool({ ...base, channels: ['telegram', 'http'] })).toEqual({
      ok: true,
    });
  });

  it('rejects a non-object', () => {
    expect(validateTool(null).ok).toBe(false);
  });

  it('rejects an unknown field', () => {
    const r = validateTool({ ...base, bogus: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid name', () => {
    expect(validateTool({ ...base, name: '1bad' }).ok).toBe(false);
    expect(validateTool({ ...base, name: 'has space' }).ok).toBe(false);
  });

  it('rejects a name that collides with a static built-in', () => {
    for (const n of ['bash', 'web_search', 'web_fetch', 'browser', 'places_search']) {
      expect(validateTool({ ...base, name: n }).ok).toBe(false);
    }
  });

  it('requires image', () => {
    const { image, ...noImage } = base;
    expect(validateTool(noImage).ok).toBe(false);
  });

  it('requires a valid pattern', () => {
    expect(validateTool({ ...base, pattern: 'grpc' }).ok).toBe(false);
  });

  it('rejects channels that are not strings', () => {
    expect(validateTool({ ...base, channels: [1, 2] }).ok).toBe(false);
  });
});

describe('parseToolCatalog', () => {
  it('parses a valid wire object', () => {
    const json = JSON.stringify({ version: 1, generation: 3, tools: [base] });
    const r = parseToolCatalog(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.generation).toBe(3);
      expect(r.tools).toHaveLength(1);
    }
  });

  it('rejects a wrong version', () => {
    const json = JSON.stringify({ version: 2, generation: 0, tools: [] });
    expect(parseToolCatalog(json).ok).toBe(false);
  });

  it('rejects duplicate names', () => {
    const json = JSON.stringify({
      version: 1,
      generation: 0,
      tools: [base, { ...base, image: 'other:1' }],
    });
    expect(parseToolCatalog(json).ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseToolCatalog('{not json').ok).toBe(false);
  });
});
