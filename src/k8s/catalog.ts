import {
  loadBrokerConfig,
  type BrokerConfig,
} from '../credential-broker/config.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';
import { logger } from '../logger.js';

/** Returns true when a Kubernetes API error indicates the resource was not found (HTTP 404). */
function isNotFound(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    code?: number;
    response?: { statusCode?: number };
  };
  return (
    e?.statusCode === 404 ||
    e?.response?.statusCode === 404 ||
    e?.code === 404
  );
}

export interface CatalogInformerOpts {
  namespace: string;
  configMapName: string;
  readConfigMap: (
    namespace: string,
    name: string,
  ) => Promise<{ data?: Record<string, string> }>;
}

export class CatalogInformer {
  private catalog: CatalogEntry[] = [];

  constructor(private readonly opts: CatalogInformerOpts) {}

  getCatalog(): readonly CatalogEntry[] {
    return this.catalog;
  }

  getEntry(id: string): CatalogEntry | null {
    return this.catalog.find((e) => e.id === id) ?? null;
  }

  async sync(): Promise<void> {
    try {
      const cm = await this.opts.readConfigMap(
        this.opts.namespace,
        this.opts.configMapName,
      );
      const yamlText = cm.data?.['config.yaml'] ?? '';
      const cfg: BrokerConfig = loadBrokerConfig(yamlText);
      this.catalog = cfg.catalog;
    } catch (err) {
      if (isNotFound(err)) {
        // ConfigMap absent — expected when credentialInjection.mode=off.
        // Serve empty/previous catalog silently; this is not a problem.
        logger.debug(
          { configMapName: this.opts.configMapName },
          'broker catalog ConfigMap not found; serving previous catalog (mode=off?)',
        );
        return;
      }
      logger.warn({ err }, 'catalog sync failed; serving previous catalog');
    }
  }

  /** Start a periodic resync loop. Returns a stopper. */
  start(intervalMs = 30_000): () => void {
    void this.sync();
    const handle = setInterval(() => void this.sync(), intervalMs);
    return () => clearInterval(handle);
  }
}
