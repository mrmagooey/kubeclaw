/**
 * Shared cert-manager installer used by setup/minikube.ts and e2e/global-setup.ts.
 *
 * cert-manager provides the cert-manager.io/v1 Issuer + Certificate CRDs
 * the kubeclaw chart uses to mint kubeclaw-egress-ca for credential-injection
 * sidecar TLS interception. Without it, `helm install kubeclaw` (default
 * mode=sidecar) fails with "no matches for kind Certificate".
 *
 * Idempotent: when cert-manager is already installed (helm release present
 * in the cert-manager namespace), this is a no-op so production clusters
 * with their own cert-manager are unaffected. Pass {skip: true} to bypass
 * entirely when the operator has cert-manager installed elsewhere or
 * declines auto-management.
 */
import { spawnSync } from 'child_process';
import { logger } from '../src/logger.js';
import { waitForDeployment } from './k8s-utils.js';

export const CERT_MANAGER_VERSION = 'v1.16.2';
const NAMESPACE = 'cert-manager';
const RELEASE = 'cert-manager';

export interface InstallCertManagerOptions {
  /** Caller-driven opt-out (e.g. --skip-cert-manager flag). */
  skip?: boolean;
  /** Helm install timeout. Default '3m'. */
  timeout?: string;
}

/**
 * Detect whether the canonical cert-manager helm release is installed
 * (release name `cert-manager` in namespace `cert-manager`). Returns
 * `false` if the release is absent, *or* if helm itself isn't on PATH —
 * the install path will then attempt the install and surface the binary
 * error there. Synchronous; uses `helm status` with stdio piped.
 */
export function isCertManagerInstalled(): boolean {
  const r = spawnSync(
    'helm',
    ['status', RELEASE, '--namespace', NAMESPACE],
    { stdio: 'pipe' },
  );
  return r.status === 0;
}

/**
 * Install cert-manager into the current kube-context if it isn't already
 * present. Idempotent — returns `'present'` when a release already exists
 * and `'skipped'` when the caller opts out via `opts.skip`. Otherwise
 * installs cert-manager at the pinned `CERT_MANAGER_VERSION`, then waits
 * for the admission webhook to be Ready before returning `'installed'`.
 *
 * Throws distinct named errors per failure point so callers can
 * differentiate (`cert_manager_repo_add_failed`,
 * `cert_manager_repo_update_failed`, `cert_manager_install_failed`,
 * `cert_manager_webhook_not_ready`).
 */
export async function installCertManager(
  opts: InstallCertManagerOptions = {},
): Promise<'installed' | 'present' | 'skipped'> {
  if (opts.skip) {
    logger.info('Skipping cert-manager install (caller opt-out)');
    return 'skipped';
  }

  if (isCertManagerInstalled()) {
    logger.info('cert-manager already installed — skipping');
    return 'present';
  }

  logger.info('Adding jetstack helm repo');
  const repoAdd = spawnSync(
    'helm',
    ['repo', 'add', 'jetstack', 'https://charts.jetstack.io', '--force-update'],
    { stdio: 'inherit' },
  );
  if (repoAdd.status !== 0) throw new Error('cert_manager_repo_add_failed');

  const repoUpdate = spawnSync('helm', ['repo', 'update'], { stdio: 'inherit' });
  if (repoUpdate.status !== 0) throw new Error('cert_manager_repo_update_failed');

  logger.info(
    `Installing cert-manager ${CERT_MANAGER_VERSION} ` +
      '(provides Issuer/Certificate CRDs for credentialInjection internal CA)',
  );
  const timeout = opts.timeout ?? '3m';
  const install = spawnSync(
    'helm',
    [
      'upgrade', '--install', RELEASE, 'jetstack/cert-manager',
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--version', CERT_MANAGER_VERSION,
      '--set', 'crds.enabled=true',
      '--timeout', timeout,
      '--wait',
    ],
    { stdio: 'inherit' },
  );
  if (install.status !== 0) throw new Error('cert_manager_install_failed');

  // The admission webhook must be Ready before any Certificate/Issuer
  // can be created — helm --wait usually covers this but CI has seen
  // a webhook briefly serving without its TLS cert mounted. Belt-and-
  // suspenders polling.
  const ready = await waitForDeployment(NAMESPACE, 'cert-manager-webhook', 60_000);
  if (!ready) throw new Error('cert_manager_webhook_not_ready');

  logger.info('cert-manager ready');
  return 'installed';
}
