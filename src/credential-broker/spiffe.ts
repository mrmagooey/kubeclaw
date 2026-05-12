/**
 * Parses the workload SPIFFE identity from an Istio x-forwarded-client-cert
 * (XFCC) header value and returns it in sa/<name> format — the same format
 * IdentityVerifier.verify() returns for the TokenReview path.
 *
 * XFCC format (per Envoy docs):
 *   <entry>[,<entry>...]
 * where each entry is:
 *   <key>=<value>[;<key>=<value>...]
 *
 * Istio builds the XFCC chain from the egress gateway outward. The FIRST
 * comma-delimited entry is closest to the original workload (the sender's cert),
 * which is the identity we want to authorise.
 */
export function parseXfccSpiffeId(xfccHeader: string): string {
  if (!xfccHeader) {
    throw new Error('no SPIFFE URI found in XFCC header: header is empty');
  }

  const entries = splitXfccEntries(xfccHeader);
  const workloadEntry = entries[0];
  if (!workloadEntry) {
    throw new Error('no SPIFFE URI found in XFCC header: no entries');
  }

  const uri = extractUri(workloadEntry);
  if (!uri) {
    throw new Error(
      `no SPIFFE URI found in XFCC header: URI= clause absent in first entry`,
    );
  }

  return spiffeUriToIdentity(uri);
}

function splitXfccEntries(xfcc: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < xfcc.length; i++) {
    const ch = xfcc[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ',' && !inQuote) {
      entries.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function extractUri(entry: string): string | undefined {
  const parts = entry.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('URI=')) {
      return trimmed.slice('URI='.length);
    }
  }
  return undefined;
}

function spiffeUriToIdentity(uri: string): string {
  const m = uri.match(/^spiffe:\/\/[^/]+\/ns\/([^/]+)\/sa\/(.+)$/);
  if (!m) {
    throw new Error(
      `malformed SPIFFE URI: expected spiffe://<domain>/ns/<ns>/sa/<sa>, got: ${uri}`,
    );
  }
  const [, , sa] = m;
  return `sa/${sa}`;
}
