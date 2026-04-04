import { execSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Port used to forward kubeclaw-redis to the host for e2e tests
// We use a non-standard port to avoid colliding with any host-local Redis.
export const KUBECLAW_REDIS_LOCAL_PORT = 16379;

const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw';
const NAMESPACE = 'kubeclaw';
const E2E_REDIS_PASSWORD = 'kubeclaw-e2e-redis-pass';
const REDIS_READY_TIMEOUT = 90_000;

// Keep a reference so teardown can kill the port-forward process
let portForwardProcess: ReturnType<typeof spawn> | null = null;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForRedisPod(): Promise<void> {
  console.log('⏳ Waiting for Redis pod to be Running...');
  const deadline = Date.now() + REDIS_READY_TIMEOUT;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'kubectl',
      [
        'get', 'pods',
        '-n', NAMESPACE,
        '-l', 'app=kubeclaw-redis',
        '-o', 'jsonpath={.items[0].status.phase}',
      ],
      { encoding: 'utf8' },
    );
    if (result.stdout === 'Running') return;
    await sleep(3000);
  }
  throw new Error(`Redis pod not Running after ${REDIS_READY_TIMEOUT}ms`);
}

/**
 * E2E Global Setup
 *
 * Runs once before all test suites
 */
export default async function setup() {
  console.log('🚀 E2E Global Setup starting...\n');

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), 'e2e', 'results');
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  // Check if minikube is installed
  let minikubeInstalled = false;
  try {
    execSync('which minikube', { stdio: 'pipe' });
    minikubeInstalled = true;
  } catch {
    console.log('❌ Minikube is not installed. Please install minikube first:');
    console.log('   See: https://minikube.sigs.k8s.io/docs/start/\n');
  }

  // Check if minikube is running
  let minikubeRunning = false;
  if (minikubeInstalled) {
    try {
      execSync('minikube status', { stdio: 'pipe' });
      minikubeRunning = true;
      console.log('✅ Minikube is running\n');
    } catch {
      console.log('⚠️  Minikube is not running. Attempting to start...\n');

      // Try to start minikube
      try {
        console.log('   Starting minikube with docker driver...');
        execSync(
          'minikube start --driver=docker --memory=4096 --cpus=2 --wait=all',
          {
            stdio: 'inherit',
            timeout: 300000, // 5 minute timeout
          },
        );
        console.log('✅ Minikube started successfully\n');
        minikubeRunning = true;
      } catch (startError) {
        console.error('❌ Failed to start minikube automatically\n');
        console.error('   You can try starting it manually with:');
        console.error(
          '   minikube start --driver=docker --memory=4096 --cpus=2\n',
        );
        console.error('   Or run the setup command:');
        console.error('   make setup-minikube\n');
        throw new Error(
          'Minikube is required for E2E tests but could not be started. ' +
            'Please start minikube manually and try again.',
        );
      }
    }
  }

  // Check kubectl connection
  if (minikubeRunning) {
    try {
      // Use minikube context
      execSync('kubectl config use-context minikube', { stdio: 'pipe' });
      execSync('kubectl cluster-info', { stdio: 'pipe' });
      console.log('✅ Kubernetes cluster is accessible\n');
    } catch {
      console.error(
        '❌ Kubernetes cluster not accessible even though minikube is running\n',
      );
      console.error('   Try the following commands:\n');
      console.error('   kubectl config use-context minikube');
      console.error('   kubectl cluster-info\n');
      throw new Error(
        'Kubernetes cluster is not accessible. ' +
          'Please ensure kubectl is configured correctly and try again.',
      );
    }
  } else {
    throw new Error(
      'Kubernetes is required for E2E tests but minikube is not available. ' +
        'Please install and start minikube before running E2E tests.',
    );
  }

  // ── Build agent container image into minikube Docker daemon ─────────────
  // The tool-server and agent runner are both served from kubeclaw-agent:latest.
  // We skip the build if the image already exists in the minikube daemon.
  console.log('🐳 Checking for kubeclaw-agent:latest in minikube...');
  try {
    const checkResult = spawnSync(
      'bash',
      ['-c', 'eval $(minikube docker-env) && docker image inspect kubeclaw-agent:latest -f "{{.Id}}" 2>/dev/null'],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (checkResult.status === 0 && checkResult.stdout.trim()) {
      console.log('✅ kubeclaw-agent:latest already present, skipping build\n');
    } else {
      console.log('🔨 Building kubeclaw-agent:latest inside minikube Docker daemon...');
      const buildResult = spawnSync(
        'bash',
        ['-c', 'eval $(minikube docker-env) && docker build -t kubeclaw-agent:latest -f container/Dockerfile .'],
        { encoding: 'utf8', stdio: 'inherit', timeout: 300_000 },
      );
      if (buildResult.status !== 0) {
        throw new Error(`Agent image build failed with exit code ${buildResult.status}`);
      }
      console.log('✅ kubeclaw-agent:latest built\n');
    }
  } catch (err) {
    console.warn(`⚠️  Could not build agent image: ${err}\n`);
    // Non-fatal — tests that spawn agent jobs will skip or fail gracefully
  }

  // ── Install kubeclaw via Helm ────────────────────────────────────────────
  // Pre-create the namespace with Helm ownership metadata so that helm can
  // manage it (the chart's namespace.yaml PATCHes it with pod-security labels).
  console.log('📦 Installing kubeclaw helm chart into kubeclaw namespace...');
  spawnSync('kubectl', ['create', 'namespace', NAMESPACE], { encoding: 'utf8' });
  spawnSync('kubectl', ['label', 'namespace', NAMESPACE,
    'app.kubernetes.io/managed-by=Helm',
  ], { encoding: 'utf8' });
  spawnSync('kubectl', ['annotate', 'namespace', NAMESPACE,
    `meta.helm.sh/release-name=${RELEASE}`,
    `meta.helm.sh/release-namespace=${NAMESPACE}`,
  ], { encoding: 'utf8' });

  const installResult = spawnSync(
    'helm',
    [
      'upgrade', '--install',
      RELEASE,
      CHART_DIR,
      '--namespace', NAMESPACE,
      '--timeout', '120s',
      '--set', `namespace=${NAMESPACE}`,
      '--set', 'secrets.anthropicApiKey=test-key',
      '--set', 'secrets.claudeCodeOauthToken=test-token',
      '--set', `redis.password=${E2E_REDIS_PASSWORD}`,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (installResult.status !== 0) {
    console.error('helm install stderr:', installResult.stderr);
    throw new Error(`helm install failed with exit code ${installResult.status}`);
  }
  console.log('✅ kubeclaw helm chart installed\n');

  // Wait for Redis pod to be ready before attempting port-forward
  await waitForRedisPod();
  console.log('✅ Redis pod running\n');

  // The Redis ACL init container disables the default user and creates named
  // users. Tests must authenticate as the "orchestrator" user which has full
  // permissions and uses the admin password from the Helm values.
  console.log('🔑 Verifying Redis ACL connectivity with orchestrator user...');
  try {
    const aclCheck = spawnSync(
      'kubectl',
      [
        'exec', '-n', NAMESPACE, 'kubeclaw-redis-0', '--',
        'redis-cli', '--user', 'orchestrator', '-a', E2E_REDIS_PASSWORD, 'PING',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (aclCheck.stdout?.trim() === 'PONG') {
      console.log('✅ Redis ACL verified (orchestrator user)\n');
    } else {
      console.warn(`⚠️  Redis ACL check returned: ${aclCheck.stdout?.trim()}\n`);
    }
  } catch (err) {
    console.warn(`⚠️  Could not verify Redis ACL: ${err}\n`);
  }

  // Set up a port-forward so e2e tests can subscribe/publish to the SAME
  // Redis that the in-cluster adapter containers use (kubeclaw-redis).
  // Without this, host-side subscribers connect to a host-local Redis while
  // adapter pods publish to the in-cluster Redis, so pub/sub never matches.
  try {
    console.log(
      `🔌 Starting kubectl port-forward kubeclaw-redis → localhost:${KUBECLAW_REDIS_LOCAL_PORT}`,
    );
    portForwardProcess = spawn(
      'kubectl',
      [
        'port-forward',
        '-n',
        NAMESPACE,
        'svc/kubeclaw-redis',
        `${KUBECLAW_REDIS_LOCAL_PORT}:6379`,
      ],
      { stdio: 'ignore', detached: false },
    );

    // Wait for port-forward to establish (retry up to 10s)
    let portReady = false;
    for (let i = 0; i < 5; i++) {
      await sleep(2000);
      const ncResult = spawnSync('nc', ['-z', 'localhost', String(KUBECLAW_REDIS_LOCAL_PORT)], { stdio: 'pipe' });
      if (ncResult.status === 0) {
        portReady = true;
        break;
      }
      console.log(`   Port-forward not ready yet, retrying... (${i + 1}/5)`);
    }
    if (!portReady) {
      throw new Error(`Port-forward to localhost:${KUBECLAW_REDIS_LOCAL_PORT} failed after 10s`);
    }
    console.log(
      `✅ kubeclaw-redis port-forward active on localhost:${KUBECLAW_REDIS_LOCAL_PORT}\n`,
    );

    // Tell all test files to use this forwarded Redis.
    // Use the "orchestrator" ACL user which has full permissions.
    process.env.KUBECLAW_REDIS_URL = `redis://orchestrator:${E2E_REDIS_PASSWORD}@localhost:${KUBECLAW_REDIS_LOCAL_PORT}`;
    // Also set REDIS_URL so tests that use process.env.REDIS_URL pick up the same instance
    process.env.REDIS_URL = process.env.KUBECLAW_REDIS_URL;
  } catch (err) {
    console.warn(
      `⚠️  Could not set up kubeclaw-redis port-forward: ${err}\n`,
    );
    // Non-fatal — tests that need it will still run but pub/sub tests may fail
  }

  console.log('✅ E2E Global Setup complete\n');
}

/**
 * E2E Global Teardown
 */
export async function teardown() {
  if (portForwardProcess) {
    portForwardProcess.kill();
    portForwardProcess = null;
  }

  spawnSync('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  spawnSync(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}
