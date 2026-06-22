/**
 * Step: minikube — Provision a local KubeClaw cluster on minikube.
 *
 * Phases:
 *   1. Start minikube (bridge CNI by default, Cilium opt-in)
 *   1.5 Install Istio (idempotent; skipped if virtualservices CRD already present)
 *   2. Build container images into minikube's Docker daemon
 *   3. Install Falco (runtime security)
 *   3.5 Install cert-manager (Issuer/Certificate CRDs for credentialInjection)
 *   4. Deploy KubeClaw via Helm (laptop-optimised values)
 *   5. Verify everything is running
 *
 * Usage:
 *   npm run setup:minikube
 *   npm run setup:minikube -- --reset          # delete & recreate cluster
 *   npm run setup:minikube -- --skip-build     # skip image build
 *   npm run setup:minikube -- --skip-falco     # skip Falco install
 *   npm run setup:minikube -- --skip-cert-manager  # skip cert-manager install
 *   npm run setup:minikube -- --skip-istio     # skip Istio install
 *   npm run setup:minikube -- --cpus 6 --memory 8192
 *   npm run setup:minikube -- --profile kubeclaw  # use a named minikube profile
 *   npm run setup:minikube -- --cni=cilium     # opt-in to Cilium CNI
 *   npm run setup:minikube -- --with-cilium    # shortcut for --cni=cilium
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';
import { runKubectl, truncateText, waitForDaemonSet, waitForPodRunning } from './k8s-utils.js';
import { installCertManager } from './cert-manager.js';

type CniMode = 'cilium' | 'bridge' | 'auto';

export interface MinikubeOpts {
  cpus: number;
  memory: number; // MiB
  disk: string;
  reset: boolean;
  skipBuild: boolean;
  skipFalco: boolean;
  skipCertManager: boolean;
  skipIstio: boolean;
  profile: string; // named minikube profile; empty = default profile
  cni: CniMode;
}

export function parseArgs(args: string[]): MinikubeOpts {
  let cpus = 4;
  let memory = 8192;
  let disk = '20g';
  let reset = false;
  let skipBuild = false;
  let skipFalco = false;
  let skipCertManager = false;
  let skipIstio = false;
  let profile = '';
  let cni: CniMode = 'auto';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reset') reset = true;
    else if (args[i] === '--skip-build') skipBuild = true;
    else if (args[i] === '--skip-falco') skipFalco = true;
    else if (args[i] === '--skip-cert-manager') skipCertManager = true;
    else if (args[i] === '--skip-istio') skipIstio = true;
    else if (args[i] === '--with-cilium') cni = 'cilium';
    else if (args[i] === '--cpus' && args[i + 1]) { cpus = parseInt(args[++i], 10); }
    else if (args[i] === '--memory' && args[i + 1]) { memory = parseInt(args[++i], 10); }
    else if (args[i] === '--disk' && args[i + 1]) { disk = args[++i]; }
    else if (args[i] === '--profile' && args[i + 1]) { profile = args[++i]; }
    else if (args[i].startsWith('--cni=')) {
      const val = args[i].slice('--cni='.length) as CniMode;
      if (val === 'cilium' || val === 'bridge' || val === 'auto') {
        cni = val;
      } else {
        throw new Error(`Unknown --cni value "${val}". Valid values: cilium, bridge, auto`);
      }
    } else if (args[i] === '--cni' && args[i + 1]) {
      const val = args[++i] as CniMode;
      if (val === 'cilium' || val === 'bridge' || val === 'auto') {
        cni = val;
      } else {
        throw new Error(`Unknown --cni value "${val}". Valid values: cilium, bridge, auto`);
      }
    }
  }

  return { cpus, memory, disk, reset, skipBuild, skipFalco, skipCertManager, skipIstio, profile, cni };
}

/** Returns `['-p', profile]` when a named profile is set, otherwise `[]`. */
function profileFlag(profile: string): string[] {
  return profile ? ['-p', profile] : [];
}

/**
 * Detect the iptables backend on the host.
 * Returns true if the host uses nf_tables (iptables-nft), which is incompatible with Cilium.
 */
