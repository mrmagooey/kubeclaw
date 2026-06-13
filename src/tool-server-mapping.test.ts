/**
 * Unit tests for the request-mapping helpers in tool-server.ts.
 * Mirrors src/tool-server-bridge.test.ts: env set via vi.hoisted, redis mocked,
 * before importing the module (it reads env at load and starts main()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'weather';
  process.env.REDIS_URL = 'redis://localhost:6379';
});

vi.mock('redis', () => {
  const mockRedis = {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    // Intentionally omit xRead: main()'s xRead call throws TypeError, which its
    // catch block absorbs with a 1s sleep; assertions complete before this matters.
    xAdd: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  return { createClient: vi.fn(() => mockRedis) };
});

import {
  buildMappedRequest,
  extractResponsePath,
  executeToolBridgeHttp,
} from '../container/agent-runner/src/tool-server.js';

describe('buildMappedRequest', () => {
  it('substitutes path tokens (URL-encoded) and builds the localhost URL', () => {
    const r = buildMappedRequest(
      { method: 'GET', path: '/weather/{city}' },
      { city: 'São Paulo' },
      8080,
    );
    expect(r.method).toBe('GET');
    expect(r.url).toBe('http://localhost:8080/weather/S%C3%A3o%20Paulo');
    expect(r.body).toBeUndefined();
  });

  it('encodes query params from fields and literals', () => {
    const r = buildMappedRequest(
      { method: 'GET', path: '/w', query: { q: '{city}', units: 'metric' } },
      { city: 'a b' },
      8080,
    );
    // order-independent assertion
    const u = new URL(r.url);
    expect(u.pathname).toBe('/w');
    expect(u.searchParams.get('q')).toBe('a b');
    expect(u.searchParams.get('units')).toBe('metric');
  });

  it('substitutes header tokens and strips newlines', () => {
    const r = buildMappedRequest(
      {
        method: 'GET',
        path: '/x',
        headers: { 'X-City': '{city}', Accept: 'application/json' },
      },
      { city: 'NYC\r\nX-Injected: evil' },
      8080,
    );
    expect(r.headers['Accept']).toBe('application/json');
    expect(r.headers['X-City']).toBe('NYCX-Injected: evil'); // CR/LF stripped
  });

  it('preserves JSON type for a body leaf that is exactly "{field}"', () => {
    const r = buildMappedRequest(
      {
        method: 'POST',
        path: '/q',
        body: { n: '{count}', label: 'x', nested: { v: '{flag}' } },
      },
      { count: 42, flag: true },
      8080,
    );
    const parsed = JSON.parse(r.body!);
    expect(parsed).toEqual({ n: 42, label: 'x', nested: { v: true } });
    expect(r.headers['Content-Type']).toBe('application/json');
  });

  it('string-interpolates a body leaf that embeds a token in a larger string', () => {
    const r = buildMappedRequest(
      { method: 'POST', path: '/q', body: { greeting: 'hello {name}' } },
      { name: 'Sam' },
      8080,
    );
    expect(JSON.parse(r.body!)).toEqual({ greeting: 'hello Sam' });
  });

  it('throws when a referenced field is missing from input', () => {
    expect(() =>
      buildMappedRequest({ method: 'GET', path: '/weather/{city}' }, {}, 8080),
    ).toThrow(/missing field "city"/);
  });

  it('defaults Accept: application/json', () => {
    const r = buildMappedRequest({ method: 'GET', path: '/x' }, {}, 8080);
    expect(r.headers['Accept']).toBe('application/json');
  });
});

describe('extractResponsePath', () => {
  it('extracts a top-level field', () => {
    expect(extractResponsePath('{"temp":21}', 'temp')).toBe('21');
  });

  it('extracts a nested field', () => {
    expect(
      extractResponsePath('{"current":{"temp_c":21.5}}', 'current.temp_c'),
    ).toBe('21.5');
  });

  it('returns a JSON string for an extracted object/array subtree', () => {
    expect(extractResponsePath('{"a":{"b":[1,2]}}', 'a.b')).toBe('[1,2]');
  });

  it('throws when the path is not found', () => {
    expect(() => extractResponsePath('{"a":1}', 'b.c')).toThrow(
      /responsePath "b.c"/,
    );
  });

  it('throws when the body is not JSON', () => {
    expect(() => extractResponsePath('not json', 'a')).toThrow(/not JSON/);
  });

  it('throws on an inherited-property path segment (no prototype traversal)', () => {
    expect(() =>
      extractResponsePath('{"a":1}', '__proto__.constructor'),
    ).toThrow(/responsePath "__proto__\.constructor"/);
  });
});

describe('executeToolBridgeHttp — mapped mode', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KUBECLAW_TOOL_REQUEST_MAPPING;
  });

  it('builds a GET from the mapping and returns the raw body when no responsePath', async () => {
    process.env.KUBECLAW_TOOL_REQUEST_MAPPING = JSON.stringify({
      method: 'GET',
      path: '/weather/{city}',
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:8080/weather/NYC');
      return new Response('{"temp":21}', { status: 200 });
    });
    // ready probe also calls fetch; make the probe (path '/') succeed too:
    vi.stubGlobal('fetch', fetchMock);
    const out = await executeToolBridgeHttp('weather', { city: 'NYC' });
    expect(out).toBe('{"temp":21}');
  });

  it('extracts responsePath when set', async () => {
    process.env.KUBECLAW_TOOL_REQUEST_MAPPING = JSON.stringify({
      method: 'GET',
      path: '/w',
      responsePath: 'current.temp_c',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"current":{"temp_c":21.5}}', { status: 200 }),
      ),
    );
    const out = await executeToolBridgeHttp('weather', {});
    expect(out).toBe('21.5');
  });

  it('still uses /invoke when no mapping env is set', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:8080/invoke');
      return new Response('{"result":"ok"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await executeToolBridgeHttp('weather', { city: 'NYC' });
    expect(out).toBe('ok');
  });
});
