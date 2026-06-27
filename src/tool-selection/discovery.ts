import type { ToolSpec } from '../tools/types.js';
import type { FetchJson } from './registry/search.js';
import { searchImages } from './registry/search.js';
import { fetchImageMetadata } from './registry/metadata.js';
import { draftToolSpec } from './registry/draft.js';
import { probeTool, type ProbeJobRunner } from './probe/probe.js';
import { checkEgressCredentialCoherence } from '../k8s/egress/coherence.js';
import { hasHardEgressEnforcement } from '../k8s/egress/substrate.js';
import type { ChatFn } from './matcher.js';
import { logger } from '../logger.js';

export interface DiscoveryDeps {
  fetchJson: FetchJson;
  chat: ChatFn;
  probe: ProbeJobRunner;
  catalogHostLookup: (id: string) => string | undefined;
  maxCandidates?: number;
}

export function makeSearchRegistry(
  deps: DiscoveryDeps,
): (taskDescription: string) => Promise<ToolSpec | null> {
  return async (taskDescription: string) => {
    const candidates = await searchImages(
      taskDescription,
      deps.fetchJson,
      deps.maxCandidates ?? 5,
    );
    for (const c of candidates) {
      try {
        const md = await fetchImageMetadata(c.repo, 'latest', deps.fetchJson);
        const drafted = await draftToolSpec({
          taskDescription,
          metadata: md,
          chat: deps.chat,
        });
        if (!drafted.ok) {
          logger.debug(
            { repo: c.repo, error: drafted.error },
            'draft rejected; next candidate',
          );
          continue;
        }
        const coherence = checkEgressCredentialCoherence(
          drafted.spec,
          deps.catalogHostLookup,
        );
        if (!coherence.ok) {
          logger.debug(
            { repo: c.repo, error: coherence.error },
            'incoherent egress/credentials; next candidate',
          );
          continue;
        }
        const verdict = await probeTool(drafted.spec, deps.probe);
        if (verdict.verified) return drafted.spec;
        logger.debug(
          { repo: c.repo, reason: verdict.reason },
          'probe failed; next candidate',
        );
      } catch (err) {
        logger.warn(
          { repo: c.repo, err },
          'candidate evaluation error; next candidate',
        );
      }
    }
    return null;
  };
}

/**
 * Factory that returns a registry search function only when the cluster has
 * hard egress enforcement (Cilium or Istio). Without enforcement, tier-3
 * discovery is disabled and this returns `undefined`.
 */
export function buildTsaSearchRegistry(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps,
): ((taskDescription: string) => Promise<ToolSpec | null>) | undefined {
  if (!hasHardEgressEnforcement(env)) return undefined;
  return makeSearchRegistry(deps);
}
