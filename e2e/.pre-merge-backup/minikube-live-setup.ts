/**
 * Global setup for the minikube-live suite.
 *
 * Stands up a fully helm-deployed kubeclaw release in minikube, pointed at the
 * real LLM provider at LIVE_LLM_BASE_URL. Runs in its own namespace
 * (`kubeclaw-live`) so it does not collide with any existing `kubeclaw`
 * install used by the regular e2e suite.
 *
 * Provider config (override via env vars):
 *   LIVE_LLM_BASE_URL   http://192.168.7.100:8080/v1
 *   LIVE_LLM_MODEL      gemma-4-E4B-it-Q4_0.gguf
 *   LIVE_LLM_API_KEY    no-key
 *
 * Channel pod auth (the deployed HTTP channel uses Basic auth):
 *   USER  = alice
 *   PASS  = livepass
 *
 * Test driver port-forwards svc/kubeclaw-channel-http →
 * localhost:KUBECLAW_LIVE_HTTP_LOCAL_PORT.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { installCertManager } from '../setup/cert-manager.js';

const NAMESPACE = 'kubeclaw-live';
const RELEASE = 'kubeclaw-live';
const CHART_DIR = './helm/kubeclaw';

export const KUBECLAW_LIVE_HTTP_LOCAL_PORT = 14081;
export const KUBECLAW_LIVE_REDIS_LOCAL_PORT = 16381;
export const KUBECLAW_LIVE_USER = 'alice';
export const KUBECLAW_LIVE_PASS = 'livepass';

// Read from a Secret at runtime (initialised inside setup()).
export let KUBECLAW_LIVE_REDIS_URL = '';

const LIVE_BASE_URL =
  process.env.LIVE_LLM_BASE_URL || 'http://192.168.7.100:8080/v1';
const LIVE_MODEL =
  process.env.LIVE_LLM_MODEL || 'gemma-4-E4B-it-Q4_0.gguf';
const LIVE_API_KEY = process.env.LIVE_LLM_API_KEY || 'no-key';

let portForwardProcess: ChildProcess | null = null;
let redisPortForwardProcess: ChildProcess | null = null;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number; allowFail?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 60_000,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(
      `[${cmd} ${args.join(' ')}] exit ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function ensureMinikube(): Promise<void> {
  // Try kubectl first — if a cluster is reachable, we don't care if it's
  // minikube specifically.
  const cluster = run('kubectl', ['cluster-info'], { allowFail: true });
  if (cluster.ok) {
    console.log('✅ Kubernetes cluster is reachable');
    return;
  }

  const which = run('which', ['minikube'], { allowFail: true });
  if (!which.ok) {
    throw new Error(
      'No reachable Kubernetes cluster and minikube is not installed.',
    );
  }

  console.log('🚀 Starting minikube...');
  // 8 GB / 4 CPU — the live-suite now installs ~6 capabilities at runtime
  // across the test files; under 4 GB/2 CPU the orchestrator's task-request
  // queue backs up and downstream test beforeAlls time out waiting for
  // Deployments. If the cluster already exists with smaller resources,
  // `minikube start` is a no-op for resource config — the operator must
  // `minikube delete` then re-run for the new size to take effect.
  const start = run(
    'minikube',
    ['start', '--driver=docker', '--memory=8192', '--cpus=4', '--wait=all'],
    { timeout: 300_000 },
  );
  if (!start.ok) {
    throw new Error('minikube start failed');
  }
  run('kubectl', ['config', 'use-context', 'minikube']);
  run('kubectl', ['cluster-info']);
}

async function ensureImage(
  imageName: string,
  dockerfile: string,
  contextDir: string = '.',
): Promise<void> {
  console.log(`🐳 Checking for ${imageName} in minikube docker daemon...`);
  const check = spawnSync(
    'bash',
    [
      '-c',
      `eval $(minikube docker-env) && docker image inspect ${imageName} -f "{{.Id}}" 2>/dev/null`,
    ],
    { encoding: 'utf8' },
  );
  if (check.status === 0 && check.stdout.trim()) {
    console.log(`✅ ${imageName} already present\n`);
    return;
  }

  console.log(`🔨 Building ${imageName} inside minikube docker daemon...`);
  const build = spawnSync(
    'bash',
    [
      '-c',
      `eval $(minikube docker-env) && docker build -t ${imageName} -f ${dockerfile} ${contextDir}`,
    ],
    { encoding: 'utf8', stdio: 'inherit', timeout: 900_000 },
  );
  if (build.status !== 0) {
    throw new Error(`${imageName} build failed (exit ${build.status})`);
  }
  console.log(`✅ ${imageName} built\n`);
}

function waitForPod(
  labelSelector: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = run(
        'kubectl',
        [
          'get', 'pods',
          '-n', NAMESPACE,
          '-l', labelSelector,
          '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
        ],
        { allowFail: true },
      );
      if (res.ok && res.stdout.trim().split(/\s+/).every((s) => s === 'True')) {
        return resolve();
      }
      await sleep(3000);
    }
    // Dump pod state for debugging
    const dump = run(
      'kubectl',
      ['get', 'pods', '-n', NAMESPACE, '-l', labelSelector, '-o', 'wide'],
      { allowFail: true },
    );
    reject(
      new Error(
        `pods matching ${labelSelector} not Ready within ${timeoutMs}ms\n${dump.stdout}\n${dump.stderr}`,
      ),
    );
  });
}

async function helmInstall(): Promise<void> {
  // Pre-create the namespace with Helm ownership metadata.
  run('kubectl', ['create', 'namespace', NAMESPACE], { allowFail: true });
  run('kubectl', [
    'label', 'namespace', NAMESPACE,
    'app.kubernetes.io/managed-by=Helm', '--overwrite',
  ]);
  run('kubectl', [
    'annotate', 'namespace', NAMESPACE,
    `meta.helm.sh/release-name=${RELEASE}`,
    `meta.helm.sh/release-namespace=${NAMESPACE}`,
    '--overwrite',
  ]);

  // Clean up any prior channel Secret left from a failed run — the chart
  // recreates it from values below.
  run('kubectl', [
    'delete', 'secret', 'kubeclaw-channel-http',
    '-n', NAMESPACE, '--ignore-not-found',
  ], { allowFail: true });

  // The chart has no auto-create path for irc channel secrets (unlike http
  // which keys off secrets.httpChannelUsers). Pre-create the secret manually
  // so the channel pod can read its env vars.
  run('kubectl', [
    'delete', 'secret', 'kubeclaw-channel-irc',
    '-n', NAMESPACE, '--ignore-not-found',
  ], { allowFail: true });
  run('kubectl', [
    'create', 'secret', 'generic', 'kubeclaw-channel-irc',
    '-n', NAMESPACE,
    '--from-literal=server=kubeclaw-capability-test-ircd',
    '--from-literal=port=6667',
    '--from-literal=nick=kubeclaw-bot',
    '--from-literal=channels=#live-test',
  ]);

  console.log(`📦 helm install ${RELEASE} → ${NAMESPACE} (LLM=${LIVE_BASE_URL}, model=${LIVE_MODEL})...`);
  const setArgs = [
    'upgrade', '--install', RELEASE, CHART_DIR,
    '--namespace', NAMESPACE,
    '-f', './helm/kubeclaw/values-minikube.yaml',
    '--timeout', '180s',
    '--set', `namespace=${NAMESPACE}`,
    '--set', `secrets.anthropicApiKey=test-key`,
    '--set', `secrets.claudeCodeOauthToken=test-token`,
    '--set', `secrets.openaiApiKey=${LIVE_API_KEY}`,
    '--set-string', `secrets.openaiBaseUrl=${LIVE_BASE_URL}`,
    '--set-string', `secrets.directLlmModel=${LIVE_MODEL}`,
    // Chart auto-creates kubeclaw-channel-http with these users.
    '--set', `secrets.httpChannelUsers=${KUBECLAW_LIVE_USER}:${KUBECLAW_LIVE_PASS}`,
    '--set', `credentialInjection.mode=off`,
    '--set', `networkPolicy.extraEgressPorts={8080,6333}`,
    // Note: the test MCP capability is installed at RUNTIME from the test
    // file (via Redis IPC), not at helm time — this avoids a startup-time race
    // where the orchestrator publishes capabilities_update before the channel
    // pod has subscribed to its control channel.
    '--set', `channels.http.enabled=true`,
    '--set', `channels.http.type=http`,
    '--set', `channels.http.httpPort=4080`,
    '--set', `channels.http.envVars[0].name=HTTP_CHANNEL_USERS`,
    '--set', `channels.http.envVars[0].key=users`,
    '--set', `channels.http.envVars[1].name=HTTP_CHANNEL_PORT`,
    '--set', `channels.http.envVars[1].key=port`,
    '--set', `channels.http.envVars[1].optional=true`,
    // Enable RAG (deploys Qdrant via the chart's StatefulSet and sets
    // QDRANT_URL on the channel pod at startup so RAG_ENABLED=true at
    // module load).
    '--set', 'rag.enabled=true',
    // Use the chart's `capabilities:` helm-time templates to deploy our
    // test embedding server as a Deployment+Service at
    // kubeclaw-capability-test-embed:8080 — channel pods reach it by name.
    '--set', 'capabilities.test-embed.image=kubeclaw-test-embedding:latest',
    '--set', 'capabilities.test-embed.port=8080',
    // Point the embedding client (in channel pod) at the test embedding
    // server. Also override embedding dim to match the fixture (1536).
    '--set-string', `secrets.embeddingBaseUrl=http://kubeclaw-capability-test-embed:8080/v1`,
    '--set', 'secrets.embeddingDim=1536',
    // Deploy the test IRC daemon as a capability pod. The capability template
    // renders a Deployment+Service named kubeclaw-capability-test-ircd.
    // Port 6667 is the IRC port; the readiness probe targets it via tcpSocket.
    // The HTTP side-channel (8080) is only reached via kubectl exec from tests.
    '--set', 'capabilities.test-ircd.image=kubeclaw-test-ircd:latest',
    '--set', 'capabilities.test-ircd.port=6667',
    // Deploy the IRC channel pod. The Secret kubeclaw-channel-irc was
    // pre-created above with the correct server/port/nick/channels values.
    '--set', 'channels.irc.enabled=true',
    '--set', 'channels.irc.type=irc',
    '--set', 'channels.irc.envVars[0].name=IRC_SERVER',
    '--set', 'channels.irc.envVars[0].key=server',
    '--set', 'channels.irc.envVars[1].name=IRC_PORT',
    '--set', 'channels.irc.envVars[1].key=port',
    '--set', 'channels.irc.envVars[2].name=IRC_NICK',
    '--set', 'channels.irc.envVars[2].key=nick',
    '--set', 'channels.irc.envVars[3].name=IRC_CHANNELS',
    '--set', 'channels.irc.envVars[3].key=channels',
  ];
  const install = run('helm', setArgs, { timeout: 240_000, allowFail: true });
  if (!install.ok) {
    throw new Error(
      `helm install failed:\nstderr: ${install.stderr}\nstdout: ${install.stdout}`,
    );
  }
  console.log('✅ helm install complete\n');
}

async function startPortForward(): Promise<void> {
  console.log(
    `🔌 Port-forward svc/kubeclaw-channel-http → localhost:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`,
  );
  // Auto-restart wrapper: `kubectl port-forward` exits cleanly when the
  // underlying TCP connection is reset (e.g. by a transient channel-pod
  // hiccup). Tests reconnect; we restart the forwarder transparently.
  portForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-channel-http ${KUBECLAW_LIVE_HTTP_LOCAL_PORT}:80 || true; sleep 1; done`,
    ],
    { stdio: 'ignore', detached: true },
  );

  // Wait for the port to accept connections.
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const nc = spawnSync(
      'nc',
      ['-z', 'localhost', String(KUBECLAW_LIVE_HTTP_LOCAL_PORT)],
      { stdio: 'pipe' },
    );
    if (nc.status === 0) {
      console.log(`✅ Port-forward live on :${KUBECLAW_LIVE_HTTP_LOCAL_PORT}\n`);
      return;
    }
  }
  throw new Error('Port-forward did not come up within 15s');
}

async function startRedisPortForward(): Promise<void> {
  // Look up the Redis admin password from the chart-managed Secret so the
  // test can authenticate as the 'orchestrator' ACL user.
  const pwdLookup = run('kubectl', [
    'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
    '-o', 'jsonpath={.data.admin-password}',
  ], { allowFail: true });
  if (!pwdLookup.ok || !pwdLookup.stdout) {
    throw new Error('failed to read kubeclaw-redis admin-password Secret');
  }
  const password = Buffer.from(pwdLookup.stdout, 'base64').toString('utf8');
  KUBECLAW_LIVE_REDIS_URL = `redis://orchestrator:${password}@localhost:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`;

  console.log(
    `🔌 Port-forward svc/kubeclaw-redis → localhost:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
  );
  redisPortForwardProcess = spawn(
    'bash',
    [
      '-c',
      `while true; do kubectl port-forward -n ${NAMESPACE} svc/kubeclaw-redis ${KUBECLAW_LIVE_REDIS_LOCAL_PORT}:6379 || true; sleep 1; done`,
    ],
    { stdio: 'ignore', detached: true },
  );
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const nc = spawnSync(
      'nc',
      ['-z', 'localhost', String(KUBECLAW_LIVE_REDIS_LOCAL_PORT)],
      { stdio: 'pipe' },
    );
    if (nc.status === 0) {
      console.log(`✅ Redis port-forward live on :${KUBECLAW_LIVE_REDIS_LOCAL_PORT}\n`);
      return;
    }
  }
  throw new Error('Redis port-forward did not come up within 15s');
}

/**
 * Exported for tests that restart the channel pod — `kubectl port-forward`
 * dies when its backing pod is deleted, so the test re-runs setup.
 */
