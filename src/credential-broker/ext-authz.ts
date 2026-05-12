import type { Resolver } from './resolver.js';
import type { IdentityVerifier } from './identity.js';
import type { K8sSecretSource } from './k8s-secret-source.js';
import type { BrokerMetrics } from './metrics.js';

export interface AuditEvent {
  identity?: string;
  destination: string;
  mappingId?: string;
  status: number;
  auditOnly?: boolean;
  wouldStamp?: boolean;
  secretReadSkipped?: boolean;
}

export interface Audit {
  record(event: AuditEvent): void;
}

export interface Deps {
  resolver: Resolver;
  identityVerifier: IdentityVerifier;
  secretSource: K8sSecretSource;
  audit: Audit;
  auditOnly: boolean;
  metrics?: BrokerMetrics;
}

export interface AuthzRequest {
  authorization?: string;
  'x-forwarded-authority'?: string;
  /** Populated by Istio mTLS for SPIFFE identity; absent in sidecar/bearer mode. */
  'x-forwarded-client-cert'?: string;
}

export interface AuthzResponse {
  status: number;
  headers: Record<string, string>;
}

export async function handleExtAuthz(
  req: AuthzRequest,
  deps: Deps,
): Promise<AuthzResponse> {
  const startMs = Date.now();
  const destination = req['x-forwarded-authority'];

  if (!destination) {
    deps.audit.record({ destination: '<missing>', status: 400, auditOnly: deps.auditOnly });
    deps.metrics?.recordAuthz({ status: 400, auditOnly: deps.auditOnly, durationMs: Date.now() - startMs });
    return { status: 400, headers: {} };
  }

  let identity: string;
  try {
    identity = await deps.identityVerifier.verify({
        authorization: req.authorization,
        xfcc: req['x-forwarded-client-cert'],
      });
  } catch {
    deps.audit.record({ destination, status: 401, auditOnly: deps.auditOnly });
    deps.metrics?.recordAuthz({ status: 401, auditOnly: deps.auditOnly, durationMs: Date.now() - startMs });
    return { status: 401, headers: {} };
  }

  const mapping = deps.resolver.find({ destination, identity });

  if (deps.auditOnly) {
    if (!mapping) {
      deps.audit.record({ identity, destination, status: 403, auditOnly: true, wouldStamp: false });
      deps.metrics?.recordAuthz({ status: 403, identity, auditOnly: true, durationMs: Date.now() - startMs });
      return { status: 403, headers: {} };
    }
    deps.audit.record({
      identity,
      destination,
      mappingId: mapping.id,
      status: 200,
      auditOnly: true,
      wouldStamp: true,
      secretReadSkipped: true,
    });
    deps.metrics?.recordAuthz({
      status: 200,
      mappingId: mapping.id,
      identity,
      auditOnly: true,
      durationMs: Date.now() - startMs,
    });
    return { status: 200, headers: {} };
  }

  if (!mapping) {
    deps.audit.record({ identity, destination, status: 403, auditOnly: false, wouldStamp: false });
    deps.metrics?.recordAuthz({ status: 403, identity, auditOnly: false, durationMs: Date.now() - startMs });
    return { status: 403, headers: {} };
  }

  let credential: string;
  try {
    credential = await deps.secretSource.read(mapping.credentialRef);
  } catch {
    deps.audit.record({ identity, destination, mappingId: mapping.id, status: 503, auditOnly: false });
    deps.metrics?.recordSecretFailure({ secretName: mapping.credentialRef.name });
    deps.metrics?.recordAuthz({ status: 503, mappingId: mapping.id, identity, auditOnly: false, durationMs: Date.now() - startMs });
    return { status: 503, headers: {} };
  }

  const headerValue = deps.resolver.formatHeader(mapping.headerScheme, credential);
  deps.audit.record({ identity, destination, mappingId: mapping.id, status: 200, auditOnly: false, wouldStamp: true });
  deps.metrics?.recordAuthz({
    status: 200,
    mappingId: mapping.id,
    identity,
    auditOnly: false,
    durationMs: Date.now() - startMs,
  });
  return { status: 200, headers: { authorization: headerValue } };
}
