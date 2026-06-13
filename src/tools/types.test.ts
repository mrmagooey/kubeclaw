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
    for (const n of [
      'bash',
      'web_search',
      'web_fetch',
      'browser',
      'places_search',
    ]) {
      expect(validateTool({ ...base, name: n }).ok).toBe(false);
    }
  });

  it('rejects the reserved built-in spawn category name "execution"', () => {
    expect(validateTool({ ...base, name: 'execution' }).ok).toBe(false);
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

  it('rejects a healthPath without a leading slash', () => {
    expect(validateTool({ ...base, healthPath: 'noslash' }).ok).toBe(false);
  });

  it('accepts a healthPath with a leading slash', () => {
    expect(validateTool({ ...base, healthPath: '/healthz' }).ok).toBe(true);
  });

  it('accepts empty channels (all channels)', () => {
    expect(validateTool({ ...base, channels: [] }).ok).toBe(true);
  });

  it('rejects port 0 and out-of-range ports', () => {
    expect(validateTool({ ...base, port: 0 }).ok).toBe(false);
    expect(validateTool({ ...base, port: 70000 }).ok).toBe(false);
  });

  it('accepts a valid port', () => {
    expect(validateTool({ ...base, port: 8080 }).ok).toBe(true);
  });

  it('rejects an invalid pullPolicy', () => {
    expect(validateTool({ ...base, pullPolicy: 'Sometimes' }).ok).toBe(false);
  });

  it('rejects an invalid acpMode', () => {
    expect(validateTool({ ...base, acpMode: 'streaming' }).ok).toBe(false);
  });

  it('rejects non-string command elements', () => {
    expect(validateTool({ ...base, command: ['ok', 5] }).ok).toBe(false);
  });
});

describe('validateTool — requestMapping', () => {
  const mapped = {
    ...base,
    requestMapping: {
      method: 'GET' as const,
      path: '/weather/{city}',
      query: { units: '{units}' },
      headers: { Accept: 'application/json' },
      responsePath: 'current.temp_c',
    },
  };

  it('accepts a valid http requestMapping', () => {
    expect(validateTool(mapped)).toEqual({ ok: true });
  });

  it('accepts a POST mapping with a body', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'POST', path: '/q', body: { q: '{query}' } },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects requestMapping on a file-pattern tool', () => {
    expect(
      validateTool({
        ...base,
        pattern: 'file',
        requestMapping: { method: 'GET', path: '/x' },
      }).ok,
    ).toBe(false);
  });

  it('rejects requestMapping on an acp-pattern tool', () => {
    expect(
      validateTool({
        ...base,
        pattern: 'acp',
        requestMapping: { method: 'GET', path: '/x' },
      }).ok,
    ).toBe(false);
  });

  it('rejects an invalid method', () => {
    expect(
      validateTool({ ...base, requestMapping: { method: 'FETCH', path: '/x' } })
        .ok,
    ).toBe(false);
  });

  it('rejects a path without a leading slash', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'GET', path: 'weather' },
      }).ok,
    ).toBe(false);
  });

  it('rejects a missing method', () => {
    expect(validateTool({ ...base, requestMapping: { path: '/x' } }).ok).toBe(
      false,
    );
  });

  it('rejects non-string query values', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'GET', path: '/x', query: { n: 5 } },
      }).ok,
    ).toBe(false);
  });

  it('rejects non-string header values', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'GET', path: '/x', headers: { A: 1 } },
      }).ok,
    ).toBe(false);
  });

  it('rejects a non-string responsePath', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'GET', path: '/x', responsePath: 5 },
      }).ok,
    ).toBe(false);
  });

  it('rejects an unknown requestMapping key', () => {
    expect(
      validateTool({
        ...base,
        requestMapping: { method: 'GET', path: '/x', bogus: 1 },
      }).ok,
    ).toBe(false);
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