export async function restartChannelPortForward(): Promise<void> {
  if (portForwardProcess) {
    try {
      portForwardProcess.kill();
    } catch {
      // ignore
    }
    portForwardProcess = null;
  }
  await startPortForward();
}

async function teardownImpl() {
  // Kill the bash wrapper AND its child kubectl process. The wrapper restarts
  // kubectl in a loop, so killing only the wrapper leaves a stray kubectl.
  const killTree = (p: ChildProcess | null) => {
    if (!p?.pid) return;
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      try { p.kill(); } catch { /* ignore */ }
    }
  };
  killTree(portForwardProcess);
  portForwardProcess = null;
  killTree(redisPortForwardProcess);
  redisPortForwardProcess = null;
  // Belt-and-braces: kill any lingering kubectl port-forward that targets our ports.
  spawnSync('bash', ['-c', `pkill -f 'kubectl port-forward.*${KUBECLAW_LIVE_HTTP_LOCAL_PORT}:80' || true`]);
  spawnSync('bash', ['-c', `pkill -f 'kubectl port-forward.*${KUBECLAW_LIVE_REDIS_LOCAL_PORT}:6379' || true`]);

  // Always uninstall — this is our own isolated namespace.
  run('helm', ['uninstall', RELEASE, '--namespace', NAMESPACE], {
    allowFail: true,
  });
  run(
    'kubectl',
    ['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--timeout=60s'],
    { allowFail: true, timeout: 90_000 },
  );
}

