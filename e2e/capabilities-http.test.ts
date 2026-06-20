/**
 * E2E tests for GET /capabilities HTTP endpoint (Story 70).
 *
 * Namespace: kubeclaw-e2e-capabilities-http
 * Port: 14153
 *
 * Spins up a real HttpChannel against an in-process server, stubs
 * getCapabilities to return known data, and exercises the endpoint
 * via HTTP.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { makeHttpChannel, type HttpChannelOpts, type CapabilityEntry } from './lib/http-test-channel.js';

const HTTP_PORT = 14153;
const TEST_USER = 'alice';
const TEST_PASS = 'e2epass';
const TEST_JID = `http:${TEST_USER}`;

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function makeCapabilities(overrides?: CapabilityEntry[]): CapabilityEntry[] {
  return overrides ?? [
    {
      type: 'memory',
      state: 'running',
      provisioned_at: '2024-06-01T10:00:00.000Z',
      scale: 1,
    },
    {
      type: 'rag',
      state: 'scaled_down',
      provisioned_at: '2024-06-02T12:00:00.000Z',
      scale: 0,
    },
  ];
}

describe('GET /capabilities — E2E (Story 70)', () => {
  let channel: ReturnType<typeof makeHttpChannel> | null = null;
  let stubbedCapabilities: CapabilityEntry[] = makeCapabilities();

  function createOpts(): HttpChannelOpts {
    return {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [TEST_JID]: {
          name: 'Alice E2E',
          folder: 'http-alice-cap',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
      getCapabilities: (_groupFolder: string) => stubbedCapabilities,
    };
  }

  beforeAll(async () => {
    const config = {
      port: HTTP_PORT,
      users: { [TEST_USER]: TEST_PASS },
      perUserMessagesPerMinute: 0,
      corsOrigin: '*',
    };
    channel = makeHttpChannel(config, createOpts());
    await channel.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  beforeEach(() => {
    stubbedCapabilities = makeCapabilities();
  });

  // AC1: authenticated GET → 200 + application/json
  it('AC1: authenticated GET returns 200 with Content-Type application/json', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  // AC1: response is an array with correct fields
  it('AC1: response body is a JSON array with type/state/provisioned_at/scale fields', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const body = (await res.json()) as CapabilityEntry[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    for (const entry of body) {
      expect(typeof entry.type).toBe('string');
      expect(['running', 'scaled_down']).toContain(entry.state);
      expect(typeof entry.provisioned_at).toBe('string');
      expect(typeof entry.scale).toBe('number');
    }
  });

  // AC2: empty array when none provisioned
  it('AC2: returns empty array when no capabilities are provisioned', async () => {
    stubbedCapabilities = [];
    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  // AC3: unauthenticated → 401
  it('AC3: unauthenticated request returns 401', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`);
    expect(res.status).toBe(401);
  });

  // AC4: POST → 405 with Allow: GET, HEAD
  it('AC4: POST /capabilities returns 405 with Allow: GET, HEAD', async () => {
    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(TEST_USER, TEST_PASS),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  // AC4: HEAD → same headers as GET, no body
  it('AC4: HEAD /capabilities returns 200 with same headers as GET, no body', async () => {
    const getRes = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    const headRes = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      method: 'HEAD',
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });

    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toBe(
      getRes.headers.get('content-type'),
    );
    // HEAD response must have no body
    const text = await headRes.text();
    expect(text).toBe('');
  });

  // AC5: stub with 2 entries, assert both present in JSON
  it('AC5: stub with 2 entries — JSON contains both types', async () => {
    stubbedCapabilities = [
      {
        type: 'memory',
        state: 'running',
        provisioned_at: '2024-06-01T10:00:00.000Z',
        scale: 1,
      },
      {
        type: 'rag',
        state: 'scaled_down',
        provisioned_at: '2024-06-02T12:00:00.000Z',
        scale: 0,
      },
    ];

    const res = await fetch(`http://localhost:${HTTP_PORT}/capabilities`, {
      headers: { Authorization: basicAuth(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CapabilityEntry[];
    const types = body.map((e) => e.type);
    expect(types).toContain('memory');
    expect(types).toContain('rag');
  });
});
