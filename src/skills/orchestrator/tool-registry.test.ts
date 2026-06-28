import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../../db.js';
import {
  registerTool,
  editTool,
  removeTool,
  listToolOverrides,
} from './tool-registry.js';

const base = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: {} },
  image: 'ghcr.io/example/weather:1',
  pattern: 'http' as const,
};

describe('tool-registry', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('registers and lists a tool', () => {
    expect(registerTool(base).ok).toBe(true);
    const all = listToolOverrides();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('weather');
  });

  it('rejects an invalid tool', () => {
    const r = registerTool({ ...base, pattern: 'grpc' } as never);
    expect(r.ok).toBe(false);
  });

  it('rejects a duplicate name', () => {
    registerTool(base);
    expect(registerTool(base).ok).toBe(false);
  });

  it('edits an existing tool (partial patch)', () => {
    registerTool(base);
    const r = editTool({ name: 'weather', patch: { image: 'newimg:2' } });
    expect(r.ok).toBe(true);
    expect(listToolOverrides()[0].image).toBe('newimg:2');
  });

  it('rejects an edit that produces an invalid spec', () => {
    registerTool(base);
    const r = editTool({
      name: 'weather',
      patch: { pattern: 'grpc' as never },
    });
    expect(r.ok).toBe(false);
  });

  it('errors editing a missing tool', () => {
    expect(editTool({ name: 'nope', patch: {} }).ok).toBe(false);
  });

  it('removes a tool', () => {
    registerTool(base);
    expect(removeTool({ name: 'weather' }).ok).toBe(true);
    expect(listToolOverrides()).toHaveLength(0);
  });

  it('errors removing a missing tool', () => {
    expect(removeTool({ name: 'nope' }).ok).toBe(false);
  });

  it('runs the reconcile callback after a mutation', async () => {
    let called = 0;
    registerTool(base, async () => {
      called += 1;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(1);
  });
});

const lookup = (id: string) =>
  id === 'brave-search' ? 'api.search.brave.com' : undefined;

describe('registerTool coherence', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('rejects a credentialed tool whose egress escapes the credential host', () => {
    const spec = {
      name: 'leaky',
      description: 'd',
      parameters: { type: 'object' },
      image: 'i',
      pattern: 'http' as const,
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'evil.example.com' }],
    };
    const r = registerTool(spec, undefined, lookup);
    expect(r.ok).toBe(false);
  });

  it('accepts a coherent credentialed tool', () => {
    const spec = {
      name: 'ok_tool',
      description: 'd',
      parameters: { type: 'object' },
      image: 'i',
      pattern: 'http' as const,
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(registerTool(spec, undefined, lookup).ok).toBe(true);
  });

  it('rejects an edit that makes a credentialed tool incoherent', () => {
    const spec = {
      name: 'edit_me',
      description: 'd',
      parameters: { type: 'object' },
      image: 'i',
      pattern: 'http' as const,
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(registerTool(spec, undefined, lookup).ok).toBe(true);
    const r = editTool(
      {
        name: 'edit_me',
        patch: { allowedEgress: [{ host: 'evil.example.com' }] },
      },
      undefined,
      lookup,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a coherent edit', () => {
    const spec = {
      name: 'edit_ok',
      description: 'd',
      parameters: { type: 'object' },
      image: 'i',
      pattern: 'http' as const,
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(registerTool(spec, undefined, lookup).ok).toBe(true);
    const r = editTool(
      {
        name: 'edit_ok',
        patch: {
          allowedEgress: [{ host: 'api.search.brave.com', ports: [80, 443] }],
        },
      },
      undefined,
      lookup,
    );
    expect(r.ok).toBe(true);
  });
});
