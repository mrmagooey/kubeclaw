import { readFileSync, existsSync } from 'fs';
import { GlobalSpecialist, parseSpecialists } from './types.js';
import { listSpecialistOverrides } from '../skills/orchestrator/specialist-registry.js';
import { logger } from '../logger.js';

const BASELINE_PATH = '/etc/kubeclaw/specialists-baseline/specialists.json';

export function mergeCatalog(
  baseline: GlobalSpecialist[],
  overrides: GlobalSpecialist[],
): GlobalSpecialist[] {
  const byName = new Map<string, GlobalSpecialist>();
  for (const s of baseline) byName.set(s.name, s);
  for (const s of overrides) byName.set(s.name, s); // override wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(
  specialists: GlobalSpecialist[],
  generation: number,
): string {
  return JSON.stringify({ version: 1, generation, specialists }, null, 2);
}

export function loadBaselineFromDisk(path = BASELINE_PATH): GlobalSpecialist[] {
  if (!existsSync(path)) return [];
  try {
    const r = parseSpecialists(readFileSync(path, 'utf-8'));
    return r.ok ? r.specialists : [];
  } catch (err) {
    logger.warn(
      { err, path },
      'baseline catalog read/parse failed; treating as empty',
    );
    return [];
  }
}

export interface ReconcilerDeps {
  /** Loads the Helm-supplied baseline specialists (mounted ConfigMap or disk). */
  baselineLoader: () => GlobalSpecialist[];
  /** Server-side apply of the rendered JSON to the kubeclaw-specialists ConfigMap. */
  configMapApply: (rendered: string) => Promise<void>;
}

export class SpecialistReconciler {
  private generation = 0;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconcilerDeps) {}

  async apply(): Promise<void> {
    // Chain _applyOnce after the previous apply; swallow errors on the chain
    // so a failure does not permanently poison subsequent applies.
    const next = this.applyChain.then(() => this._applyOnce());
    this.applyChain = next.catch(() => {});
    return next;
  }

  private async _applyOnce(): Promise<void> {
    const baseline = this.deps.baselineLoader();
    const overrides = listSpecialistOverrides();
    const merged = mergeCatalog(baseline, overrides);
    this.generation += 1;
    const rendered = renderCatalog(merged, this.generation);
    try {
      await this.deps.configMapApply(rendered);
      logger.info(
        { generation: this.generation, count: merged.length },
        'specialists ConfigMap applied',
      );
    } catch (err) {
      logger.error({ err }, 'specialists ConfigMap apply failed');
      this.generation -= 1; // do not bump on failure
      throw err;
    }
  }
}
