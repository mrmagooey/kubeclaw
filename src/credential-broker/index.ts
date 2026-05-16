import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import {
  KubeConfig,
  CoreV1Api,
  AuthenticationV1Api,
  V1TokenReview,
} from '@kubernetes/client-node';
import { loadBrokerConfig } from './config.js';
import { Resolver } from './resolver.js';
import { IdentityVerifier } from './identity.js';
import { K8sSecretSource } from './k8s-secret-source.js';
import { PinoAudit } from './audit.js';
import { handleExtAuthz } from './ext-authz.js';
import { Registry } from 'prom-client';
import { createMetrics } from './metrics.js';

const CONFIG_PATH =
  process.env.BROKER_CONFIG_PATH ?? '/etc/credential-broker/config.yaml';
const PORT = parseInt(process.env.BROKER_PORT ?? '8080', 10);
const NAMESPACE = process.env.BROKER_NAMESPACE ?? 'kubeclaw';
const AUDIENCE = process.env.BROKER_AUDIENCE ?? 'kubeclaw-credential-broker';
const SECRET_TTL_MS = parseInt(process.env.BROKER_SECRET_TTL_MS ?? '60000', 10);
const AUDIT_ONLY = process.env.BROKER_AUDIT_ONLY === 'true';
const METRICS_PORT = parseInt(process.env.BROKER_METRICS_PORT ?? '9090', 10);

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

  const identityVerifier = new IdentityVerifier({
    createTokenReview: async (token, audiences) => {
      const review: V1TokenReview = { spec: { token, audiences } };
      const res = await authApi.createTokenReview({ body: review });
      const s = res.status ?? {};
      return {
        status: {
          authenticated: s.authenticated ?? false,
          user: s.user ? { username: s.user.username } : undefined,
          error: s.error,
        },
      };
    },
    audience: AUDIENCE,
    namespace: NAMESPACE,
  });

  const secretSource = new K8sSecretSource({
    readSecret: async (name) => {
      const res = await coreApi.readNamespacedSecret({
        name,
        namespace: NAMESPACE,
      });
      return { data: res.data ?? {} };
    },
    cacheTtlMs: SECRET_TTL_MS,
  });

  // operatorSecretReader stub — Task 9 wires the real implementation.
  const operatorSecretReader = async (_key: string): Promise<string | null> => null;

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

  const audit = new PinoAudit();

  const authzServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/authz') {
      res.writeHead(404).end();
      return;
    }
    handleExtAuthz(
      {
        authorization: req.headers['authorization'] as string | undefined,
        'x-forwarded-authority': req.headers['x-forwarded-authority'] as
          | string
          | undefined,
        'x-forwarded-client-cert': req.headers['x-forwarded-client-cert'] as
          | string
          | undefined,
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
