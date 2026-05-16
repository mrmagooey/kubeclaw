import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import {
  KubeConfig,
  CoreV1Api,
  AuthenticationV1Api,
  V1TokenReview,
  V1Pod,
  V1Secret,
  makeInformer,
  ADD,
  UPDATE,
  DELETE,
} from '@kubernetes/client-node';
import { loadBrokerConfig } from './config.js';
import { Resolver } from './resolver.js';
import { IdentityVerifier } from './identity.js';
import { K8sSecretSource } from './k8s-secret-source.js';
import { PodInformer } from './pod-informer.js';
import { PinoAudit } from './audit.js';
import { handleExtAuthz } from './ext-authz.js';
import { Registry } from 'prom-client';
import { createMetrics } from './metrics.js';

const CONFIG_PATH =
  process.env.BROKER_CONFIG_PATH ?? '/etc/credential-broker/config.yaml';
const PORT = parseInt(process.env.BROKER_PORT ?? '8080', 10);
const NAMESPACE =
  process.env.BROKER_NAMESPACE ?? process.env.KUBECLAW_NAMESPACE ?? 'kubeclaw';
const AUDIENCE = process.env.BROKER_AUDIENCE ?? 'kubeclaw-credential-broker';
const SECRET_TTL_MS = parseInt(process.env.BROKER_SECRET_TTL_MS ?? '60000', 10);
const AUDIT_ONLY = process.env.BROKER_AUDIT_ONLY === 'true';
const METRICS_PORT = parseInt(process.env.BROKER_METRICS_PORT ?? '9090', 10);

/** Label selector for per-group credential Secrets. */
const GROUP_SECRETS_LABEL_SELECTOR = 'kubeclaw.io/group-secrets=true';

