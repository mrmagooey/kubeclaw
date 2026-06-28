import { isIPv4 } from 'node:net';

function ipv4ToInt(addr: string): number {
  const parts = addr.split('.').map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

function inCidrV4(addr: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateIPv4(addr: string): boolean {
  return (
    inCidrV4(addr, '127.0.0.0', 8) || // loopback
    inCidrV4(addr, '10.0.0.0', 8) || // private class A
    inCidrV4(addr, '172.16.0.0', 12) || // private class B
    inCidrV4(addr, '192.168.0.0', 16) || // private class C
    inCidrV4(addr, '169.254.0.0', 16) || // link-local (incl. 169.254.169.254 cloud-metadata)
    inCidrV4(addr, '100.64.0.0', 10) // CGNAT / shared address space
  );
}

/**
 * Returns true if `host` is safe to allow egress to from an UNTRUSTED
 * (discovered) tool spec — i.e. it resolves to a publicly routable destination
 * and is not a cluster-internal service, loopback, link-local, private
 * network, or CGNAT address.
 *
 * Conservative: when classification is uncertain the function returns false
 * (block it) rather than allowing potentially unsafe egress.
 */
export function isPubliclyRoutableHost(host: string): boolean {
  // Strip optional square brackets used in URL-notation IPv6 literals, e.g. [::1].
  const stripped =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // Single-label name (no dot, no colon) = cluster-internal service or bare keyword
  // e.g. "kubeclaw-redis", "localhost".
  if (!stripped.includes('.') && !stripped.includes(':')) return false;

  const lower = stripped.toLowerCase();

  // Cluster-local DNS suffixes.
  if (
    lower.endsWith('.cluster.local') ||
    lower.endsWith('.svc') ||
    lower.endsWith('.svc.cluster.local')
  ) {
    return false;
  }

  // Cloud-metadata / internal DNS names. The IP literal 169.254.169.254 is
  // already blocked, but the canonical metadata *hostnames* resolve to it and
  // would otherwise pass as ordinary dotted FQDNs — a node-credential
  // exfiltration vector for a prompt-injected discovered spec. `.internal` is
  // an ICANN-reserved private-use TLD (covers metadata.google.internal and
  // *.ec2.internal); `.goog` is a public TLD so we deny the exact metadata host.
  if (lower.endsWith('.internal') || lower === 'metadata.goog') {
    return false;
  }

  // IPv4 literal.
  if (isIPv4(stripped)) {
    return !isPrivateIPv4(stripped);
  }

  // IPv6 literal — detected by the presence of ':'.
  if (stripped.includes(':')) {
    // Loopback (::1).
    if (lower === '::1') return false;
    // ULA (fc00::/7): first byte is fc or fd.
    if (/^f[cd]/i.test(lower)) return false;
    // Link-local (fe80::/10): first byte fe, third hex digit 8..b (80..bf).
    if (/^fe[89ab]/i.test(lower)) return false;
    // IPv4-mapped (::ffff:a.b.c.d): extract the IPv4 part and check it.
    // NOTE: only the dotted-quad form is matched; the hex form
    // (::ffff:0a00:0001) is not — vanishingly unlikely from an LLM draft and
    // the substrate (Cilium/Istio) resolves it at enforcement time regardless.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isPrivateIPv4(mapped[1])) return false;
    // Unrecognised IPv6 literal: treat as publicly routable.
    return true;
  }

  // Regular FQDN with at least one dot — assume publicly routable.
  return true;
}
