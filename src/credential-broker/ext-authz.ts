import type { Resolver } from './resolver.js';
import type { IdentityVerifier } from './identity.js';
import type { K8sSecretSource } from './k8s-secret-source.js';

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
}

export interface AuthzRequest {
  authorization?: string;
  'x-forwarded-authority'?: string;
}

export interface AuthzResponse {
  status: number;
  headers: Record<string, string>;
}

export async function handleExtAuthz(
  req: AuthzRequest,
  deps: Deps,
): Promise<AuthzResponse> {
  const destination = req['x-forwarded-authority'];
  if (!destination) {
    deps.audit.record({ destination: '<missing>', status: 400, auditOnly: deps.auditOnly });
    return { status: 400, headers: {} };
  }

  let identity: string;
  try {
    identity = await deps.identityVerifier.verify(req.authorization);
  } catch {
    deps.audit.record({ destination, status: 401, auditOnly: deps.auditOnly });
    return { status: 401, headers: {} };
  }

  const mapping = deps.resolver.find({ destination, identity });

  // Audit-only branch: broker is in the path but does not strip env vars or stamp
  // the Authorization header. Logs what would have happened.
  if (deps.auditOnly) {
    if (!mapping) {
      deps.audit.record({
        identity,
        destination,
        status: 403,
        auditOnly: true,
        wouldStamp: false,
      });
      return { status: 403, headers: {} };
    }
    // Mapping found: would have stamped. Skip secret read entirely.
    deps.audit.record({
      identity,
      destination,
      mappingId: mapping.id,
      status: 200,
      auditOnly: true,
      wouldStamp: true,
      secretReadSkipped: true,
    });
    return { status: 200, headers: {} };
  }

  // Enforcement path (auditOnly=false).
  if (!mapping) {
    deps.audit.record({ identity, destination, status: 403, auditOnly: false, wouldStamp: false });
    return { status: 403, headers: {} };
  }

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
  return { status: 200, headers: { authorization: headerValue } };
}
