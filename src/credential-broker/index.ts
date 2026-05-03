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

const CONFIG_PATH =
  process.env.BROKER_CONFIG_PATH ?? '/etc/credential-broker/config.yaml';
const PORT = parseInt(process.env.BROKER_PORT ?? '8080', 10);
const NAMESPACE = process.env.BROKER_NAMESPACE ?? 'kubeclaw';
const AUDIENCE = process.env.BROKER_AUDIENCE ?? 'kubeclaw-credential-broker';
const SECRET_TTL_MS = parseInt(process.env.BROKER_SECRET_TTL_MS ?? '60000', 10);

function loadConfigOrThrow(path: string) {
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
  let resolver = new Resolver(config.mappings);

  fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
    try {
      const next = loadConfigOrThrow(CONFIG_PATH);
      resolver = new Resolver(next.mappings);
      logger.info({ count: next.mappings.length }, 'broker config reloaded');
    } catch (e) {
      logger.error({ err: e }, 'failed to reload broker config');
    }
  });

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

  const audit = new PinoAudit();

  const server = http.createServer((req, res) => {
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
      },
      { resolver, identityVerifier, secretSource, audit },
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

  return new Promise((resolve) => {
    server.listen(PORT, () => {
      logger.info({ port: PORT }, 'credential broker listening');
      resolve(server);
    });
  });
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
