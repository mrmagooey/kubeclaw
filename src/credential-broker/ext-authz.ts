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
  // Per-group substitution fields (Task 9)
  ownerGroup?: string;
  catalogId?: string;
  keySource?: 'groupSecret' | 'operatorFallback';
  substitutionCount?: number;
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
  /** Source IP from the ext_authz envelope (used for istio owner-group resolution). */
  sourceIP?: string;
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
    deps.audit.record({
      destination: '<missing>',
      status: 400,
      auditOnly: deps.auditOnly,
    });
    deps.metrics?.recordAuthz({
      status: 400,
      auditOnly: deps.auditOnly,
      durationMs: Date.now() - startMs,
    });
    return { status: 400, headers: {} };
  }

  // Resolve identity and owner-group in one call (sidecar: TokenReview extras;
  // istio: XFCC + sourceIP → pod-informer lookup).
  let identity: string;
  let ownerGroup: string | null = null;
  try {
    const resolved = await deps.identityVerifier.resolveOwnerGroup({
      authorization: req.authorization,
      xfcc: req['x-forwarded-client-cert'],
      sourceIP: req.sourceIP,
    });
    identity = resolved.identity;
    ownerGroup = resolved.ownerGroup;
  } catch {
    deps.audit.record({ destination, status: 401, auditOnly: deps.auditOnly });
    deps.metrics?.recordAuthz({
      status: 401,
      auditOnly: deps.auditOnly,
      durationMs: Date.now() - startMs,
    });
    return { status: 401, headers: {} };
  }

  // Step (b): Try legacy bearer-mapping path first (built-ins: anthropic, openai, etc.)
  const mapping = deps.resolver.find({ destination, identity });

  if (deps.auditOnly) {
    if (!mapping) {
      deps.audit.record({
        identity,
        destination,
        status: 403,
        auditOnly: true,
        wouldStamp: false,
      });
      deps.metrics?.recordAuthz({
        status: 403,
        identity,
        auditOnly: true,
        durationMs: Date.now() - startMs,
      });
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

  if (mapping) {
    // Legacy bearer path: read operator credential and stamp Authorization header.
    let credential: string;
    try {
      credential = await deps.secretSource.read(mapping.credentialRef);
    } catch {
      deps.audit.record({
        identity,
        destination,
        mappingId: mapping.id,
        status: 503,
        auditOnly: false,
      });
      deps.metrics?.recordSecretFailure({
        secretName: mapping.credentialRef.name,
      });
      deps.metrics?.recordAuthz({
        status: 503,
        mappingId: mapping.id,
        identity,
        auditOnly: false,
        durationMs: Date.now() - startMs,
      });
      return { status: 503, headers: {} };
    }

    const headerValue = deps.resolver.formatHeader(
      mapping.headerScheme,
      credential,
    );
    deps.audit.record({
      identity,
      destination,
      mappingId: mapping.id,
      status: 200,
      auditOnly: false,
      wouldStamp: true,
    });
    deps.metrics?.recordAuthz({
      status: 200,
      mappingId: mapping.id,
      identity,
      auditOnly: false,
      durationMs: Date.now() - startMs,
    });
    return { status: 200, headers: { authorization: headerValue } };
  }

  // Step (c): No legacy mapping — try per-group substitution path.
  const subResult = await deps.resolver.resolveSubstitutionMapAsync({
    identity,
    ownerGroup,
    host: destination,
  });

  if (subResult.status === 'unknown_destination') {
    deps.audit.record({
      identity,
      destination,
      status: 403,
      auditOnly: false,
      wouldStamp: false,
    });
    deps.metrics?.recordAuthz({
      status: 403,
      identity,
      auditOnly: false,
      durationMs: Date.now() - startMs,
    });
    return { status: 403, headers: {} };
  }

  if (subResult.status === 'no_owner_group') {
    deps.audit.record({
      identity,
      destination,
      status: 403,
      auditOnly: false,
      wouldStamp: false,
    });
    deps.metrics?.recordAuthz({
      status: 403,
      identity,
      auditOnly: false,
      durationMs: Date.now() - startMs,
    });
    return { status: 403, headers: {} };
  }

  if (subResult.status === 'no_credential') {
    deps.audit.record({
      identity,
      ownerGroup: ownerGroup ?? undefined,
      destination,
      catalogId: subResult.catalogId,
      status: 403,
      auditOnly: false,
      wouldStamp: false,
    });
    deps.metrics?.recordAuthz({
      status: 403,
      identity,
      auditOnly: false,
      durationMs: Date.now() - startMs,
    });
    return { status: 403, headers: {} };
  }

  // Step (d): ok — emit x-kubeclaw-substitute header.
  // allowedPositions is included in the ok result from resolver.
  const substitutePayload = {
    substitutions: subResult.substitutions,
    allowedPositions: subResult.allowedPositions,
    perPlaceholderMax: 10,
    totalMax: 50,
  };
  const substituteHeaderValue = Buffer.from(
    JSON.stringify(substitutePayload),
    'utf8',
  ).toString('base64');

  // Step (f): Audit log — values NEVER logged.
  deps.audit.record({
    identity,
    ownerGroup: ownerGroup ?? undefined,
    destination,
    catalogId: subResult.catalogId,
    keySource: subResult.keySource,
    substitutionCount: subResult.substitutions.length,
    status: 200,
    auditOnly: false,
    wouldStamp: true,
  });
  deps.metrics?.recordAuthz({
    status: 200,
    identity,
    auditOnly: false,
    durationMs: Date.now() - startMs,
  });

  return {
    status: 200,
    headers: { 'x-kubeclaw-substitute': substituteHeaderValue },
  };
}
