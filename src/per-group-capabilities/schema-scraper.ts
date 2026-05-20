import type { CapabilitySpec } from '../capabilities/types.js';
import type { PerGroupK8sClient } from './k8s-client.js';
import { getScope } from './types.js';
import { listAllInstances } from './db.js';
import {
  cacheSchemas,
  getCachedSchemas,
  type McpToolSchema,
} from './schema-cache.js';
import { logger } from '../logger.js';

const DEFAULT_SCRAPE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/**
 * Performs an HTTP MCP tools/list against the given endpoint URL and returns
 * the schemas. Pulled out as a callable for tests; production wires this to
 * the real @modelcontextprotocol/sdk client (see Task 10).
 */
export type CallToolsListFn = (endpointUrl: string) => Promise<McpToolSchema[]>;

export interface ScrapeArgs {
  client: PerGroupK8sClient;
  namespace: string;
  specs: CapabilitySpec[];
  callToolsList: CallToolsListFn;
  scrapeTimeoutMs?: number;
  /** In-memory failure counter, keyed by `${capability}|${image}`. */
  failureState?: { failures: Map<string, number> };
}

export async function scrapeMissingSchemas(args: ScrapeArgs): Promise<void> {
  const failures = args.failureState?.failures ?? new Map<string, number>();
  const groupSpecs = args.specs.filter((s) => getScope(s) === 'group');
  const allInstances = listAllInstances();

  for (const spec of groupSpecs) {
    const key = `${spec.name}|${spec.image}`;
    if (getCachedSchemas(spec.name, spec.image) !== null) continue;
    if ((failures.get(key) ?? 0) >= MAX_RETRIES) continue;

    const instance = allInstances.find((i) => i.capabilityName === spec.name);
    if (!instance) {
      logger.debug(
        { capability: spec.name },
        'schema_scrape_skipped_no_instance',
      );
      continue;
    }

    const start = Date.now();
    logger.info(
      { capability: spec.name, image: spec.image },
      'schema_scrape_started',
    );

    let scaleUpDone = false;
    try {
      await args.client.patchDeploymentReplicas(
        args.namespace,
        instance.deploymentName,
        1,
      );
      scaleUpDone = true;
      await args.client.waitForReady(
        args.namespace,
        instance.deploymentName,
        args.scrapeTimeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS,
      );
      const port = spec.port ?? 3000;
      const endpoint = `http://${instance.serviceName}.${args.namespace}.svc.cluster.local:${port}`;
      const schemas = await args.callToolsList(endpoint);
      cacheSchemas(spec.name, spec.image, schemas);
      logger.info(
        {
          capability: spec.name,
          image: spec.image,
          tool_count: schemas.length,
          duration_ms: Date.now() - start,
        },
        'schema_scrape_completed',
      );
    } catch (err) {
      const attempt = (failures.get(key) ?? 0) + 1;
      failures.set(key, attempt);
      logger.warn(
        {
          err,
          capability: spec.name,
          image: spec.image,
          attempt,
          will_retry: attempt < MAX_RETRIES,
        },
        'schema_scrape_failed',
      );
    } finally {
      if (scaleUpDone) {
        try {
          await args.client.patchDeploymentReplicas(
            args.namespace,
            instance.deploymentName,
            0,
          );
        } catch (err) {
          logger.warn(
            { err, deployment: instance.deploymentName },
            'schema_scrape: scale-down after attempt failed',
          );
        }
      }
    }
  }
}

export interface ScraperLoopHandle {
  stop(): void;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export function startSchemaScraperLoop(
  args: ScrapeArgs & { intervalMs?: number },
): ScraperLoopHandle {
  let stopped = false;
  const state = args.failureState ?? { failures: new Map<string, number>() };
  const intervalMs = args.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const tick = (): void => {
    if (stopped) return;
    void (async () => {
      try {
        await scrapeMissingSchemas({ ...args, failureState: state });
      } catch (err) {
        logger.warn({ err }, 'scrapeMissingSchemas threw');
      }
      if (!stopped) setTimeout(tick, intervalMs);
    })();
  };
  setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true;
    },
  };
}
