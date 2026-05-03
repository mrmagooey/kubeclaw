import { describe, it, expect } from 'vitest';
import { Resolver, type Mapping } from './resolver.js';

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

describe('Resolver', () => {
  const r = new Resolver(mappings);

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
    const multi = new Resolver([
      {
        id: 'multi',
        destinations: ['api.first.com', 'api.second.com'],
        identities: ['*'],
        credentialRef: { kind: 'Secret', name: 'kubeclaw-secrets', key: 'shared' },
        headerScheme: 'bearer',
      },
    ]);
    expect(multi.find({ destination: 'api.first.com', identity: 'sa/x' })?.id).toBe('multi');
    expect(multi.find({ destination: 'api.second.com', identity: 'sa/x' })?.id).toBe('multi');
    expect(multi.find({ destination: 'api.third.com', identity: 'sa/x' })?.id).toBeUndefined();
  });
});
