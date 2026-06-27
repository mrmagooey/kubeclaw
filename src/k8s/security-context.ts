export function hardenedPodSecurityContext(): object {
  return {
    runAsNonRoot: true,
    runAsUser: 65534,
    fsGroup: 2000,
    fsGroupChangePolicy: 'OnRootMismatch',
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

export function hardenedContainerSecurityContext(): object {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
}
