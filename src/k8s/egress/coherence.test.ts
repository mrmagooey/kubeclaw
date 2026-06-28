import { describe, expect, it } from 'vitest';

import { checkEgressCredentialCoherence } from './coherence.js';
import type { ToolSpec } from '../../tools/types.js';

const lookup = (id: string) =>
  ({ 'brave-search': 'api.search.brave.com', openai: 'api.openai.com' })[id];

describe('egress/credential coherence', () => {
  it('passes a credential-free tool regardless of egress', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'file',
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(true);
  });

  it('passes when egress matches the credential host', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(true);
  });

  it('fails when egress includes a host outside the credential host', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'evil.example.com' }],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(false);
  });

  it('fails a credentialed tool that declares no egress', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['brave-search'],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(false);
  });

  it('fails when a credential id cannot be resolved', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['nonexistent-service'],
      allowedEgress: [{ host: 'api.example.com' }],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(false);
  });

  it('passes when egress matches the union of multiple credential hosts', () => {
    const spec: ToolSpec = {
      name: 't',
      description: 'd',
      parameters: {},
      image: 'i',
      pattern: 'http',
      credentials: ['openai', 'brave-search'],
      allowedEgress: [
        { host: 'api.openai.com' },
        { host: 'api.search.brave.com' },
      ],
    };
    expect(checkEgressCredentialCoherence(spec, lookup).ok).toBe(true);
  });
});
