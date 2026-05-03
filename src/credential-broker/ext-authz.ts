import type { Resolver } from './resolver.js';
import type { IdentityVerifier } from './identity.js';
import type { K8sSecretSource } from './k8s-secret-source.js';

export interface Audit {
  record(event: {
    identity?: string;
    destination: string;
    mappingId?: string;
    status: number;
  }): void;
}

export interface Deps {
  resolver: Resolver;
  identityVerifier: IdentityVerifier;
  secretSource: K8sSecretSource;
  audit: Audit;
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
    deps.audit.record({ destination: '<missing>', status: 400 });
    return { status: 400, headers: {} };
  }

  let identity: string;
  try {
    identity = await deps.identityVerifier.verify(req.authorization);
  } catch {
    deps.audit.record({ destination, status: 401 });
    return { status: 401, headers: {} };
  }

  const mapping = deps.resolver.find({ destination, identity });
  if (!mapping) {
    deps.audit.record({ identity, destination, status: 403 });
    return { status: 403, headers: {} };
  }

  let credential: string;
  try {
    credential = await deps.secretSource.read(mapping.credentialRef);
  } catch {
    deps.audit.record({ identity, destination, mappingId: mapping.id, status: 503 });
    return { status: 503, headers: {} };
  }
  const headerValue = deps.resolver.formatHeader(mapping.headerScheme, credential);
  deps.audit.record({ identity, destination, mappingId: mapping.id, status: 200 });
  return { status: 200, headers: { authorization: headerValue } };
}
