import { readFileSync, existsSync } from 'fs';
import { ToolSpec, parseToolCatalog } from './types.js';
import { listToolOverrides } from '../skills/orchestrator/tool-registry.js';
import { logger } from '../logger.js';

const BASELINE_PATH = '/etc/kubeclaw/tools-baseline/tools.json';

export function mergeCatalog(
  baseline: ToolSpec[],
  overrides: ToolSpec[],
): ToolSpec[] {
  const byName = new Map<string, ToolSpec>();
  for (const t of baseline) byName.set(t.name, t);
  for (const t of overrides) byName.set(t.name, t); // override wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(tools: ToolSpec[], generation: number): string {
  return JSON.stringify({ version: 1, generation, tools }, null, 2);
}

export function loadBaselineFromDisk(path = BASELINE_PATH): ToolSpec[] {
  if (!existsSync(path)) return [];
  try {
    const r = parseToolCatalog(readFileSync(path, 'utf-8'));
    return r.ok ? r.tools : [];
  } catch (err) {
    logger.warn(
      { err, path },
      'tool baseline catalog read/parse failed; treating as empty',
    );
    return [];
  }
}

/**
 * Resolve a tool by name from the merged catalog (baseline + SQLite overrides).
 * Used by the orchestrator at spawn time. `baselineLoader` defaults to disk.
 */
export function resolveToolByName(
  name: string,
  baselineLoader: () => ToolSpec[] = loadBaselineFromDisk,
): ToolSpec | undefined {
  const merged = mergeCatalog(baselineLoader(), listToolOverrides());
  return merged.find((t) => t.name === name);
}

export interface ReconcilerDeps {
  /** Loads the Helm-supplied baseline tools (mounted ConfigMap or disk). */
  baselineLoader: () => ToolSpec[];
  /** Server-side apply of the rendered JSON to the kubeclaw-tools ConfigMap. */
  configMapApply: (rendered: string) => Promise<void>;
}

export class ToolReconciler {
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
    const overrides = listToolOverrides();
    const merged = mergeCatalog(baseline, overrides);
    this.generation += 1;
    const rendered = renderCatalog(merged, this.generation);
    try {
      await this.deps.configMapApply(rendered);
      logger.info(
        { generation: this.generation, count: merged.length },
        'tools ConfigMap applied',
      );
    } catch (err) {
      logger.error({ err }, 'tools ConfigMap apply failed');
      this.generation -= 1; // do not bump on failure
      throw err;
    }
  }
}
