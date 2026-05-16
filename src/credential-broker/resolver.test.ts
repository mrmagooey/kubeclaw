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
                password: { value: 'hunter2', placeholder: 'KC_PH_password_bbbb' },
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
