import type { CapabilitySpec } from '../capabilities/types.js';

export type CapabilityScope = 'cluster' | 'group';

export class PerGroupCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerGroupCapabilityError';
  }
}

const GROUP_ONLY_FIELDS = [
  'scaleDownAfterIdleSeconds',
  'volumeFromGroupPvc',
  'credentialsFrom',
  'pinned',
] as const;

export function getScope(spec: CapabilitySpec): CapabilityScope {
  return spec.scope ?? 'cluster';
}

export function validateScopeFields(spec: CapabilitySpec): void {
  const scope = getScope(spec);
  if (scope === 'cluster') {
    for (const field of GROUP_ONLY_FIELDS) {
      if (spec[field] !== undefined) {
        throw new PerGroupCapabilityError(
          `Capability ${spec.name}: field '${field}' is only valid for scope: 'group'`,
        );
      }
    }
    return;
  }
  const idle = spec.scaleDownAfterIdleSeconds ?? 600;
  if (idle < 60) {
    throw new PerGroupCapabilityError(
      `Capability ${spec.name}: scaleDownAfterIdleSeconds must be at least 60 (got ${idle})`,
    );
  }
}

export interface ResolvedGroupCapability {
  spec: CapabilitySpec;
  scaleDownAfterIdleSeconds: number;
  volumeFromGroupPvc: boolean;
  credentialsFrom: 'none' | 'secret';
  pinned: boolean;
}

export function resolveGroupCapability(
  spec: CapabilitySpec,
): ResolvedGroupCapability {
  if (getScope(spec) !== 'group') {
    throw new PerGroupCapabilityError(
      `resolveGroupCapability called on cluster-scoped ${spec.name}`,
    );
  }
  return {
    spec,
    scaleDownAfterIdleSeconds: spec.scaleDownAfterIdleSeconds ?? 600,
    volumeFromGroupPvc: spec.volumeFromGroupPvc ?? false,
    credentialsFrom: spec.credentialsFrom ?? 'none',
    pinned: spec.pinned ?? false,
  };
}
