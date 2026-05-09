export type InjectionMode = 'off' | 'sidecar' | 'istio';

const VALID: ReadonlyArray<InjectionMode> = ['off', 'sidecar', 'istio'];

function isInjectionMode(value: string): value is InjectionMode {
  return (VALID as ReadonlyArray<string>).includes(value);
}

export function getInjectionMode(): InjectionMode {
  const raw = process.env.CREDENTIAL_INJECTION_MODE ?? 'off';
  if (!isInjectionMode(raw)) {
    throw new Error(
      `CREDENTIAL_INJECTION_MODE must be one of ${VALID.join(', ')}; got "${raw}"`,
    );
  }
  return raw;
}
