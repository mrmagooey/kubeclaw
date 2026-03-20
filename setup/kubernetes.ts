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

/**
 * Run a kubectl command and return output, or undefined if it fails.
 * Output is truncated to maxLines to avoid flooding logs.
 */
function runKubectl(args: string[], maxLines = 50): string | undefined {
  try {
    const result = spawnSync('kubectl', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return undefined;
    }
    const lines = result.stdout.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Truncate text to maxChars to avoid flooding status blocks.
 */
function truncateText(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... (truncated)';
}

function parseArgs(args: string[]): {
  namespace: string;
  storageClass?: string;
  skipBuild: boolean;
  registry?: string;
} {
  let namespace = 'kubeclaw';
  let storageClass: string | undefined;
  let skipBuild = true; // Default: skip build (opt-in)
  let registry: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--namespace' && args[i + 1]) {
      namespace = args[i + 1];
      i++;
    } else if (args[i] === '--storage-class' && args[i + 1]) {
      storageClass = args[i + 1];
      i++;
    } else if (args[i] === '--build') {
      skipBuild = false; // Build when --build flag is passed
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

    // Collect StatefulSet diagnostics (pod doesn't exist yet on apply failure)
    const redisStatefulsetEvents = runKubectl(
      ['describe', 'statefulset', 'kubeclaw-redis', '-n', namespace],
      50,
    );

    const statusFields: Record<string, string | number | boolean> = {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'redis_failed',
      LOG: 'logs/setup.log',
    };
    if (redisStatefulsetEvents) {
      statusFields.REDIS_STATEFULSET_EVENTS = truncateText(
        redisStatefulsetEvents,
      );
    }

    emitStatus('SETUP_KUBERNETES', statusFields);
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

    // Collect PVC diagnostics
    const storageStatus = runKubectl(['get', 'pvc', '-n', namespace], 50);
    const pvcEvents = runKubectl(
      ['describe', 'pvc', 'kubeclaw-groups', '-n', namespace],
      50,
    );

    const statusFields: Record<string, string | number | boolean> = {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'storage_failed',
      LOG: 'logs/setup.log',
    };
    if (storageStatus) {
      statusFields.STORAGE_STATUS = truncateText(storageStatus);
    }
    if (pvcEvents) {
      statusFields.PVC_EVENTS = truncateText(pvcEvents);
    }

    emitStatus('SETUP_KUBERNETES', statusFields);
    process.exit(1);
  }

  // Wait for Redis readiness
  logger.info('Waiting for Redis to be ready');
  const redisReady = await waitForRedis(namespace);
  if (!redisReady) {
    logger.error('Redis failed to become ready within timeout');

    // Collect Redis pod diagnostics
    const redisPodStatus = runKubectl(
      ['get', 'pods', '-n', namespace, '-l', 'app=kubeclaw-redis'],
      50,
    );
    const redisPodEvents = runKubectl(
      ['describe', 'pod', '-n', namespace, '-l', 'app=kubeclaw-redis'],
      50,
    );

    const statusFields: Record<string, string | number | boolean> = {
      NAMESPACE: namespace,
      STATUS: 'failed',
      ERROR: 'redis_not_ready',
      REDIS_READY: false,
      LOG: 'logs/setup.log',
    };
    if (redisPodStatus) {
      statusFields.REDIS_POD_STATUS = truncateText(redisPodStatus);
    }
    if (redisPodEvents) {
      statusFields.REDIS_POD_EVENTS = truncateText(redisPodEvents);
    }

    emitStatus('SETUP_KUBERNETES', statusFields);
    process.exit(1);
  }
  logger.info('Redis is ready');

  // Create secrets if needed
  logger.info('Checking secrets');
  const secretsExist = checkSecretsExist(namespace);
  if (!secretsExist) {
    logger.warn('Secrets not found — will need manual configuration');
  }

  // Build and push images if requested (--build flag)
  let imageBuilt: boolean | 'skipped' = 'skipped';
  if (!skipBuild) {
    logger.info('Building container images');
    imageBuilt = await buildAndPushImages(projectRoot, registry);
  } else {
    logger.info('Skipping image build (use --build to build images)');
  }

  // Apply orchestrator manifest
  logger.info('Deploying orchestrator');
  try {
    const orchestratorPath = path.join(k8sDir, '30-orchestrator.yaml');
    let content = fs.readFileSync(orchestratorPath, 'utf-8');

    // Update image references if registry specified
    if (registry) {
      content = content.replace(
        /image: kubeclaw-orchestrator:latest/g,
        `image: ${registry}/kubeclaw-orchestrator:latest`,
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
      `kubectl rollout status deployment/kubeclaw-orchestrator -n ${namespace} --timeout=120s`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    deploymentReady = true;
    logger.info('Orchestrator is ready');
  } catch {
    logger.warn('Deployment rollout timed out — collecting diagnostics');

    // Collect deployment diagnostics on timeout
    const deploymentEvents = runKubectl(
      ['describe', 'deployment', 'kubeclaw-orchestrator', '-n', namespace],
      50,
    );
    const podEvents = runKubectl(
      [
        'get',
        'events',
        '-n',
        namespace,
        '--sort-by=.lastTimestamp',
        '-o',
        'custom-columns=LASTSEEN:.lastTimestamp,REASON:.reason,MESSAGE:.message',
      ],
      20,
    );

    const statusFields: Record<string, string | number | boolean> = {
      NAMESPACE: namespace,
      SECRETS_CONFIGURED: secretsExist,
      IMAGES_BUILT: imageBuilt,
      DEPLOYMENT_READY: false,
      STATUS: 'failed',
      LOG: 'logs/setup.log',
    };
    if (deploymentEvents) {
      statusFields.DEPLOYMENT_EVENTS = truncateText(deploymentEvents);
    }
    if (podEvents) {
      statusFields.POD_EVENTS = truncateText(podEvents);
    }

    emitStatus('SETUP_KUBERNETES', statusFields);
    process.exit(1);
  }

  emitStatus('SETUP_KUBERNETES', {
    NAMESPACE: namespace,
    SECRETS_CONFIGURED: secretsExist,
    IMAGES_BUILT: imageBuilt,
    DEPLOYMENT_READY: deploymentReady,
    STATUS: 'success',
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
    execSync(`kubectl get secret kubeclaw-secrets -n ${namespace}`, {
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
  try {
    // Determine which build script flag to use
    // Use --all when pushing to registry (full build), --claude-only for minimal local deployment
    const buildFlag = registry ? '--all' : '--claude-only';
    logger.info({ buildFlag }, 'Building container images via build script');

    // Run the build script from project root
    execSync(
      `${path.join(projectRoot, 'container', 'build.sh')} ${buildFlag}`,
      {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Tag and push if registry specified
    if (registry) {
      logger.info({ registry }, 'Tagging and pushing images to registry');

      // Check if docker is available
      try {
        execSync('docker --version', { stdio: 'ignore' });
      } catch {
        logger.error(
          'Docker not found. Cannot push images to registry. ' +
            `Please manually push the images to ${registry} or install Docker.`,
        );
        return false;
      }

      // Tag and push Claude agent
      const localTag = 'kubeclaw-agent:claude';
      const remoteTag = `${registry}/kubeclaw-agent:claude`;

      try {
        execSync(`docker tag ${localTag} ${remoteTag}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        execSync(`docker push ${remoteTag}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        logger.info({ image: remoteTag }, 'Pushed image to registry');
      } catch (err) {
        logger.error({ err }, `Failed to tag/push image ${localTag}`);
        return false;
      }

      // Tag and push other images if they exist
      const imagesToPush = [
        {
          local: 'kubeclaw-agent:openrouter',
          remote: 'kubeclaw-agent:openrouter',
        },
        {
          local: 'kubeclaw-file-adapter:latest',
          remote: 'kubeclaw-file-adapter:latest',
        },
        {
          local: 'kubeclaw-http-adapter:latest',
          remote: 'kubeclaw-http-adapter:latest',
        },
        {
          local: 'kubeclaw-browser-sidecar:latest',
          remote: 'kubeclaw-browser-sidecar:latest',
        },
      ];

      for (const { local, remote } of imagesToPush) {
        try {
          // Check if image exists locally
          execSync(`docker inspect ${local}`, { stdio: 'ignore' });
          const remoteFullTag = `${registry}/${remote}`;
          execSync(`docker tag ${local} ${remoteFullTag}`, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          execSync(`docker push ${remoteFullTag}`, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          logger.info({ image: remoteFullTag }, 'Pushed image to registry');
        } catch (err) {
          // Image may not exist locally — skip, but warn on other errors
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('No such image') && !msg.includes('not found')) {
            logger.warn(
              { image: local, err },
              'Could not push optional image — skipping',
            );
          }
        }
      }
    }

    logger.info('Image build completed successfully');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to build images');
    return false;
  }
}

/**
 * Poll for Redis readiness.
 * Returns true if Redis pod reaches Running phase within timeout.
 */
async function waitForRedis(
  namespace: string,
  timeoutMs = 60000,
  intervalMs = 5000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = spawnSync(
        'kubectl',
        [
          'get',
          'pods',
          '-n',
          namespace,
          '-l',
          'app=kubeclaw-redis',
          '-o',
          'jsonpath={.items[0].status.phase}',
        ],
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      if (result.status === 0 && result.stdout.trim() === 'Running') {
        return true;
      }
    } catch {
      // Ignore errors during polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}
