import { describe, it, expect } from 'vitest';
import { isPubliclyRoutableHost } from './egress-guard.js';

describe('isPubliclyRoutableHost', () => {
  // Public FQDNs — must be allowed
  it('allows a normal public FQDN', () => {
    expect(isPubliclyRoutableHost('api.example.com')).toBe(true);
    expect(isPubliclyRoutableHost('search.brave.com')).toBe(true);
    expect(isPubliclyRoutableHost('hub.docker.com')).toBe(true);
  });

  // Single-label names (cluster-internal services)
  it('blocks single-label names (no dot)', () => {
    expect(isPubliclyRoutableHost('localhost')).toBe(false);
    expect(isPubliclyRoutableHost('kubeclaw-redis')).toBe(false);
    expect(isPubliclyRoutableHost('postgres')).toBe(false);
  });

  // Cluster-local DNS suffixes
  it('blocks .cluster.local suffixes', () => {
    expect(isPubliclyRoutableHost('redis.default.svc.cluster.local')).toBe(
      false,
    );
    expect(isPubliclyRoutableHost('my-service.cluster.local')).toBe(false);
  });

  it('blocks .svc suffix', () => {
    expect(isPubliclyRoutableHost('redis.default.svc')).toBe(false);
  });

  // Cloud-metadata / internal DNS names (resolve to 169.254.169.254 etc.)
  it('blocks cloud-metadata hostnames', () => {
    expect(isPubliclyRoutableHost('metadata.google.internal')).toBe(false);
    expect(isPubliclyRoutableHost('metadata.goog')).toBe(false);
    expect(isPubliclyRoutableHost('instance-data.ec2.internal')).toBe(false);
    expect(isPubliclyRoutableHost('METADATA.GOOGLE.INTERNAL')).toBe(false);
  });

  it('blocks the ICANN-reserved .internal private-use TLD', () => {
    expect(isPubliclyRoutableHost('anything.internal')).toBe(false);
  });

  // IPv4 private ranges
  it('blocks 127.0.0.0/8 (loopback)', () => {
    expect(isPubliclyRoutableHost('127.0.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('127.255.255.255')).toBe(false);
  });

  it('blocks 10.0.0.0/8 (private class A)', () => {
    expect(isPubliclyRoutableHost('10.0.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('10.255.255.255')).toBe(false);
  });

  it('blocks 172.16.0.0/12 (private class B)', () => {
    expect(isPubliclyRoutableHost('172.16.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('172.31.255.255')).toBe(false);
  });

  it('allows addresses just outside the 172.16.0.0/12 range', () => {
    expect(isPubliclyRoutableHost('172.15.255.255')).toBe(true);
    expect(isPubliclyRoutableHost('172.32.0.0')).toBe(true);
  });

  it('blocks 192.168.0.0/16 (private class C)', () => {
    expect(isPubliclyRoutableHost('192.168.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('192.168.255.255')).toBe(false);
  });

  it('blocks 169.254.0.0/16 (link-local, includes cloud-metadata)', () => {
    expect(isPubliclyRoutableHost('169.254.169.254')).toBe(false); // cloud-metadata
    expect(isPubliclyRoutableHost('169.254.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('169.254.255.255')).toBe(false);
  });

  it('blocks 100.64.0.0/10 (CGNAT)', () => {
    expect(isPubliclyRoutableHost('100.64.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('100.127.255.255')).toBe(false);
  });

  it('allows 100.128.x.x (just outside CGNAT range)', () => {
    expect(isPubliclyRoutableHost('100.128.0.0')).toBe(true);
  });

  it('allows a public IPv4 address', () => {
    expect(isPubliclyRoutableHost('8.8.8.8')).toBe(true);
    expect(isPubliclyRoutableHost('1.1.1.1')).toBe(true);
  });

  // IPv6 ranges
  it('blocks ::1 (IPv6 loopback)', () => {
    expect(isPubliclyRoutableHost('::1')).toBe(false);
    expect(isPubliclyRoutableHost('[::1]')).toBe(false);
  });

  it('blocks fc00::/7 (ULA)', () => {
    expect(isPubliclyRoutableHost('fc00::1')).toBe(false);
    expect(isPubliclyRoutableHost('fd00::1')).toBe(false);
    expect(isPubliclyRoutableHost('fdff:ffff::1')).toBe(false);
  });

  it('blocks fe80::/10 (link-local)', () => {
    expect(isPubliclyRoutableHost('fe80::1')).toBe(false);
    expect(isPubliclyRoutableHost('fe90::1')).toBe(false);
    expect(isPubliclyRoutableHost('fea0::1')).toBe(false);
    expect(isPubliclyRoutableHost('feb0::1')).toBe(false);
  });

  it('allows fe addresses outside fe80::/10', () => {
    expect(isPubliclyRoutableHost('fec0::1')).toBe(true); // site-local (deprecated) but not link-local
  });

  it('blocks ::ffff: IPv4-mapped private addresses', () => {
    expect(isPubliclyRoutableHost('::ffff:192.168.1.1')).toBe(false);
    expect(isPubliclyRoutableHost('::ffff:10.0.0.1')).toBe(false);
    expect(isPubliclyRoutableHost('::ffff:169.254.169.254')).toBe(false);
  });

  it('allows ::ffff: IPv4-mapped public addresses', () => {
    expect(isPubliclyRoutableHost('::ffff:8.8.8.8')).toBe(true);
  });

  it('handles bracket-quoted IPv6 literals', () => {
    expect(isPubliclyRoutableHost('[::1]')).toBe(false);
    expect(isPubliclyRoutableHost('[fe80::1]')).toBe(false);
    expect(isPubliclyRoutableHost('[2001:db8::1]')).toBe(true);
  });
});
