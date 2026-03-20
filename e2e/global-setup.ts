import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Port used to forward kubeclaw-redis to the host for e2e tests
// We use a non-standard port to avoid colliding with any host-local Redis.
export const KUBECLAW_REDIS_LOCAL_PORT = 16379;

// Keep a reference so teardown can kill the port-forward process
let portForwardProcess: ReturnType<typeof spawn> | null = null;

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

  // Set up a port-forward so e2e tests can subscribe/publish to the SAME
  // Redis that the in-cluster adapter containers use (kubeclaw-redis).
  // Without this, host-side subscribers connect to a host-local Redis while
  // adapter pods publish to the in-cluster Redis, so pub/sub never matches.
  if (minikubeRunning) {
    try {
      console.log(
        `🔌 Starting kubectl port-forward kubeclaw-redis → localhost:${KUBECLAW_REDIS_LOCAL_PORT}`,
      );
      portForwardProcess = spawn(
        'kubectl',
        [
          'port-forward',
          '-n',
          'kubeclaw',
          'svc/kubeclaw-redis',
          `${KUBECLAW_REDIS_LOCAL_PORT}:6379`,
        ],
        { stdio: 'ignore', detached: false },
      );

      // Give it a moment to establish
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify the port is open
      execSync(`nc -z localhost ${KUBECLAW_REDIS_LOCAL_PORT}`, {
        stdio: 'pipe',
      });
      console.log(
        `✅ kubeclaw-redis port-forward active on localhost:${KUBECLAW_REDIS_LOCAL_PORT}\n`,
      );

      // Tell all test files to use this forwarded Redis
      process.env.KUBECLAW_REDIS_URL = `redis://localhost:${KUBECLAW_REDIS_LOCAL_PORT}`;
    } catch (err) {
      console.warn(
        `⚠️  Could not set up kubeclaw-redis port-forward: ${err}\n`,
      );
      // Non-fatal — tests that need it will still run but pub/sub tests may fail
    }
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
}
