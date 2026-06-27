import { pruneStaleAutoTools } from './provenance.js';
import { removeTool } from '../skills/orchestrator/tool-registry.js';

export async function sweepStaleAutoTools(deps: {
  now: number;
  ttlMs: number;
  reconcile: () => Promise<void>;
}): Promise<string[]> {
  const pruned = pruneStaleAutoTools(deps.now, deps.ttlMs);
  for (const name of pruned) {
    removeTool({ name }); // no per-call reconcile; we reconcile once below
  }
  if (pruned.length > 0) await deps.reconcile();
  return pruned;
}
