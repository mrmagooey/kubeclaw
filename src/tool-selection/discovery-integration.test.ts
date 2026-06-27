import { describe, it, expect, beforeEach } from 'vitest';
import { runToolSelection, type TsaDeps } from './agent.js';
import { buildTsaSearchRegistry } from './discovery.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';

describe('discovery integration', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('without hard enforcement, tier-3 is skipped and result is unavailable', async () => {
    const searchRegistry = buildTsaSearchRegistry(
      { CREDENTIAL_INJECTION_MODE: 'sidecar' }, // non-enforcing env
      {
        fetchJson: async () => ({
          results: [{ repo_name: 'x/y', star_count: 1 }],
        }),
        chat: async () => '{}',
        probe: { runProbeToolJob: async () => ({ ok: true, output: 'x' }) },
        catalogHostLookup: () => undefined,
      },
    );
    // The gate is closed → searchRegistry must be undefined.
    expect(searchRegistry).toBeUndefined();

    const deps: TsaDeps = {
      chat: async () =>
        JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
      liveCatalog: () => [],
      library: () => [],
      catalogHostLookup: () => undefined,
      reconcile: async () => {},
      now: () => 1,
      nonce: 'n',
      searchRegistry, // undefined
    };
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'anything',
      },
      deps,
    );
    expect(r.status).toBe('unavailable');
  });

  it('with hard enforcement (Cilium), tier-3 is enabled', async () => {
    const searchRegistry = buildTsaSearchRegistry(
      { CILIUM_NETWORK_POLICY_ENABLED: 'true' }, // enforcing env
      {
        fetchJson: async () => ({
          results: [{ repo_name: 'x/y', star_count: 1 }],
        }),
        chat: async () => '{}',
        probe: { runProbeToolJob: async () => ({ ok: true, output: 'x' }) },
        catalogHostLookup: () => undefined,
      },
    );
    // The gate is open → searchRegistry must be defined.
    expect(searchRegistry).toBeDefined();
    expect(typeof searchRegistry).toBe('function');
  });
});
