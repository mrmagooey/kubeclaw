import { loadBrokerConfig, type BrokerConfig } from '../credential-broker/config.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';
import { logger } from '../logger.js';

export interface CatalogInformerOpts {
  namespace: string;
  configMapName: string;
  readConfigMap: (namespace: string, name: string) => Promise<{ data?: Record<string, string> }>;
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
      const cm = await this.opts.readConfigMap(this.opts.namespace, this.opts.configMapName);
      const yamlText = cm.data?.['config.yaml'] ?? '';
      const cfg: BrokerConfig = loadBrokerConfig(yamlText);
      this.catalog = cfg.catalog;
    } catch (err) {
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
