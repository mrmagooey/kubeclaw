import { describe, it, expect } from 'vitest';
import { loadBrokerConfig } from './config.js';

describe('loadBrokerConfig', () => {
  it('parses valid YAML', () => {
    const yaml = `
mappings:
  - id: anthropic
    destinations: ["api.anthropic.com"]
    identities: ["*"]
    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: anthropic-api-key }
    headerScheme: bearer
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.mappings).toHaveLength(1);
    expect(cfg.mappings[0].id).toBe('anthropic');
  });

  it('throws on missing required field', () => {
    expect(() => loadBrokerConfig('mappings: [{ id: x }]')).toThrow();
  });
});
