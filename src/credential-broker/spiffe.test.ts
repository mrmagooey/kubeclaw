import { describe, it, expect } from 'vitest';
import { parseXfccSpiffeId } from './spiffe.js';

const SINGLE =
  'By=spiffe://cluster.local/ns/istio-system/sa/kubeclaw-istio-egressgateway;' +
  'Hash=abc123;Subject="";' +
  'URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job';

const CHAIN =
  'By=spiffe://cluster.local/ns/a/sa/first;Hash=111;Subject="";URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-channel-telegram,' +
  'By=spiffe://cluster.local/ns/b/sa/second;Hash=222;Subject="";URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-capability-memory';

const NO_URI =
  'By=spiffe://cluster.local/ns/istio-system/sa/something;Hash=abc123;Subject=""';

describe('parseXfccSpiffeId', () => {
  it('extracts sa/<name> from a single-entry XFCC', () => {
    expect(parseXfccSpiffeId(SINGLE)).toBe('sa/kubeclaw-tool-job');
  });

  it('extracts sa/<name> from the FIRST entry in a chained XFCC', () => {
    expect(parseXfccSpiffeId(CHAIN)).toBe('sa/kubeclaw-channel-telegram');
  });

  it('throws when no URI= clause is present', () => {
    expect(() => parseXfccSpiffeId(NO_URI)).toThrow(/no SPIFFE URI/i);
  });

  it('throws on empty string', () => {
    expect(() => parseXfccSpiffeId('')).toThrow(/no SPIFFE URI/i);
  });

  it('extracts sa/<name> when namespace contains hyphens', () => {
    const xfcc =
      'By=spiffe://cluster.local/ns/kube-system/sa/coredns;Hash=xyz;Subject="";' +
      'URI=spiffe://cluster.local/ns/my-namespace/sa/my-service-account-name';
    expect(parseXfccSpiffeId(xfcc)).toBe('sa/my-service-account-name');
  });

  it('throws on malformed SPIFFE URI (missing /sa/ segment)', () => {
    const xfcc =
      'By=spiffe://cluster.local/ns/kubeclaw;Hash=abc;Subject="";' +
      'URI=spiffe://cluster.local/ns/kubeclaw';
    expect(() => parseXfccSpiffeId(xfcc)).toThrow(/malformed SPIFFE URI/i);
  });
});