export function hostUsesNftables(): boolean {
  const r = spawnSync('iptables', ['--version'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // iptables-nft reports something like "iptables v1.8.7 (nf_tables)"
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  return output.includes('nf_tables');
}

/**
 * Resolve the CNI to actually use, given the requested mode.
 * In 'auto' mode, detects the host iptables backend.
 */
export function resolveCni(requested: CniMode): 'cilium' | 'bridge' {
  if (requested === 'cilium') return 'cilium';
  if (requested === 'bridge') return 'bridge';

  // auto: probe iptables backend
  if (hostUsesNftables()) {
    logger.warn(
      'Host uses iptables-nft (nf_tables backend detected). ' +
      'Cilium requires iptables-legacy to work correctly. ' +
      'Falling back to bridge CNI. ' +
      'To override, pass --cni=cilium explicitly.',
    );
    return 'bridge';
  }
  return 'cilium';
}

// ── prerequisites ─────────────────────────────────────────────────────────────

const INOTIFY_MIN_INSTANCES = 512;
const INOTIFY_MIN_WATCHES = 65536;
const INOTIFY_REC_INSTANCES = 8192;
const INOTIFY_REC_WATCHES = 524288;

/** Read an integer from a /proc/sys sysctl file. Returns null on any error. */
function readSysctlInt(filePath: string): number | null {
  try {
    return parseInt(readFileSync(filePath, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Verify that Linux inotify limits are high enough for minikube to run.
 * Returns an array of error strings (empty = ok). Skipped on non-Linux.
 */
export function checkInotifyLimits(): string[] {
  if (process.platform !== 'linux') return [];

  const errors: string[] = [];

  const instances = readSysctlInt('/proc/sys/fs/inotify/max_user_instances');
  const watches = readSysctlInt('/proc/sys/fs/inotify/max_user_watches');

  const instancesOk = instances !== null && instances >= INOTIFY_MIN_INSTANCES;
  const watchesOk = watches !== null && watches >= INOTIFY_MIN_WATCHES;

  if (!instancesOk || !watchesOk) {
    const lines: string[] = [
      'inotify limits are too low — kube-proxy / storage-provisioner will crashloop with "too many open files".',
      '',
      'Current values:',
      `  fs.inotify.max_user_instances = ${instances ?? '(unreadable)'}  (minimum: ${INOTIFY_MIN_INSTANCES})`,
      `  fs.inotify.max_user_watches   = ${watches ?? '(unreadable)'}  (minimum: ${INOTIFY_MIN_WATCHES})`,
      '',
      'Apply immediately (until next reboot):',
      `  sudo sysctl -w fs.inotify.max_user_instances=${INOTIFY_REC_INSTANCES}`,
      `  sudo sysctl -w fs.inotify.max_user_watches=${INOTIFY_REC_WATCHES}`,
      '',
      'Make it permanent — add to /etc/sysctl.d/99-inotify.conf:',
      `  fs.inotify.max_user_instances = ${INOTIFY_REC_INSTANCES}`,
      `  fs.inotify.max_user_watches   = ${INOTIFY_REC_WATCHES}`,
      '',
      'Then reload: sudo sysctl --system',
    ];
    errors.push(lines.join('\n'));
  }

  return errors;
}

/**
 * Args used to ask each binary for its version, returning exit 0 when present.
 * `--version` is unsupported on minikube, kubectl, and helm — they print errors
 * and exit non-zero. Docker accepts `--version`; the others use the `version`
 * subcommand (kubectl needs `--client` to avoid contacting an apiserver).
 */
const VERSION_ARGS: Record<string, string[]> = {
  minikube: ['version'],
  kubectl: ['version', '--client'],
  helm: ['version'],
  docker: ['--version'],
};

function checkPrerequisites(): string[] {
  const missing: string[] = [];
  for (const bin of ['minikube', 'kubectl', 'helm', 'docker'] as const) {
    const r = spawnSync(bin, VERSION_ARGS[bin], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) missing.push(bin);
  }
  return [...missing, ...checkInotifyLimits()];
}

// ── phase 1: cluster ──────────────────────────────────────────────────────────

function minikubeStatus(profile: string): string {
  const r = spawnSync('minikube', [...profileFlag(profile), 'status', '--format={{.Host}}'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return r.status === 0 ? r.stdout.trim() : 'Unknown';
}

function ciliumReady(): boolean {
  const r = spawnSync(
    'kubectl',
    ['get', 'daemonset', 'cilium', '-n', 'kube-system',
      '-o', 'jsonpath={.status.numberReady}'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return r.status === 0 && parseInt(r.stdout.trim(), 10) > 0;
}

async function ensureMinikubeRunning(opts: MinikubeOpts, resolvedCni: 'cilium' | 'bridge'): Promise<void> {
  const status = minikubeStatus(opts.profile);

  if (opts.reset && status !== 'Unknown') {
    logger.info('--reset: deleting existing minikube cluster');
    spawnSync('minikube', [...profileFlag(opts.profile), 'delete'], { stdio: 'inherit' });
  } else if (status === 'Running') {
    if (resolvedCni === 'cilium' && ciliumReady()) {
      logger.info('Minikube already running with Cilium — skipping start');
      return;
    } else if (resolvedCni === 'bridge') {
      logger.info('Minikube already running — skipping start (bridge CNI)');
      return;
    }
    logger.warn(
      'Minikube running but Cilium DaemonSet not found. ' +
      'Re-run with --reset to recreate the cluster.',
    );
  }

  logger.info({ cpus: opts.cpus, memory: opts.memory, cni: resolvedCni }, 'Starting minikube');
  const result = spawnSync(
    'minikube',
    [
      ...profileFlag(opts.profile),
      'start',
      `--cpus=${opts.cpus}`,
      `--memory=${opts.memory}`,
      `--disk-size=${opts.disk}`,
      '--driver=docker',
      `--cni=${resolvedCni}`,
      '--kubernetes-version=stable',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('minikube_start_failed');
}

async function waitForCilium(): Promise<void> {
  logger.info('Waiting for Cilium DaemonSet to be ready (up to 2 min)');
  const ready = await waitForDaemonSet('kube-system', 'cilium', 120_000);
  if (!ready) throw new Error('cilium_not_ready');
  logger.info('Cilium is ready');
}

// ── phase 1.5: istio ─────────────────────────────────────────────────────────

/**
 * Check whether istioctl is on PATH or download version 1.24.3 if absent.
 * Returns the path to the istioctl binary.
 */
function ensureIstioctl(): string {
  // Try PATH first
  const which = spawnSync('which', ['istioctl'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (which.status === 0 && which.stdout.trim()) {
    return 'istioctl';
  }

  // Not on PATH — download 1.24.3 to a temp dir
  const istioVersion = '1.24.3';
  const homeDir = process.env.HOME ?? '/root';
  const istioDir = `${homeDir}/istio-${istioVersion}`;
  const istioctlPath = `${istioDir}/bin/istioctl`;

  // Already downloaded?
  const check = spawnSync('test', ['-f', istioctlPath], { stdio: 'pipe' });
  if (check.status === 0) {
    logger.info({ path: istioctlPath }, 'Using previously downloaded istioctl');
    return istioctlPath;
  }

  logger.info(`istioctl not found on PATH — downloading v${istioVersion}`);
  const download = spawnSync(
    'bash',
    [
      '-c',
      `curl -L https://istio.io/downloadIstio | ISTIO_VERSION=${istioVersion} TARGET_ARCH=$(uname -m) sh -`,
    ],
    { stdio: 'inherit', cwd: homeDir },
  );
  if (download.status !== 0) throw new Error('istioctl_download_failed');
  logger.info({ path: istioctlPath }, 'istioctl downloaded');
  return istioctlPath;
}

/**
 * Check if the virtualservices CRD exists — used as the idempotency sentinel.
 * If it does, Istio is already installed and we skip.
 */
function istioAlreadyInstalled(): boolean {
  const r = spawnSync(
    'kubectl',
    ['get', 'crd', 'virtualservices.networking.istio.io'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return r.status === 0;
}

/**
 * Install Istio using the minimal profile with low-resource proxy settings.
 * Idempotent: skips if the virtualservices CRD is already present.
 */
async function installIstio(): Promise<void> {
  if (istioAlreadyInstalled()) {
    logger.info('Istio already installed (virtualservices CRD present) — skipping');
    return;
  }

  logger.info('Installing Istio (minimal profile, low-resource proxies)');
  const istioctlPath = ensureIstioctl();

  const install = spawnSync(
    istioctlPath,
    [
      'install',
      '--set', 'profile=minimal',
      '--set', 'values.global.proxy.resources.requests.cpu=10m',
      '--set', 'values.global.proxy.resources.requests.memory=40Mi',
      '-y',
    ],
    { stdio: 'inherit' },
  );
  if (install.status !== 0) throw new Error('istio_install_failed');

  logger.info('Waiting for Istio pods to be Ready (up to 5 min)');
  const wait = spawnSync(
    'kubectl',
    [
      'wait',
      '--for=condition=Ready',
      'pods', '--all',
      '-n', 'istio-system',
      '--timeout=300s',
    ],
    { stdio: 'inherit' },
  );
  if (wait.status !== 0) throw new Error('istio_pods_not_ready');
  logger.info('Istio is ready');
}

// ── phase 2: image build ──────────────────────────────────────────────────────

function getMinikubeDockerEnv(profile: string): Record<string, string> {
  const r = spawnSync('minikube', [...profileFlag(profile), 'docker-env', '--shell=bash'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error('docker_env_failed');

  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^export\s+(\w+)="([^"]*)"/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function buildImages(projectRoot: string, dockerEnv: Record<string, string>): Promise<void> {
  const mergedEnv = { ...process.env, ...dockerEnv };

  // Build agent image via build.sh (no flag builds just kubeclaw-agent:latest)
  const buildScript = path.join(projectRoot, 'container', 'build.sh');
  logger.info('Building kubeclaw-agent image inside minikube daemon');
  const agentResult = spawnSync(buildScript, [], {
    cwd: projectRoot,
    env: mergedEnv,
    stdio: 'inherit',
  });
  if (agentResult.status !== 0) throw new Error('image_build_failed');

  // Build orchestrator image
  logger.info('Building kubeclaw-orchestrator image inside minikube daemon');
  const orchResult = spawnSync(
    'docker',
    ['build', '-t', 'kubeclaw-orchestrator:latest', '.'],
    { cwd: projectRoot, env: mergedEnv, stdio: 'inherit' },
  );
  if (orchResult.status !== 0) throw new Error('image_build_failed');

  logger.info('Images built directly into minikube daemon (imagePullPolicy: Never)');
}

// ── phase 3: falco ────────────────────────────────────────────────────────────

async function installFalco(projectRoot: string): Promise<void> {
  const falcoValuesPath = path.join(projectRoot, 'helm', 'falco', 'values.yaml');

  logger.info('Adding falcosecurity Helm repo');
  spawnSync('helm', ['repo', 'add', 'falcosecurity',
    'https://falcosecurity.github.io/charts'], { stdio: 'inherit' });
  spawnSync('helm', ['repo', 'update'], { stdio: 'inherit' });

  logger.info('Installing Falco (this may take a few minutes for eBPF probe load)');
  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install', 'falco', 'falcosecurity/falco',
      '--namespace', 'falco',
      '--create-namespace',
      '-f', falcoValuesPath,
      '--timeout', '5m',
      '--wait',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('falco_install_failed');

  logger.info('Waiting for Falco DaemonSet to be ready (up to 3 min)');
  const ready = await waitForDaemonSet('falco', 'falco', 180_000);
  if (!ready) throw new Error('falco_not_ready');
  logger.info('Falco is ready');
}

// ── phase 4: deploy kubeclaw ─────────────────────────────────────────────────

async function deployKubeclaw(projectRoot: string, useCilium: boolean): Promise<void> {
  const chartPath = path.join(projectRoot, 'helm', 'kubeclaw');
  const valuesPath = path.join(chartPath, 'values-minikube.yaml');
  const ciliumValuesPath = path.join(chartPath, 'values-cilium.yaml');

  const helmArgs = [
    'upgrade', '--install', 'kubeclaw', chartPath,
    '-f', valuesPath,
  ];

  if (useCilium) {
    helmArgs.push('-f', ciliumValuesPath);
    logger.info('Deploying KubeClaw via Helm (minikube + Cilium values)');
  } else {
    logger.info('Deploying KubeClaw via Helm (minikube values, bridge CNI)');
  }

  helmArgs.push(
    '--namespace', 'kubeclaw',
    '--create-namespace',
    '--timeout', '3m',
    '--wait',
  );

  const result = spawnSync('helm', helmArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    const podStatus = runKubectl(['get', 'pods', '-n', 'kubeclaw'], 30);
    throw Object.assign(new Error('helm_deploy_failed'), { podStatus });
  }

  // Apply pod-security labels to the namespace.
  // --create-namespace creates the namespace without these labels, so we
  // apply them here. --overwrite is idempotent on re-runs.
  logger.info('Applying pod-security labels to kubeclaw namespace');
  const labelResult = spawnSync(
    'kubectl',
    [
      'label', 'namespace', 'kubeclaw',
      'pod-security.kubernetes.io/enforce=privileged',
      'pod-security.kubernetes.io/enforce-version=latest',
      '--overwrite',
    ],
    { stdio: 'inherit' },
  );
  if (labelResult.status !== 0) {
    throw new Error('pod_security_label_failed');
  }
}

// ── phase 5: verify ───────────────────────────────────────────────────────────

async function verify(useCilium: boolean): Promise<Record<string, string | boolean>> {
  const ns = 'kubeclaw';
  const fields: Record<string, string | boolean> = {};

  fields.ORCHESTRATOR_READY = await waitForPodRunning(ns, 'app=kubeclaw-orchestrator', 60_000);
  fields.REDIS_READY = await waitForPodRunning(ns, 'app=kubeclaw-redis', 30_000);

  const secretCheck = spawnSync(
    'kubectl', ['get', 'secret', 'kubeclaw-secrets', '-n', ns],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  fields.SECRETS_EXIST = secretCheck.status === 0;

  const falcoCheck = spawnSync(
    'kubectl',
    ['get', 'daemonset', 'falco', '-n', 'falco',
      '-o', 'jsonpath={.status.numberReady}'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  fields.FALCO_READY = falcoCheck.status === 0 && parseInt(falcoCheck.stdout.trim(), 10) > 0;

  if (useCilium) {
    const cnpLines = runKubectl(
      ['get', 'ciliumnetworkpolicies', '-n', ns, '--no-headers'], 10,
    );
    fields.CILIUM_POLICIES = cnpLines
      ? cnpLines.trim().split('\n').filter(Boolean).length.toString()
      : '0';
  }

  return fields;
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const opts = parseArgs(args);

  const resolvedCni = resolveCni(opts.cni);
  const useCilium = resolvedCni === 'cilium';

  logger.info({ ...opts, resolvedCni }, 'Starting minikube setup');

  // Prerequisites (binary checks + inotify limits merged via checkPrerequisites)
  const preflightErrors = checkPrerequisites();
  if (preflightErrors.length > 0) {
    emitStatus('SETUP_MINIKUBE_START', {
      STATUS: 'failed',
      ERROR: 'preflight_failed',
      LOG: preflightErrors.join('\n'),
    });
    process.exit(1);
  }

  emitStatus('SETUP_MINIKUBE_START', { STATUS: 'ok', PREREQUISITES: 'all present' });

  // Phase 1: cluster
  try {
    await ensureMinikubeRunning(opts, resolvedCni);
    if (useCilium) {
      await waitForCilium();
    }
    emitStatus('SETUP_MINIKUBE_CLUSTER', { STATUS: 'ok', CNI: resolvedCni });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diag = useCilium
      ? runKubectl(['get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=cilium'], 10)
      : undefined;
    emitStatus('SETUP_MINIKUBE_CLUSTER', {
      STATUS: 'failed',
      ERROR: msg,
      ...(diag ? { CILIUM_PODS: truncateText(diag) } : {}),
    });
    process.exit(1);
  }

  // Phase 1.5: Istio
  if (!opts.skipIstio) {
    try {
      await installIstio();
      emitStatus('SETUP_MINIKUBE_ISTIO', { STATUS: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const diag = runKubectl(['get', 'pods', '-n', 'istio-system'], 10);
      emitStatus('SETUP_MINIKUBE_ISTIO', {
        STATUS: 'failed',
        ERROR: msg,
        ...(diag ? { ISTIO_PODS: truncateText(diag) } : {}),
      });
      process.exit(1);
    }
  } else {
    logger.info('Skipping Istio install (--skip-istio)');
    emitStatus('SETUP_MINIKUBE_ISTIO', { STATUS: 'skipped' });
  }

  // Phase 2: images
  if (!opts.skipBuild) {
    try {
      const dockerEnv = getMinikubeDockerEnv(opts.profile);
      await buildImages(projectRoot, dockerEnv);
      emitStatus('SETUP_MINIKUBE_IMAGES', { STATUS: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitStatus('SETUP_MINIKUBE_IMAGES', { STATUS: 'failed', ERROR: msg });
      process.exit(1);
    }
  } else {
    logger.info('Skipping image build (--skip-build)');
    emitStatus('SETUP_MINIKUBE_IMAGES', { STATUS: 'skipped' });
  }

  // Phase 3: Falco
  if (!opts.skipFalco) {
    try {
      await installFalco(projectRoot);
      emitStatus('SETUP_MINIKUBE_FALCO', { STATUS: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const diag = runKubectl(['get', 'pods', '-n', 'falco'], 10);
      emitStatus('SETUP_MINIKUBE_FALCO', {
        STATUS: 'failed',
        ERROR: msg,
        ...(diag ? { FALCO_PODS: truncateText(diag) } : {}),
      });
      process.exit(1);
    }
  } else {
    logger.info('Skipping Falco install (--skip-falco)');
    emitStatus('SETUP_MINIKUBE_FALCO', { STATUS: 'skipped' });
  }

  // Phase 3.5: cert-manager
  // Required by the kubeclaw chart's credentialInjection internal-CA template
  // (Issuer + Certificate CRDs). The installer is idempotent: production
  // clusters with cert-manager already installed get a no-op.
  try {
    const certManagerResult = await installCertManager({
      skip: opts.skipCertManager,
    });
    emitStatus('SETUP_MINIKUBE_CERT_MANAGER', {
      STATUS: certManagerResult === 'skipped' ? 'skipped' : 'ok',
      RESULT: certManagerResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diag = runKubectl(['get', 'pods', '-n', 'cert-manager'], 10);
    emitStatus('SETUP_MINIKUBE_CERT_MANAGER', {
      STATUS: 'failed',
      ERROR: msg,
      ...(diag ? { CERT_MANAGER_PODS: truncateText(diag) } : {}),
    });
    process.exit(1);
  }

  // Phase 4: deploy
  try {
    await deployKubeclaw(projectRoot, useCilium);
    emitStatus('SETUP_MINIKUBE_DEPLOY', { STATUS: 'ok' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const extra = (err as Record<string, unknown>).podStatus as string | undefined;
    emitStatus('SETUP_MINIKUBE_DEPLOY', {
      STATUS: 'failed',
      ERROR: msg,
      HINT: 'helm status kubeclaw -n kubeclaw',
      ...(extra ? { POD_STATUS: truncateText(extra) } : {}),
    });
    process.exit(1);
  }

  // Phase 5: verify
  const verifyFields = await verify(useCilium);
  const allOk = Object.values(verifyFields).every((v) => v !== false && v !== '0');
  emitStatus('SETUP_MINIKUBE_VERIFY', {
    ...verifyFields,
    STATUS: allOk ? 'success' : 'degraded',
    HINT: allOk
      ? 'Run the /setup command to configure channels and credentials'
      : 'Some checks failed — run: kubectl get pods -n kubeclaw && kubectl get pods -n falco',
  });
}

// Run when invoked directly (e.g. `tsx setup/minikube.ts ...` via `npm run
// setup:minikube`). When imported by setup/index.ts as a step module, the
// dispatcher calls `run()` itself, so the gate prevents double execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    logger.error({ err }, 'minikube setup failed');
    process.exit(1);
  });
}
