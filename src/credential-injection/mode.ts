export type InjectionMode = 'off' | 'sidecar' | 'istio';

const VALID: ReadonlyArray<InjectionMode> = ['off', 'sidecar', 'istio'];

export function getInjectionMode(): InjectionMode {
  const raw = process.env.CREDENTIAL_INJECTION_MODE ?? 'off';
  if (!(VALID as ReadonlyArray<string>).includes(raw)) {
    throw new Error(
      `CREDENTIAL_INJECTION_MODE must be one of ${VALID.join(', ')}; got "${raw}"`,
    );
  }
  return raw as InjectionMode;
}
