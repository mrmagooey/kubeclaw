/**
 * Registry of per-group capability builders.
 *
 * Each builder is keyed by the `type` field that operators use in the Helm
 * `perGroupCapabilities` array. The registry is intentionally sparse — only
 * builders declared here are active. Unknown types are rejected at boot time
 * with a clear "unknown capability type" error so operators get immediate
 * feedback rather than a silent no-op.
 *
 * PRODUCTION GUARD: The `echo` builder is for testing only. It is registered
 * here but only activates when the operator explicitly declares `type: echo`
 * in the Helm value. Do not auto-provision echo in any other code path.
 */
import type { CapabilitySpec } from '../../capabilities/types.js';
import { buildEchoCapabilitySpec, ECHO_CAPABILITY_TYPE } from './echo.js';

/** Input shape from the Helm `perGroupCapabilities` array. */
export interface PerGroupCapabilityHelmEntry {
  /** Matches a registered builder key (e.g. "echo"). */
  type: string;
  /** Container image (with tag). */
  image: string;
  /** Seconds of idle before scale-to-zero. Min 60. Default 120. */
  scaleDownAfterIdleSeconds?: number;
}

/** A builder converts a Helm entry into a full CapabilitySpec. */
export type PerGroupCapabilityBuilder = (
  entry: PerGroupCapabilityHelmEntry,
) => CapabilitySpec;

/**
 * Map from `type` string → builder function.
 *
 * Extend this map when new per-group capability types are added.
 */
const BUILDERS: Record<string, PerGroupCapabilityBuilder> = {
  [ECHO_CAPABILITY_TYPE]: (entry) =>
    buildEchoCapabilitySpec({
      image: entry.image,
      scaleDownAfterIdleSeconds: entry.scaleDownAfterIdleSeconds,
    }),
};

/**
 * Convert a raw Helm entry into a CapabilitySpec.
 *
 * Throws with a descriptive message if the type is not registered.
 */
export function buildPerGroupCapabilitySpec(
  entry: PerGroupCapabilityHelmEntry,
): CapabilitySpec {
  const builder = BUILDERS[entry.type];
  if (!builder) {
    const known = Object.keys(BUILDERS).join(', ') || 'none';
    throw new Error(
      `Unknown per-group capability type '${entry.type}'. ` +
        `Registered types: ${known}.`,
    );
  }
  return builder(entry);
}

/** Return all registered per-group capability type names. */
export function listPerGroupCapabilityTypes(): string[] {
  return Object.keys(BUILDERS);
}