// Vitest 4: globalSetup's default export should return the teardown function.
// Also re-exported as a named `teardown` for tooling that uses the old contract.
export default async function setup() {
  console.log('🚀 minikube-live global setup starting...\n');
  await ensureMinikube();
  await ensureImage('kubeclaw-agent:latest', 'container/Dockerfile');
  // The orchestrator image is also used by channel pods (different command).
  await ensureImage('kubeclaw-orchestrator:latest', 'Dockerfile');
  await ensureImage('kubeclaw-test-mcp:latest', 'e2e/fixtures/test-mcp-server/Dockerfile', 'e2e/fixtures/test-mcp-server');
  await ensureImage(
    'kubeclaw-test-embedding:latest',
    'e2e/fixtures/test-embedding-server/Dockerfile',
    'e2e/fixtures/test-embedding-server',
  );
  await ensureImage(
    'kubeclaw-test-ircd:latest',
    'e2e/fixtures/test-ircd/Dockerfile',
    'e2e/fixtures/test-ircd',
  );

  try {
    await installCertManager();
  } catch (err) {
    console.warn(
      `⚠️  cert-manager install warning: ${err instanceof Error ? err.message : err}`,
    );
  }

  await helmInstall();

  console.log('⏳ Waiting for orchestrator pod Ready...');
  await waitForPod('app=kubeclaw-orchestrator', 240_000);
  console.log('⏳ Waiting for redis pod Ready...');
  await waitForPod('app=kubeclaw-redis', 180_000);
  console.log('⏳ Waiting for channel pod Ready...');
  await waitForPod('app=kubeclaw-channel-http', 240_000);
  console.log('⏳ Waiting for qdrant pod Ready...');
  await waitForPod('app=kubeclaw-qdrant', 240_000);
  console.log('⏳ Waiting for test embedding pod Ready...');
  await waitForPod('app=kubeclaw-capability-test-embed', 240_000);
  console.log('⏳ Waiting for test ircd pod Ready...');
  await waitForPod('app=kubeclaw-capability-test-ircd', 240_000);
  console.log('⏳ Waiting for IRC channel pod Ready...');
  await waitForPod('app=kubeclaw-channel-irc', 240_000);

  // The channel pod often loses its first Redis subscribe attempt — the
  // Redis pod's readiness probe goes True before the server is actually
  // accepting ACL'd connections, and ioredis bails after the default
  // maxRetriesPerRequest. Force a rollout restart so the channel pod's
  // subscribe runs against a fully-warm Redis.
  console.log('♻️  Restarting channel pod against warm Redis...');
  run('kubectl', [
    'rollout', 'restart', 'deployment/kubeclaw-channel-http',
    '-n', NAMESPACE,
  ]);
  // Wait briefly for the old pod's termination then for the new one to be Ready.
  await sleep(3000);
  await waitForPod('app=kubeclaw-channel-http', 240_000);
  // The test MCP capability is installed at runtime by the test itself,
  // so we don't wait for it here.

  await startPortForward();
  await startRedisPortForward();

  console.log('✅ minikube-live global setup complete\n');

  return teardownImpl;
}

export { teardownImpl as teardown };
