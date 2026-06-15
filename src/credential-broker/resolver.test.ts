import { describe, it, expect, vi } from 'vitest';
import { Resolver, type Mapping } from './resolver.js';
import { K8sSecretSource } from './k8s-secret-source.js';

const mappings: Mapping[] = [
  {
    id: 'anthropic',
    destinations: ['api.anthropic.com'],
    identities: ['*'],
    credentialRef: {
      kind: 'Secret',
      name: 'kubeclaw-secrets',
      key: 'anthropic-api-key',
    },
    headerScheme: 'bearer',
  },
  {
    id: 'telegram',
    destinations: ['api.telegram.org'],
    identities: ['sa/kubeclaw-channel-telegram'],
    credentialRef: {
      kind: 'Secret',
      name: 'kubeclaw-secrets',
      key: 'telegram-bot-token',
    },
    headerScheme: 'bearer',
  },
];

function makeNoopSrc(): K8sSecretSource {
  return new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
}

describe('Resolver', () => {
  const r = new Resolver({
    mappings,
    catalog: [],
    groupSource: makeNoopSrc(),
    operatorSecretReader: vi.fn(),
  });

  it('matches wildcard identity for anthropic', () => {
    const m = r.find({
      destination: 'api.anthropic.com',
      identity: 'sa/kubeclaw-tool-job',
    });
    expect(m?.id).toBe('anthropic');
  });

  it('matches specific identity for telegram', () => {
    const m = r.find({
      destination: 'api.telegram.org',
      identity: 'sa/kubeclaw-channel-telegram',
    });
    expect(m?.id).toBe('telegram');
  });

  it('rejects telegram for wrong identity', () => {
    const m = r.find({
      destination: 'api.telegram.org',
      identity: 'sa/kubeclaw-channel-discord',
    });
    expect(m).toBeUndefined();
  });

  it('rejects unknown destination', () => {
    const m = r.find({
      destination: 'evil.example',
      identity: 'sa/kubeclaw-tool-job',
    });
    expect(m).toBeUndefined();
  });

  it('formats bearer header', () => {
    expect(r.formatHeader('bearer', 'sk-foo')).toBe('Bearer sk-foo');
  });

  it('matches second entry in multi-destination mapping', () => {
    const multi = new Resolver({
      mappings: [
        {
          id: 'multi',
          destinations: ['api.first.com', 'api.second.com'],
          identities: ['*'],
          credentialRef: {
            kind: 'Secret',
            name: 'kubeclaw-secrets',
            key: 'shared',
          },
          headerScheme: 'bearer',
        },
      ],
      catalog: [],
      groupSource: makeNoopSrc(),
      operatorSecretReader: vi.fn(),
    });
    expect(
      multi.find({ destination: 'api.first.com', identity: 'sa/x' })?.id,
    ).toBe('multi');
    expect(
      multi.find({ destination: 'api.second.com', identity: 'sa/x' })?.id,
    ).toBe('multi');
    expect(
      multi.find({ destination: 'api.third.com', identity: 'sa/x' })?.id,
    ).toBeUndefined();
  });
});

describe('Resolver — substitution map', () => {
  function makeSrc(): K8sSecretSource {
    return new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  }

  it('returns per-group placeholder pairs', () => {
    const src = makeSrc();
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { 'kubeclaw.io/group-secrets': 'true' },
        },
        data: {
          jenkins: Buffer.from(
            JSON.stringify({
              fields: {
                user: { value: 'alice', placeholder: 'KC_PH_user_aaaa' },
                password: {
                  value: 'hunter2',
                  placeholder: 'KC_PH_password_bbbb',
                },
              },
              registeredAt: '2026-05-16T00:00:00Z',
            }),
          ).toString('base64'),
        },
      },
    });
    const r = new Resolver({
      mappings: [],
      catalog: [
        {
          id: 'jenkins',
          host: 'jenkins.example.com',
          upstreamPort: 443,
          credentialFields: [
            { name: 'user', envVar: 'JENKINS_USER' },
            { name: 'password', envVar: 'JENKINS_PASSWORD' },
          ],
          baseUrlEnvs: {},
          allowOperatorFallback: false,
          allowedPositions: ['header', 'body'],
        },
      ],
      groupSource: src,
      operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'family',
      host: 'jenkins.example.com',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('narrowing');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_user_aaaa', value: 'alice' },
      { placeholder: 'KC_PH_password_bbbb', value: 'hunter2' },
    ]);
    expect(result.keySource).toBe('groupSecret');
  });

  it('returns no_credential when no per-group key and no fallback', () => {
    const src = makeSrc();
    const r = new Resolver({
      mappings: [],
      catalog: [
        {
          id: 'replicate',
          host: 'api.replicate.com',
          upstreamPort: 443,
          credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
          baseUrlEnvs: {},
          allowOperatorFallback: false,
          allowedPositions: ['header', 'body'],
        },
      ],
      groupSource: src,
      operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'family',
      host: 'api.replicate.com',
    });
    expect(result.status).toBe('no_credential');
  });

  it('operator-fallback uses sentinel paired with operator-secret value', async () => {
    const src = makeSrc();
    const reader = vi.fn().mockResolvedValue('sk-operator');
    const r = new Resolver({
      mappings: [],
      catalog: [
        {
          id: 'replicate',
          host: 'api.replicate.com',
          upstreamPort: 443,
          credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
          baseUrlEnvs: {},
          allowOperatorFallback: true,
          allowedPositions: ['header', 'body'],
        },
      ],
      groupSource: src,
      operatorSecretReader: reader,
    });
    const result = await r.resolveSubstitutionMapAsync({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'family',
      host: 'api.replicate.com',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('narrowing');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_FALLBACK_replicate', value: 'sk-operator' },
    ]);
    expect(result.keySource).toBe('operatorFallback');
  });

  it('unknown_destination when host not in catalog/mappings', () => {
    const r = new Resolver({
      mappings: [],
      catalog: [],
      groupSource: makeSrc(),
      operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'family',
      host: 'nope.example',
    });
    expect(result.status).toBe('unknown_destination');
  });
});

