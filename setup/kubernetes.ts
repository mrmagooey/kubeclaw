/**
 * Step: kubernetes — Deploy NanoClaw to Kubernetes cluster.
 *
 * Applies manifests, creates secrets, and verifies deployment.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): {
  namespace: string;
  storageClass?: string;
  skipBuild: boolean;
  registry?: string;
} {
  let namespace = 'nanoclaw';
  let storageClass: string | undefined;
  let skipBuild = false;
  let registry: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--namespace' && args[i + 1]) {
      namespace = args[i + 1];
      i++;
    } else if (args[i] === '--storage-class' && args[i + 1]) {
      storageClass = args[i + 1];
      i++;
    } else if (args[i] === '--skip-build') {
      skipBuild = true;
    } else if (args[i] === '--registry' && args[i + 1]) {
      registry = args[i + 1];
      i++;
    }
  }

  return { namespace, storageClass, skipBuild, registry };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { namespace, storageClass, skipBuild, registry } = parseArgs(args);
  const k8sDir = path.join(projectRoot, 'k8s');

  logger.info({ namespace, skipBuild, registry }, 'Starting Kubernetes setup');

  // Verify kubectl is available and connected
  try {
    execSync('kubectl cluster-info', { stdio: 'ignore' });
    logger.info('Kubernetes cluster is accessible');
  } catch {
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'kubectl_not_connected',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Apply namespace
  logger.info('Creating namespace');
  try {
    execSync(`kubectl apply -f ${path.join(k8sDir, '00-namespace.yaml')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to create namespace');
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'namespace_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Apply network policy
  logger.info('Applying network policies');
  try {
    execSync(
      `kubectl apply -f ${path.join(k8sDir, '01-network-policy.yaml')}`,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    logger.error({ err }, 'Failed to apply network policies');
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'network_policy_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Apply Redis
  logger.info('Deploying Redis');
  try {
    execSync(`kubectl apply -f ${path.join(k8sDir, '10-redis.yaml')}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to deploy Redis');
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'redis_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Apply storage
  logger.info('Setting up storage');
  const storageManifest = storageClass
    ? '20-storage.yaml'
    : detectStorageManifest(k8sDir);
  try {
    const storagePath = path.join(k8sDir, storageManifest);
    if (fs.existsSync(storagePath)) {
      let content = fs.readFileSync(storagePath, 'utf-8');
      // Inject storage class if specified
      if (storageClass && content.includes('storageClassName:')) {
        content = content.replace(
          /storageClassName:.*$/gm,
          `storageClassName: ${storageClass}`,
        );
        const tempPath = path.join(projectRoot, 'tmp-storage.yaml');
        fs.writeFileSync(tempPath, content);
        execSync(`kubectl apply -f ${tempPath}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        fs.unlinkSync(tempPath);
      } else {
        execSync(`kubectl apply -f ${storagePath}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to setup storage');
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'storage_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Create secrets if needed
  logger.info('Checking secrets');
  const secretsExist = checkSecretsExist(namespace);
  if (!secretsExist) {
    logger.warn('Secrets not found — will need manual configuration');
  }

  // Build and push images if not skipped
  let imageBuilt = false;
  if (!skipBuild) {
    logger.info('Building container images');
    imageBuilt = await buildAndPushImages(projectRoot, registry);
  }

  // Apply orchestrator manifest
  logger.info('Deploying orchestrator');
  try {
    const orchestratorPath = path.join(k8sDir, '30-orchestrator.yaml');
    let content = fs.readFileSync(orchestratorPath, 'utf-8');

    // Update image references if registry specified
    if (registry) {
      content = content.replace(
        /image: nanoclaw-orchestrator:latest/g,
        `image: ${registry}/nanoclaw-orchestrator:latest`,
      );
      content = content.replace(
        /imagePullPolicy: Never/g,
        'imagePullPolicy: Always',
      );
    }

    // Apply with kubectl (pass via stdin to avoid shell injection)
    const applyResult = spawnSync('kubectl', ['apply', '-f', '-'], {
      input: content,
      encoding: 'utf8',
    });
    if (applyResult.status !== 0) {
      throw new Error(applyResult.stderr || 'kubectl apply failed');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to deploy orchestrator');
    emitStatus('SETUP_KUBERNETES', {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'orchestrator_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Wait for deployment
  logger.info('Waiting for orchestrator deployment');
  let deploymentReady = false;
  try {
    execSync(
      `kubectl rollout status deployment/nanoclaw-orchestrator -n ${namespace} --timeout=120s`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    deploymentReady = true;
    logger.info('Orchestrator is ready');
  } catch {
    logger.warn('Deployment rollout timed out — may still be starting');
  }

  emitStatus('SETUP_KUBERNETES', {
    NAMESPACE: namespace,
    SECRETS_CONFIGURED: secretsExist,
    IMAGES_BUILT: imageBuilt,
    DEPLOYMENT_READY: deploymentReady,
    STATUS: deploymentReady ? 'success' : 'partial',
    LOG: 'logs/setup.log',
  });
}

function detectStorageManifest(k8sDir: string): string {
  // Try to detect the right storage manifest based on environment
  try {
    const output = execSync(
      'kubectl get nodes -o jsonpath={.items[0].metadata.labels}',
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (output.includes('minikube')) {
      return '20-storage-minikube.yaml';
    }
  } catch {
    // Fall through to default
  }
  return '20-storage.yaml';
}

function checkSecretsExist(namespace: string): boolean {
  try {
    execSync(`kubectl get secret nanoclaw-secrets -n ${namespace}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function buildAndPushImages(
  projectRoot: string,
  registry?: string,
): Promise<boolean> {
  const agentTag = registry
    ? `${registry}/nanoclaw-agent:latest`
    : 'nanoclaw-agent:latest';

  try {
    // Build agent image
    logger.info('Building agent image');
    execSync(
      `docker build -t ${agentTag} -f container/Dockerfile ${projectRoot}`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // Push if registry specified
    if (registry) {
      logger.info({ registry }, 'Pushing images');
      execSync(`docker push ${agentTag}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    logger.info('Images built successfully');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to build images');
    return false;
  }
}