export function loadConfigOrThrow(path: string) {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `broker config not readable at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  try {
    return loadBrokerConfig(text);
  } catch (err) {
    throw new Error(
      `invalid broker config at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

export async function startBroker(): Promise<http.Server> {
  const config = loadConfigOrThrow(CONFIG_PATH);
  const metricsRegistry = new Registry();
  const metrics = createMetrics(metricsRegistry);
  logger.info(
    { auditOnly: AUDIT_ONLY, port: PORT, configPath: CONFIG_PATH },
    'credential broker starting',
  );

  const kc = new KubeConfig();
  kc.loadFromCluster();
  const coreApi = kc.makeApiClient(CoreV1Api);
  const authApi = kc.makeApiClient(AuthenticationV1Api);

  // ─── PodInformer: in-memory pod cache for istio owner-group IP-lookup ───────
  const podInformer = new PodInformer();

  const k8sPodInformer = makeInformer<V1Pod>(
    kc,
    `/api/v1/namespaces/${NAMESPACE}/pods`,
    () => coreApi.listNamespacedPod({ namespace: NAMESPACE }).then((r) => r),
  );

  const handlePodUpsert = (pod: V1Pod) => {
    const uid = pod.metadata?.uid;
    const podIP = pod.status?.podIP;
    if (!uid || !podIP) return;
    podInformer.upsert({
      uid,
      name: pod.metadata?.name ?? '',
      podIP,
      terminating: pod.metadata?.deletionTimestamp != null,
      annotations:
        (pod.metadata?.annotations as Record<string, string>) ?? {},
    });
  };

  k8sPodInformer.on(ADD, handlePodUpsert);
  k8sPodInformer.on(UPDATE, handlePodUpsert);
  k8sPodInformer.on(DELETE, (pod: V1Pod) => {
    const uid = pod.metadata?.uid;
    if (uid) podInformer.delete(uid);
  });
  k8sPodInformer.on('error', (err: unknown) => {
    logger.warn({ err }, 'pod informer error — will reconnect');
  });

  // Non-blocking; makeInformer reconnects automatically on watch errors.
  k8sPodInformer.start().catch((err: unknown) => {
    logger.error({ err }, 'pod informer failed to start');
  });

  // ─── K8sSecretSource: legacy operator-secret read + per-group group-creds cache ───
  const secretSource = new K8sSecretSource({
    readSecret: async (name) => {
      const res = await coreApi.readNamespacedSecret({
        name,
        namespace: NAMESPACE,
      });
      return {
        metadata: {
          name: res.metadata?.name,
          labels: res.metadata?.labels as Record<string, string> | undefined,
        },
        data: res.data ?? {},
      };
    },
    cacheTtlMs: SECRET_TTL_MS,
  });

  // ─── Group-secrets watcher: keeps K8sSecretSource in sync with per-group Secrets ──
  const k8sSecretInformer = makeInformer<V1Secret>(
    kc,
    `/api/v1/namespaces/${NAMESPACE}/secrets`,
    () =>
      coreApi
        .listNamespacedSecret({
          namespace: NAMESPACE,
          labelSelector: GROUP_SECRETS_LABEL_SELECTOR,
        })
        .then((r) => r),
    GROUP_SECRETS_LABEL_SELECTOR,
  );

  const makeSecretHandler =
    (type: 'ADDED' | 'MODIFIED' | 'DELETED') => (secret: V1Secret) => {
      secretSource.applyGroupSecretEvent({
        type,
        secret: {
          metadata: {
            name: secret.metadata?.name,
            labels: secret.metadata?.labels as
              | Record<string, string>
              | undefined,
          },
          data: secret.data ?? {},
        },
      });
    };

  k8sSecretInformer.on(ADD, makeSecretHandler('ADDED'));
  k8sSecretInformer.on(UPDATE, makeSecretHandler('MODIFIED'));
  k8sSecretInformer.on(DELETE, makeSecretHandler('DELETED'));
  k8sSecretInformer.on('error', (err: unknown) => {
    logger.warn({ err }, 'secret informer error — will reconnect');
  });

  k8sSecretInformer.start().catch((err: unknown) => {
    logger.error({ err }, 'secret informer failed to start');
  });

  // ─── operatorSecretReader: reads kubeclaw-secrets[catalogId] for fallback ───
  const operatorSecretReader = async (
    catalogId: string,
  ): Promise<string | null> => {
    try {
      return await secretSource.read({
        kind: 'Secret',
        name: 'kubeclaw-secrets',
        key: catalogId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('has no key')) {
        // Key absent in the operator secret — no fallback available.
        return null;
      }
      throw err;
    }
  };

  let resolver = new Resolver({
    mappings: config.mappings,
    catalog: config.catalog,
    groupSource: secretSource,
    operatorSecretReader,
  });

  fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
    try {
      const next = loadConfigOrThrow(CONFIG_PATH);
      resolver = new Resolver({
        mappings: next.mappings,
        catalog: next.catalog,
        groupSource: secretSource,
        operatorSecretReader,
      });
      logger.info({ count: next.mappings.length }, 'broker config reloaded');
      metrics.recordConfigReload({ result: 'success' });
    } catch (e) {
      logger.error({ err: e }, 'failed to reload broker config');
      metrics.recordConfigReload({ result: 'failure' });
    }
  });

  const identityVerifier = new IdentityVerifier({
    createTokenReview: async (token, audiences) => {
      const review: V1TokenReview = { spec: { token, audiences } };
      const res = await authApi.createTokenReview({ body: review });
      const s = res.status ?? {};
      return {
        status: {
          authenticated: s.authenticated ?? false,
          user: s.user
            ? {
                username: s.user.username,
                extra: s.user.extra as
                  | Record<string, string[]>
                  | undefined,
              }
            : undefined,
          error: s.error,
        },
      };
    },
    audience: AUDIENCE,
    namespace: NAMESPACE,
    podInformer,
  });

  const audit = new PinoAudit();

  const authzServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/authz') {
      res.writeHead(404).end();
      return;
    }

    // Extract source IP from the TCP connection (populated by Envoy for ext_authz).
    // Strip IPv4-mapped IPv6 prefix (::ffff:) if present.
    const rawAddr = req.socket.remoteAddress ?? '';
    const sourceIP = rawAddr.replace(/^::ffff:/, '') || undefined;

    handleExtAuthz(
      {
        authorization: req.headers['authorization'] as string | undefined,
        'x-forwarded-authority': req.headers['x-forwarded-authority'] as
          | string
          | undefined,
        'x-forwarded-client-cert': req.headers['x-forwarded-client-cert'] as
          | string
          | undefined,
        sourceIP,
      },
      {
        resolver,
        identityVerifier,
        secretSource,
        audit,
        auditOnly: AUDIT_ONLY,
        metrics,
      },
    )
      .then((out) => {
        for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
        res.writeHead(out.status).end();
      })
      .catch((err) => {
        logger.error({ err }, 'authz handler crashed');
        res.writeHead(500).end();
      });
  });

  const metricsServer = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await metricsRegistry.metrics();
      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.writeHead(200).end(body);
    } catch (err) {
      logger.error({ err }, 'metrics handler crashed');
      res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) => {
    authzServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'credential broker authz listening');
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    metricsServer.listen(METRICS_PORT, () => {
      logger.info(
        { port: METRICS_PORT },
        'credential broker metrics listening',
      );
      resolve();
    });
  });

  return authzServer;
}

// Direct-run guard: only invoke startBroker() when this module is the
// process entrypoint (e.g. `tsx src/credential-broker/index.ts` or
// `node dist/credential-broker/index.js`). When dispatched via
// `src/index.ts`, the dispatcher calls startBroker() explicitly.
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startBroker().catch((err) => {
    logger.error({ err }, 'broker failed to start');
    process.exit(1);
  });
}