describe('Resolver — LLM catalog entries supersede mappings', () => {
  function makeSrc(): K8sSecretSource {
    return new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  }

  const openaiEntry = {
    id: 'openai',
    host: 'api.openai.com',
    upstreamPort: 443,
    credentialFields: [{ name: 'api_key', envVar: 'OPENAI_API_KEY' }],
    baseUrlEnvs: { OPENAI_BASE_URL: 'http://api.openai.com/v1' },
    allowOperatorFallback: true,
    allowedPositions: ['header' as const],
    apiKeyShape: { prefix: 'sk-', minLength: 20 },
  };

  it('operator-fallback: no group credential → resolves with KC_PH_FALLBACK_openai', async () => {
    // A group exists but has no registered OpenAI credential. The broker should
    // fall back to the operator key via allowOperatorFallback.
    const src = makeSrc();
    const reader = vi.fn().mockResolvedValue('sk-fake-operator-key');
    const r = new Resolver({
      mappings: [], // No legacy mapping for api.openai.com — catalog must win.
      catalog: [openaiEntry],
      groupSource: src,
      operatorSecretReader: reader,
    });

    const result = await r.resolveSubstitutionMapAsync({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'some-group',
      host: 'api.openai.com',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('narrowing');
    expect(result.keySource).toBe('operatorFallback');
    expect(result.catalogId).toBe('openai');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_FALLBACK_openai', value: 'sk-fake-operator-key' },
    ]);
    // operatorSecretReader called with catalog id, not hyphenated key
    expect(reader).toHaveBeenCalledWith('openai');
  });

  it('per-group: group credential registered → resolves with group placeholder', async () => {
    const src = makeSrc();
    // Simulate a group that has registered its own OpenAI key.
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-myteam',
          labels: { 'kubeclaw.io/group-secrets': 'true' },
        },
        data: {
          openai: Buffer.from(
            JSON.stringify({
              fields: {
                api_key: {
                  value: 'sk-group-key-abcdef',
                  placeholder: 'KC_PH_api_key_myteam_1234',
                },
              },
              registeredAt: '2026-06-15T00:00:00Z',
            }),
          ).toString('base64'),
        },
      },
    });

    const reader = vi.fn().mockResolvedValue('sk-fake-operator-key');
    const r = new Resolver({
      mappings: [],
      catalog: [openaiEntry],
      groupSource: src,
      operatorSecretReader: reader,
    });

    const result = await r.resolveSubstitutionMapAsync({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'myteam',
      host: 'api.openai.com',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('narrowing');
    expect(result.keySource).toBe('groupSecret');
    expect(result.catalogId).toBe('openai');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_api_key_myteam_1234', value: 'sk-group-key-abcdef' },
    ]);
    // Operator reader should NOT be called — group key wins.
    expect(reader).not.toHaveBeenCalled();
  });

  it('no-mapping: api.openai.com is not in mappings, only catalog resolves it', () => {
    // Confirm the catalog path (not mappings) handles api.openai.com.
    // This verifies the LLM mappings retirement: the old mappings entries are gone.
    const r = new Resolver({
      mappings: [], // retired LLM mappings
      catalog: [openaiEntry],
      groupSource: makeSrc(),
      operatorSecretReader: vi.fn(),
    });

    // find() is the legacy mappings path — should return undefined for openai
    const mapping = r.find({ destination: 'api.openai.com', identity: 'sa/kubeclaw-tool-job' });
    expect(mapping).toBeUndefined();

    // The catalog path should recognise the host
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'some-group',
      host: 'api.openai.com',
    });
    // no_credential because no group key registered (not unknown_destination)
    expect(result.status).toBe('no_credential');
    if (result.status !== 'no_credential') throw new Error('narrowing');
    expect(result.catalogId).toBe('openai');
  });
});

describe('Resolver — anthropic catalog entry', () => {
  function makeSrc(): K8sSecretSource {
    return new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  }

  const anthropicEntry = {
    id: 'anthropic',
    host: 'api.anthropic.com',
    upstreamPort: 443,
    credentialFields: [{ name: 'api_key', envVar: 'ANTHROPIC_API_KEY' }],
    baseUrlEnvs: { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' },
    allowOperatorFallback: true,
    allowedPositions: ['header' as const],
  };

  it('operator-fallback: no group credential → resolves with KC_PH_FALLBACK_anthropic', async () => {
    const src = makeSrc();
    const reader = vi.fn().mockResolvedValue('sk-ant-operator-key');
    const r = new Resolver({
      mappings: [],
      catalog: [anthropicEntry],
      groupSource: src,
      operatorSecretReader: reader,
    });

    const result = await r.resolveSubstitutionMapAsync({
      identity: 'sa/kubeclaw-tool-job',
      ownerGroup: 'some-group',
      host: 'api.anthropic.com',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('narrowing');
    expect(result.keySource).toBe('operatorFallback');
    expect(result.catalogId).toBe('anthropic');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_FALLBACK_anthropic', value: 'sk-ant-operator-key' },
    ]);
    expect(reader).toHaveBeenCalledWith('anthropic');
  });
});
