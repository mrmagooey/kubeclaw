/**
 * Step: minikube — Provision a local KubeClaw cluster on minikube.
 *
 * Phases:
 *   1. Start minikube with Cilium CNI
 *   2. Build container images into minikube's Docker daemon
 *   3. Install Falco (runtime security)
 *   4. Deploy KubeClaw via Helm (laptop-optimised values)
 *   5. Verify everything is running
 *
 * Usage:
 *   npm run setup:minikube
 *   npm run setup:minikube -- --reset          # delete & recreate cluster
 *   npm run setup:minikube -- --skip-build     # skip image build
 *   npm run setup:minikube -- --skip-falco     # skip Falco install
 *   npm run setup:minikube -- --cpus 6 --memory 8192
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';
import { runKubectl, truncateText, waitForDaemonSet, waitForPodRunning } from './k8s-utils.js';

interface MinikubeOpts {
  cpus: number;
  memory: number; // MiB
  disk: string;
  reset: boolean;
  skipBuild: boolean;
  skipFalco: boolean;
}

function parseArgs(args: string[]): MinikubeOpts {
  let cpus = 4;
  let memory = 6144;
  let disk = '20g';
  let reset = false;
  let skipBuild = false;
  let skipFalco = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reset') reset = true;
    else if (args[i] === '--skip-build') skipBuild = true;
    else if (args[i] === '--skip-falco') skipFalco = true;
    else if (args[i] === '--cpus' && args[i + 1]) { cpus = parseInt(args[++i], 10); }
    else if (args[i] === '--memory' && args[i + 1]) { memory = parseInt(args[++i], 10); }
    else if (args[i] === '--disk' && args[i + 1]) { disk = args[++i]; }
  }

  return { cpus, memory, disk, reset, skipBuild, skipFalco };
}

// ── prerequisites ─────────────────────────────────────────────────────────────

function checkPrerequisites(): string[] {
  const missing: string[] = [];
  for (const bin of ['minikube', 'kubectl', 'helm', 'docker'] as const) {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) missing.push(bin);
  }
  return missing;
}

// ── phase 1: cluster ──────────────────────────────────────────────────────────

function minikubeStatus(): string {
  const r = spawnSync('minikube', ['status', '--format={{.Host}}'], {
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

async function ensureMinikubeRunning(opts: MinikubeOpts): Promise<void> {
  const status = minikubeStatus();

  if (opts.reset && status !== 'Unknown') {
    logger.info('--reset: deleting existing minikube cluster');
    spawnSync('minikube', ['delete'], { stdio: 'inherit' });
  } else if (status === 'Running') {
    if (ciliumReady()) {
      logger.info('Minikube already running with Cilium — skipping start');
      return;
    }
    logger.warn(
      'Minikube running but Cilium DaemonSet not found. ' +
      'Re-run with --reset to recreate the cluster with Cilium.',
    );
  }

  logger.info({ cpus: opts.cpus, memory: opts.memory }, 'Starting minikube with Cilium CNI');
  const result = spawnSync(
    'minikube',
    [
      'start',
      `--cpus=${opts.cpus}`,
      `--memory=${opts.memory}`,
      `--disk-size=${opts.disk}`,
      '--driver=docker',
      '--cni=cilium',
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

// ── phase 2: image build ──────────────────────────────────────────────────────

function getMinikubeDockerEnv(): Record<string, string> {
  const r = spawnSync('minikube', ['docker-env', '--shell=bash'], {
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

  // Build agent image(s) via build.sh
  const buildScript = path.join(projectRoot, 'container', 'build.sh');
  logger.info('Building kubeclaw-agent image inside minikube daemon');
  const agentResult = spawnSync(buildScript, ['--claude-only'], {
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

async function deployKubeclaw(projectRoot: string): Promise<void> {
  const chartPath = path.join(projectRoot, 'helm', 'kubeclaw');
  const valuesPath = path.join(chartPath, 'values-minikube.yaml');
  const ciliumValuesPath = path.join(chartPath, 'values-cilium.yaml');

  logger.info('Deploying KubeClaw via Helm (minikube + Cilium values)');
  const result = spawnSync(
    'helm',
    [
      'upgrade', '--install', 'kubeclaw', chartPath,
      '-f', valuesPath,
      '-f', ciliumValuesPath,
      '--namespace', 'kubeclaw',
      '--create-namespace',
      '--timeout', '3m',
      '--wait',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    const podStatus = runKubectl(['get', 'pods', '-n', 'kubeclaw'], 30);
    throw Object.assign(new Error('helm_deploy_failed'), { podStatus });
  }
}

// ── phase 5: verify ───────────────────────────────────────────────────────────

async function verify(): Promise<Record<string, string | boolean>> {
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

  const cnpLines = runKubectl(
    ['get', 'ciliumnetworkpolicies', '-n', ns, '--no-headers'], 10,
  );
  fields.CILIUM_POLICIES = cnpLines
    ? cnpLines.trim().split('\n').filter(Boolean).length.toString()
    : '0';

  return fields;
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const opts = parseArgs(args);

  logger.info(opts, 'Starting minikube setup');

  // Prerequisites
  const missing = checkPrerequisites();
  if (missing.length > 0) {
    emitStatus('SETUP_MINIKUBE_START', {
      STATUS: 'failed',
      ERROR: 'missing_prerequisites',
      MISSING: missing.join(', '),
      LOG: `Install missing tools: ${missing.join(', ')}`,
    });
    process.exit(1);
  }
  emitStatus('SETUP_MINIKUBE_START', { STATUS: 'ok', PREREQUISITES: 'all present' });

  // Phase 1: cluster
  try {
    await ensureMinikubeRunning(opts);
    await waitForCilium();
    emitStatus('SETUP_MINIKUBE_CLUSTER', { STATUS: 'ok', CNI: 'cilium' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diag = runKubectl(['get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=cilium'], 10);
    emitStatus('SETUP_MINIKUBE_CLUSTER', {
      STATUS: 'failed',
      ERROR: msg,
      ...(diag ? { CILIUM_PODS: truncateText(diag) } : {}),
    });
    process.exit(1);
  }

  // Phase 2: images
  if (!opts.skipBuild) {
    try {
      const dockerEnv = getMinikubeDockerEnv();
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

  // Phase 4: deploy
  try {
    await deployKubeclaw(projectRoot);
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
  const verifyFields = await verify();
  const allOk = Object.values(verifyFields).every((v) => v !== false && v !== '0');
  emitStatus('SETUP_MINIKUBE_VERIFY', {
    ...verifyFields,
    STATUS: allOk ? 'success' : 'degraded',
    HINT: allOk
      ? 'Run /setup in Claude Code to configure channels and credentials'
      : 'Some checks failed — run: kubectl get pods -n kubeclaw && kubectl get pods -n falco',
  });
}
