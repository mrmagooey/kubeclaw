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

describe('loadBrokerConfig — catalog', () => {
  it('parses single-field catalog entry with defaults', () => {
    const yaml = `
mappings: []
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields:
      - { name: token, envVar: REPLICATE_API_TOKEN }
    baseUrlEnvs: { REPLICATE_API_URL: "http://api.replicate.com" }
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.catalog).toHaveLength(1);
    expect(cfg.catalog[0].upstreamPort).toBe(443);
    expect(cfg.catalog[0].allowOperatorFallback).toBe(false);
    expect(cfg.catalog[0].allowedPositions).toEqual(['header', 'body']);
  });

  it('parses multi-field catalog entry', () => {
    const yaml = `
catalog:
  - id: jenkins
    host: jenkins.example.com
    upstreamPort: 8080
    credentialFields:
      - { name: user, envVar: JENKINS_USER }
      - { name: password, envVar: JENKINS_PASSWORD }
    allowedPositions: [header, body]
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.catalog[0].credentialFields).toHaveLength(2);
    expect(cfg.catalog[0].upstreamPort).toBe(8080);
  });

  it('rejects multi-field entry with allowOperatorFallback=true', () => {
    const yaml = `
catalog:
  - id: bad
    host: bad.example
    credentialFields:
      - { name: a, envVar: A }
      - { name: b, envVar: B }
    allowOperatorFallback: true
`;
    expect(() => loadBrokerConfig(yaml)).toThrow(/allowOperatorFallback/);
  });

  it('rejects duplicate catalog ids', () => {
    const yaml = `
catalog:
  - id: dup
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
  - id: dup
    host: b.example
    credentialFields: [{ name: t, envVar: T }]
`;
    expect(() => loadBrokerConfig(yaml)).toThrow(/unique/);
  });

  it('validates apiKeyShape', () => {
    const yaml = `
catalog:
  - id: x
    host: x.example
    credentialFields: [{ name: t, envVar: T }]
    apiKeyShape: { prefix: "sk-", minLength: 20 }
`;
    expect(() => loadBrokerConfig(yaml)).not.toThrow();
  });

  it('rejects catalog id with uppercase', () => {
    const yaml = `
catalog:
  - id: Bad
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
`;
    expect(() => loadBrokerConfig(yaml)).toThrow();
  });

  it('preserves existing mappings field', () => {
    const yaml = `
mappings:
  - id: anthropic
    destinations: [api.anthropic.com]
    identities: ["*"]
    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: anthropic-api-key }
    headerScheme: bearer
catalog: []
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.mappings).toHaveLength(1);
    expect(cfg.catalog).toHaveLength(0);
  });
});
