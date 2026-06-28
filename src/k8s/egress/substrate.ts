export type EgressSubstrate = 'cilium' | 'istio' | 'none';

export function detectEgressSubstrate(
  env: NodeJS.ProcessEnv = process.env,
): EgressSubstrate {
  if (env.CILIUM_NETWORK_POLICY_ENABLED === 'true') return 'cilium';
  if ((env.CREDENTIAL_INJECTION_MODE ?? 'off') === 'istio') return 'istio';
  return 'none';
}

export function hasHardEgressEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return detectEgressSubstrate(env) !== 'none';
}
