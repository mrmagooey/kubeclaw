# Config-Driven RAG Capabilities (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RAG an optional, installable, pluggable capability — Qdrant installs as a capability (no Helm StatefulSet), embedding/backend config travels on the capability spec via two protocol adapters (`vector-store` / `remote`), and retrieval is wired into the agent loop so RAG is usable end to end.

**Architecture:** The capability container stays fully generic (SP1's `renderDeploymentAndService`); channel-side RAG behavior is selected by an `adapter` field on the spec's `provider` config, not by hardcoded backend switches. `vector-store` embeds + chunks locally and upserts/searches a Qdrant-compatible REST API; `remote` POSTs raw text to a backend that embeds (LightRAG). All embedding/chunk/retrieval config threads down from the discovery entry's `provider` block — no module-level `process.env` reads in the RAG core. Legacy persisted specs (`{backend:'qdrant'|'lightrag'}`) normalize on read to the new shape; no DB migration.

**Tech Stack:** TypeScript ESM (.js import suffixes), Vitest, the `yaml` package, Kubernetes YAML, Helm.

## Global Constraints

- **Every new field is optional.** A spec that omits `provider` (legacy) must still resolve via normalization. Existing `mcp`/`http` specs and rendered YAML are unchanged.
- **`backend` opens to free-form `string`** (label/metrics only, not behavior-bearing). Behavior is driven by `provider.adapter ∈ {'vector-store','remote'}`.
- **Embedding config lives on the spec** (`provider.embedding = { provider, model?, dim?, baseUrl?, apiKeyEnv? }`). The **raw API key never travels in the spec or discovery entry** — `apiKeyEnv` is the *name* of a channel-pod env var (default `OPENAI_API_KEY` for openai, `VOYAGE_API_KEY` for voyage). The key is read from `process.env[apiKeyEnv]` at embed time only.
- **Legacy spec normalization on read** via a pure `normalizeRagSpec()` reader — no DB migration, no schema change. `{kind:'rag', backend:'qdrant'}` → `{backend:'qdrant', provider:{adapter:'vector-store', embedding:{provider:'openai'}}}`; `{backend:'lightrag'}` → `{provider:{adapter:'remote'}}`.
- **Existing indexed Qdrant data is discarded** — acceptable because retrieval was never wired, so nothing ever read it.
- **Retrieval is non-fatal.** `augmentPrompt` returns the original prompt on any failure; providers catch and log internally.
- **ESM `.js` import suffix** on every relative import. **Colocated `*.test.ts`** next to the unit under test (e2e tests live in `e2e/`).
- **The codebase must compile and test green after every task's commit.** Order tasks so no commit leaves a broken switch/type.
- **Run a single test file with:**
  `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run <file>`
- **Run the full unit/integration suite (regression) with:**
  `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run --exclude 'e2e/**'`
- **Branch:** all work happens on `feat/capability-base-generalization` in the worktree `/home/peter/projects/kubeclaw/.worktrees/cap-overhaul`. Do NOT work on `main`.
- **Commit after each task** with the exact message given. Do not push or open a PR unless explicitly asked.

---

### Task 1: RAG provider-config types + back-compat normalization

Open the closed `backend` union to a free-form string, add the `RagProviderConfig` discriminated union, carry `provider` in the discovery entry's `kindMetadata`, and add a pure `normalizeRagSpec()` reader so legacy persisted specs map to the new shape. No behavior wired yet — later tasks consume these types.

**Files:**
- Modify: `src/capabilities/types.ts` — `RagCapabilitySpec` (lines 114–118), the rag member of `CapabilityDiscoveryEntry` (lines 171–178).
- Create: `src/capabilities/rag-config.ts` — defaults constants + `normalizeRagSpec()`.
- Test: `src/capabilities/rag-config.test.ts` (new).

**Interfaces:**
- **Produces:**
  - `interface VectorStoreProviderConfig { adapter: 'vector-store'; embedding: EmbeddingConfig; chunkSize?: number; chunkOverlap?: number; topK?: number; scoreThreshold?: number; }`
  - `interface RemoteProviderConfig { adapter: 'remote'; indexPath?: string; queryPath?: string; queryMode?: string; timeoutMs?: number; }`
  - `interface EmbeddingConfig { provider: 'openai' | 'voyage'; model?: string; dim?: number; baseUrl?: string; apiKeyEnv?: string; }`
  - `type RagProviderConfig = VectorStoreProviderConfig | RemoteProviderConfig;`
  - `RagCapabilitySpec` now: `{ kind: 'rag'; backend: string; provider?: RagProviderConfig; }` (provider optional so legacy rows without it still typecheck; normalization fills it).
  - rag discovery entry `kindMetadata`: `{ backend: string; provider: RagProviderConfig }`.
  - `interface NormalizedRagSpec extends RagCapabilitySpec { provider: RagProviderConfig }` (provider guaranteed present).
  - `function normalizeRagSpec(spec: RagCapabilitySpec): NormalizedRagSpec`
  - Default constants: `DEFAULT_VECTOR_STORE_CONFIG`, `DEFAULT_REMOTE_CONFIG`, `DEFAULT_EMBEDDING_BY_PROVIDER`.

**Steps:**

1. [ ] Write the failing test. Create `src/capabilities/rag-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeRagSpec } from './rag-config.js';
import type { RagCapabilitySpec } from './types.js';

describe('normalizeRagSpec', () => {
  it('maps a legacy qdrant spec to a vector-store adapter with openai defaults', () => {
    const legacy = {
      kind: 'rag',
      backend: 'qdrant',
      name: 'main-rag',
      image: 'qdrant/qdrant:latest',
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(legacy);
    expect(out.provider.adapter).toBe('vector-store');
    if (out.provider.adapter !== 'vector-store') throw new Error('unreachable');
    expect(out.provider.embedding.provider).toBe('openai');
    // Defaults are NOT eagerly inlined onto the spec — model/dim resolved later.
    expect(out.backend).toBe('qdrant');
  });

  it('maps a legacy lightrag spec to a remote adapter', () => {
    const legacy = {
      kind: 'rag',
      backend: 'lightrag',
      name: 'lr',
      image: 'lightrag:latest',
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(legacy);
    expect(out.provider.adapter).toBe('remote');
  });

  it('honours EMBEDDING_PROVIDER env when normalizing a legacy qdrant spec', () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = 'voyage';
    try {
      const out = normalizeRagSpec({
        kind: 'rag', backend: 'qdrant', name: 'q', image: 'qdrant/qdrant',
      } as RagCapabilitySpec);
      if (out.provider.adapter !== 'vector-store') throw new Error('unreachable');
      expect(out.provider.embedding.provider).toBe('voyage');
    } finally {
      if (prev === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = prev;
    }
  });

  it('passes through a spec that already has a provider unchanged', () => {
    const modern = {
      kind: 'rag', backend: 'weaviate', name: 'w', image: 'weaviate:1',
      provider: {
        adapter: 'vector-store',
        embedding: { provider: 'voyage', model: 'voyage-3', dim: 1024 },
        topK: 8,
      },
    } as RagCapabilitySpec;
    const out = normalizeRagSpec(modern);
    expect(out.provider).toBe(modern.provider);
  });

  it('defaults an unknown legacy backend to vector-store', () => {
    const out = normalizeRagSpec({
      kind: 'rag', backend: 'mystery', name: 'm', image: 'x',
    } as RagCapabilitySpec);
    expect(out.provider.adapter).toBe('vector-store');
  });
});
```

2. [ ] Run it, expect FAIL (module/function does not exist yet):
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run src/capabilities/rag-config.test.ts`
   Expected: `Cannot find module './rag-config.js'` (or compile error).

3. [ ] Implement. First edit `src/capabilities/types.ts`. Replace the `RagCapabilitySpec` block (lines 114–118):

```ts
export interface EmbeddingConfig {
  provider: 'openai' | 'voyage';
  /** Model name. Default per provider (openai text-embedding-3-small, voyage voyage-3). */
  model?: string;
  /** Vector dimension. Default per provider (openai 1536, voyage 1024). */
  dim?: number;
  /** Optional separate embedding endpoint base URL. */
  baseUrl?: string;
  /** Name of the channel-pod env var holding the API key. Default per provider. */
  apiKeyEnv?: string;
}

export interface VectorStoreProviderConfig {
  adapter: 'vector-store';
  embedding: EmbeddingConfig;
  /** Characters per chunk. Default 1800. */
  chunkSize?: number;
  /** Character overlap between chunks. Default 200. */
  chunkOverlap?: number;
  /** Max chunks retrieved per query. Default 5. */
  topK?: number;
  /** Minimum cosine similarity (0–1). Default 0.5. */
  scoreThreshold?: number;
}

export interface RemoteProviderConfig {
  adapter: 'remote';
  /** Index endpoint path. Default '/documents/text'. */
  indexPath?: string;
  /** Query endpoint path. Default '/query'. */
  queryPath?: string;
  /** Query mode passed to the backend. Default 'hybrid'. */
  queryMode?: string;
  /** Request timeout in ms. Default 30000 index / 15000 query. */
  timeoutMs?: number;
}

export type RagProviderConfig =
  | VectorStoreProviderConfig
  | RemoteProviderConfig;

export interface RagCapabilitySpec extends CapabilityBase {
  kind: 'rag';
  /** Free-form backend label ('qdrant', 'weaviate', 'lightrag'…) — not behaviour-bearing. */
  backend: string;
  /** Adapter + embedding/retrieval config. Optional on persisted legacy rows; filled by normalizeRagSpec(). */
  provider?: RagProviderConfig;
}
```

Then replace the rag member of `CapabilityDiscoveryEntry` (lines 171–178):

```ts
  | {
      name: string;
      kind: 'rag';
      endpoint: string;
      kindMetadata: { backend: string; provider: RagProviderConfig };
      state?: 'ready' | 'warming' | 'failed';
      error?: string;
    }
```

Create `src/capabilities/rag-config.ts`:

```ts
/**
 * RAG provider-config defaults and legacy-spec normalization.
 *
 * Persisted specs may predate the `provider` field (`{kind:'rag', backend:'qdrant'}`).
 * normalizeRagSpec() maps such legacy rows to the adapter-based shape on read —
 * no DB migration. Specs that already carry `provider` pass through unchanged.
 */
import type {
  EmbeddingConfig,
  RagCapabilitySpec,
  RagProviderConfig,
  VectorStoreProviderConfig,
  RemoteProviderConfig,
} from './types.js';

export const DEFAULT_EMBEDDING_BY_PROVIDER: Record<
  EmbeddingConfig['provider'],
  { model: string; dim: number; apiKeyEnv: string }
> = {
  openai: { model: 'text-embedding-3-small', dim: 1536, apiKeyEnv: 'OPENAI_API_KEY' },
  voyage: { model: 'voyage-3', dim: 1024, apiKeyEnv: 'VOYAGE_API_KEY' },
};

export const DEFAULT_VECTOR_STORE_CONFIG = {
  chunkSize: 1800,
  chunkOverlap: 200,
  topK: 5,
  scoreThreshold: 0.5,
} as const;

export const DEFAULT_REMOTE_CONFIG = {
  indexPath: '/documents/text',
  queryPath: '/query',
  queryMode: 'hybrid',
  indexTimeoutMs: 30_000,
  queryTimeoutMs: 15_000,
} as const;

/** Spec guaranteed to carry a resolved provider config. */
export interface NormalizedRagSpec extends RagCapabilitySpec {
  provider: RagProviderConfig;
}

function legacyProviderFor(backend: string): RagProviderConfig {
  if (backend === 'lightrag') {
    const remote: RemoteProviderConfig = { adapter: 'remote' };
    return remote;
  }
  // 'qdrant' and any unknown legacy backend default to vector-store.
  const envProvider = process.env.EMBEDDING_PROVIDER;
  const provider: EmbeddingConfig['provider'] =
    envProvider === 'voyage' ? 'voyage' : 'openai';
  const vs: VectorStoreProviderConfig = {
    adapter: 'vector-store',
    embedding: { provider },
  };
  return vs;
}

/**
 * Return a spec with a guaranteed `provider`. If the spec already has one it is
 * returned as-is (same reference); otherwise a provider is derived from the
 * legacy `backend` label.
 */
export function normalizeRagSpec(spec: RagCapabilitySpec): NormalizedRagSpec {
  if (spec.provider) return spec as NormalizedRagSpec;
  return { ...spec, provider: legacyProviderFor(spec.backend) };
}
```

4. [ ] Run, expect PASS:
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run src/capabilities/rag-config.test.ts`

   Note: existing `src/rag/provider.test.ts` and `src/channel-runner.ts` still reference `kindMetadata.backend` only — those compile fine because `backend` is still present on the entry. Do NOT change them in this task.

5. [ ] Regression run (whole non-e2e suite):
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run --exclude 'e2e/**'`
   If any existing test fails because `RagCapabilitySpec.backend` is now `string` not the literal union (e.g. a test asserting a `.toThrow()` on an unknown backend), note it — Task 4 removes the per-backend builders that throw. For now expect green; the union widening is backwards-compatible for assignment.

6. [ ] Commit:
   `git add -A && git commit -m "feat(rag): provider-config types + legacy-spec normalization (SP2 task 1)"`

---

### Task 2: Config-driven embedding client

Replace the module-load `process.env` reads (`PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`) with `embed(texts, embeddingConfig)`, and extract a pure `resolveEmbeddingDefaults(config)` so callers compute model/dim/apiKeyEnv from the spec. Keep a back-compat `embed(texts)` overload that reads env, so Task 3 can migrate all callers (store/indexer/retriever/provider) in one atomic commit.

**Files:**
- Modify: `src/runtime/embedding-client.ts` (entire file).
- Test: `src/runtime/embedding-client.test.ts` (extend; keep existing env-based tests working via the back-compat path).

**Interfaces:**
- **Consumes (Task 1):** `EmbeddingConfig`, `DEFAULT_EMBEDDING_BY_PROVIDER` from `../capabilities/rag-config.js` and `../capabilities/types.js`.
- **Produces:**
  - `interface ResolvedEmbedding { provider: 'openai' | 'voyage'; model: string; dim: number; baseUrl?: string; apiKey: string; }`
  - `function resolveEmbeddingDefaults(config: EmbeddingConfig): ResolvedEmbedding`
  - `async function embed(texts: string[], config?: EmbeddingConfig): Promise<number[][]>` (config optional → derive from env for back-compat).
  - Keep exporting `EMBEDDING_DIM` and `EMBEDDING_MODEL` (env-derived) **only** as deprecated back-compat until Task 3 removes their last consumers; mark `@deprecated`.

**Steps:**

1. [ ] Write the failing test. Append to `src/runtime/embedding-client.test.ts`:

```ts
  // ── Config-driven path ────────────────────────────────────────────────────
  describe('embed(texts, config)', () => {
    it('uses the model from the passed config (no env)', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce(makeOpenAIResponse([[0.1]]));
      const { embed } = await import('./embedding-client.js');
      await embed(['t'], {
        provider: 'openai',
        model: 'text-embedding-3-large',
        apiKeyEnv: 'OPENAI_API_KEY',
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-large' }),
      );
    });

    it('resolveEmbeddingDefaults fills model/dim/apiKey from provider defaults', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const { resolveEmbeddingDefaults } = await import('./embedding-client.js');
      const r = resolveEmbeddingDefaults({ provider: 'openai' });
      expect(r.model).toBe('text-embedding-3-small');
      expect(r.dim).toBe(1536);
      expect(r.apiKey).toBe('sk-test');
    });

    it('resolveEmbeddingDefaults reads the key from a custom apiKeyEnv', async () => {
      process.env.MY_EMBED_KEY = 'sk-custom';
      const { resolveEmbeddingDefaults } = await import('./embedding-client.js');
      const r = resolveEmbeddingDefaults({ provider: 'openai', apiKeyEnv: 'MY_EMBED_KEY' });
      expect(r.apiKey).toBe('sk-custom');
      delete process.env.MY_EMBED_KEY;
    });

    it('voyage config posts to the voyage endpoint with the config key', async () => {
      process.env.VOYAGE_API_KEY = 'pa-cfg';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.2] }] }),
      }));
      const { embed } = await import('./embedding-client.js');
      await embed(['t'], { provider: 'voyage', apiKeyEnv: 'VOYAGE_API_KEY' });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.voyageai.com/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer pa-cfg' }),
        }),
      );
      vi.unstubAllGlobals();
    });
  });
```

2. [ ] Run it, expect FAIL:
   `... npx vitest run src/runtime/embedding-client.test.ts`
   Expected: `resolveEmbeddingDefaults is not a function` / `embed` ignores the 2nd arg.

3. [ ] Implement. Rewrite `src/runtime/embedding-client.ts`:

```ts
/**
 * Provider-agnostic embedding client.
 *
 * Preferred API: embed(texts, config) where config is an EmbeddingConfig from a
 * RAG capability spec. The model/dim/apiKeyEnv defaults come from
 * resolveEmbeddingDefaults() — a pure function of the config. The raw key is
 * read from process.env[apiKeyEnv] at embed time only; it never lives in a spec.
 *
 * A back-compat embed(texts) form (no config) derives the config from the
 * EMBEDDING_PROVIDER/EMBEDDING_MODEL/OPENAI_BASE_URL env vars for callers not
 * yet migrated.
 */
import OpenAI from 'openai';
import { logger } from '../logger.js';
import { DEFAULT_EMBEDDING_BY_PROVIDER } from '../capabilities/rag-config.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export type EmbeddingProvider = 'openai' | 'voyage';

export interface ResolvedEmbedding {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
  baseUrl?: string;
  apiKey: string;
}

/** Pure: fill model/dim/baseUrl/apiKey from config + provider defaults + env key. */
export function resolveEmbeddingDefaults(config: EmbeddingConfig): ResolvedEmbedding {
  const defaults = DEFAULT_EMBEDDING_BY_PROVIDER[config.provider];
  const apiKeyEnv = config.apiKeyEnv ?? defaults.apiKeyEnv;
  return {
    provider: config.provider,
    model: config.model || defaults.model,
    dim: config.dim ?? defaults.dim,
    baseUrl: config.baseUrl,
    apiKey: process.env[apiKeyEnv] || '',
  };
}

/** Derive an EmbeddingConfig from env (back-compat path for callers without a config). */
function envEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.EMBEDDING_PROVIDER || 'openai') as EmbeddingProvider;
  return {
    provider,
    model: process.env.EMBEDDING_MODEL || undefined,
    dim: process.env.EMBEDDING_DIM ? parseInt(process.env.EMBEDDING_DIM, 10) : undefined,
    baseUrl:
      provider === 'openai'
        ? process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || undefined
        : process.env.VOYAGE_BASE_URL || undefined,
  };
}

/** @deprecated Use resolveEmbeddingDefaults(config).dim. Env-derived; removed once all callers thread config. */
export const EMBEDDING_DIM = process.env.EMBEDDING_DIM
  ? parseInt(process.env.EMBEDDING_DIM, 10)
  : DEFAULT_EMBEDDING_BY_PROVIDER[
      (process.env.EMBEDDING_PROVIDER === 'voyage' ? 'voyage' : 'openai')
    ].dim;

/** @deprecated Use resolveEmbeddingDefaults(config).model. */
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  DEFAULT_EMBEDDING_BY_PROVIDER[
    (process.env.EMBEDDING_PROVIDER === 'voyage' ? 'voyage' : 'openai')
  ].model;

// ── OpenAI ──────────────────────────────────────────────────────────────────

async function embedOpenAI(
  texts: string[],
  resolved: ResolvedEmbedding,
): Promise<number[][]> {
  const client = new OpenAI({
    apiKey: resolved.apiKey || 'no-key',
    ...(resolved.baseUrl ? { baseURL: resolved.baseUrl } : {}),
  });
  // Force float encoding — see history; the SDK defaults to base64 and self-hosted
  // servers that return plain floats get mis-decoded otherwise.
  const response = await client.embeddings.create({
    model: resolved.model,
    input: texts,
    encoding_format: 'float',
  });
  return response.data.map((d) => d.embedding);
}

// ── Voyage AI ─────────────────────────────────────────────────────────────────

async function embedVoyage(
  texts: string[],
  resolved: ResolvedEmbedding,
): Promise<number[][]> {
  if (!resolved.apiKey) {
    throw new Error('Voyage embedding requires an API key (apiKeyEnv is unset/empty)');
  }
  const base = resolved.baseUrl ?? 'https://api.voyageai.com';
  const response = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: resolved.model, input: texts }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${err}`);
  }
  const json = (await response.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a batch of texts. Pass the RAG spec's EmbeddingConfig; if omitted the
 * config is derived from env (back-compat). Returns one vector per input.
 */
export async function embed(
  texts: string[],
  config?: EmbeddingConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const resolved = resolveEmbeddingDefaults(config ?? envEmbeddingConfig());
  try {
    switch (resolved.provider) {
      case 'openai':
        return await embedOpenAI(texts, resolved);
      case 'voyage':
        return await embedVoyage(texts, resolved);
      default:
        throw new Error(`Unknown embedding provider: ${resolved.provider}`);
    }
  } catch (err) {
    logger.error(
      { err, provider: resolved.provider, count: texts.length },
      'Embedding failed',
    );
    throw err;
  }
}
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/embedding-client.test.ts`
   The existing env-based tests still pass via the `embed(texts)` back-compat path. (`RAG_ENABLED` is removed in Task 3 — the existing `RAG_ENABLED` describe block in this file is migrated there. If those three `RAG_ENABLED` tests fail now because the export is gone, you have NOT removed it yet — keep `RAG_ENABLED` exported in this task; remove only in Task 3.)

   To preserve green here, also keep this line in `embedding-client.ts` for now (removed in Task 3):
   ```ts
   /** @deprecated Removed in SP2 — retrieval gating now comes from provider presence. */
   export const RAG_ENABLED = !!(
     process.env.QDRANT_URL && process.env.EMBEDDING_PROVIDER !== 'none'
   );
   ```

5. [ ] Regression run:
   `... npx vitest run --exclude 'e2e/**'`

6. [ ] Commit:
   `git add -A && git commit -m "feat(rag): config-driven embed() + resolveEmbeddingDefaults (SP2 task 2)"`

---

### Task 3: Config-threaded store / indexer / retriever + adapter-based provider layer

Thread the resolved config down so the RAG core reads no `process.env`. `store` takes `{ endpoint, dim }`, `indexer` takes `{ endpoint, embedding, chunkSize, chunkOverlap, dim }`, `retriever` takes `{ endpoint, embedding, topK, scoreThreshold, dim }`. Remove `RAG_ENABLED` and migrate its tests. Then rewrite `src/rag/provider.ts` so `VectorStoreProvider` and `RemoteProvider` are constructed from the discovery entry's `provider` config — in the same commit so the codebase compiles and tests pass throughout.

**Files:**
- Modify: `src/rag/store.ts`, `src/rag/indexer.ts`, `src/rag/retriever.ts`, and remove `RAG_ENABLED` from `src/runtime/embedding-client.ts`.
- Modify: `src/rag/provider.ts` (entire file) — must be updated in the same commit as store/indexer/retriever since it calls their changed signatures.
- Test: `src/rag/store.test.ts`, `src/rag/indexer.test.ts`, `src/rag/retriever.test.ts` (rewrite to pass config; drop the `RAG_ENABLED` describe blocks), `src/rag/provider.test.ts` (rewrite to mock `getRagEntry` returning the new `kindMetadata.provider`).

**Interfaces:**
- **Consumes (Task 1, 2):** `EmbeddingConfig`, `VectorStoreProviderConfig` from types; `embed(texts, config)`, `resolveEmbeddingDefaults` from `../runtime/embedding-client.js`; `DEFAULT_VECTOR_STORE_CONFIG`, `DEFAULT_EMBEDDING_BY_PROVIDER` from rag-config.
- **Produces (store/indexer/retriever):**
  - `interface VectorStoreOpts { endpoint: string; dim: number; }`
  - `store.ts`: `ensureCollection(opts, groupFolder)`, `upsertPoints(opts, groupFolder, points)`, `search(opts, groupFolder, queryVector, topK, scoreThreshold)`, `deleteGroup(opts, groupFolder)` — all take `opts: VectorStoreOpts` as the first arg.
  - `interface IndexerConfig { endpoint: string; embedding: EmbeddingConfig; dim: number; chunkSize: number; chunkOverlap: number; }`
  - `indexer.ts`: `indexText(config, groupFolder, text, source, metrics?)`, `indexConversationTurn(config, groupFolder, userMessage, agentResponse)`.
  - `interface RetrieverConfig { endpoint: string; embedding: EmbeddingConfig; dim: number; topK: number; scoreThreshold: number; }`
  - `retriever.ts`: `retrieveContext(config, groupFolder, query, metrics?)`, `augmentPrompt(config, groupFolder, prompt)`.
- **Produces (provider):**
  - `class VectorStoreProvider implements RagProvider { name = 'vector-store' }` (built from `endpoint` + `VectorStoreProviderConfig`).
  - `class RemoteProvider implements RagProvider { name = 'remote' }` (built from `endpoint` + `RemoteProviderConfig`).
  - `getRagProvider()`, `resetRagProvider()`, `__resetRagProviderForTest()` unchanged signatures.
  - `augmentPrompt(groupFolder, prompt)` — unchanged signature (the provider, not the caller, threads its config).

**Steps:**

1. [ ] Write the failing tests. Rewrite `src/rag/store.test.ts` to pass `opts` as the first arg. Example shape (apply to all describe blocks):

```ts
const OPTS = { endpoint: 'http://qdrant-test:6333', dim: 3 };
// ...
const { ensureCollection } = await import('./store.js');
await ensureCollection(OPTS, 'mygroup');
// PUT body assertion now reads OPTS.dim:
expect(putBody.vectors.size).toBe(3);
```
   Remove the `process.env.QDRANT_URL` set/unset in `beforeEach`/`afterEach` and the `vi.mock('../runtime/embedding-client.js', () => ({ EMBEDDING_DIM: 3, RAG_ENABLED: true }))` mock — store no longer imports EMBEDDING_DIM. Update `search` calls to `search(OPTS, 'g', [..], 5, 0.5)` and URL assertions stay (`/collections/kubeclaw-...`). Add one new test:

```ts
it('targets the endpoint from opts (not env)', async () => {
  stubFetch(() => qdrantOk());
  const { ensureCollection } = await import('./store.js');
  await ensureCollection({ endpoint: 'http://custom:9999', dim: 4 }, 'g');
  const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  expect(url.startsWith('http://custom:9999')).toBe(true);
});
```

   Rewrite `src/rag/indexer.test.ts`: replace the `embed`/store mocks to accept config and pass an `IndexerConfig` as the first arg of `indexText`/`indexConversationTurn`:

```ts
const CFG = {
  endpoint: 'http://q:6333',
  embedding: { provider: 'openai' as const },
  dim: 3,
  chunkSize: 1800,
  chunkOverlap: 200,
};
// store mock now takes opts first:
vi.mock('./store.js', () => ({
  upsertPoints: mockUpsertPoints, // (opts, group, points)
  ensureCollection: vi.fn().mockResolvedValue(undefined),
}));
// embed mock ignores its 2nd (config) arg:
mockEmbed.mockImplementation(async (texts: string[]) => texts.map((_, i) => [i*0.1, i*0.2, i*0.3]));
// call sites:
await indexText(CFG, 'mygroup', text, 'conversation');
const [, group, points] = mockUpsertPoints.mock.calls[0]; // opts, group, points
expect(group).toBe('mygroup');
await indexConversationTurn(CFG, 'g', 'user...', 'assistant...');
```

   Rewrite `src/rag/retriever.test.ts`: drop the `RAG_ENABLED` mock and the "returns empty when RAG_ENABLED is false" test (gating now lives in the provider). Pass a `RetrieverConfig` first arg:

```ts
const CFG = {
  endpoint: 'http://q:6333',
  embedding: { provider: 'openai' as const },
  dim: 3,
  topK: 5,
  scoreThreshold: 0.5,
};
vi.mock('./store.js', () => ({ search: mockSearch })); // search(opts, group, vec, topK, threshold)
// call sites:
const ctx = await retrieveContext(CFG, 'g', 'hello');
const result = await augmentPrompt(CFG, 'g', 'my prompt');
// embeds with config:
expect(mockEmbed).toHaveBeenCalledWith(['the user query'], CFG.embedding);
// search receives opts {endpoint,dim}:
expect(mockSearch).toHaveBeenCalledWith(
  { endpoint: CFG.endpoint, dim: CFG.dim }, 'mygroup', [0.1,0.2,0.3], 5, 0.5,
);
```
   Keep the `<retrieved_context>` formatting, numbering, score/source, and non-fatal tests.

2. [ ] Run store/indexer/retriever tests, expect FAIL:
   `... npx vitest run src/rag/store.test.ts src/rag/indexer.test.ts src/rag/retriever.test.ts`
   Expected: arity/argument mismatches.

3. [ ] Implement store/indexer/retriever.

   `src/rag/store.ts` — replace the `QDRANT_URL` module const and `EMBEDDING_DIM` import; add `VectorStoreOpts` first arg:

```ts
import { logger } from '../logger.js';

export interface VectorStoreOpts {
  endpoint: string;
  dim: number;
}

export interface QdrantPoint { /* unchanged */ }
export interface SearchResult { /* unchanged */ }

function collectionName(groupFolder: string): string {
  return `kubeclaw-${groupFolder}`;
}

async function qdrantFetch(
  opts: VectorStoreOpts,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = `${opts.endpoint.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Qdrant ${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

export async function ensureCollection(opts: VectorStoreOpts, groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try { await qdrantFetch(opts, `/collections/${name}`); return; } catch { /* 404 */ }
  await qdrantFetch(opts, `/collections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: opts.dim, distance: 'Cosine' } }),
  });
  logger.info({ collection: name }, 'Qdrant collection created');
}

export async function upsertPoints(opts: VectorStoreOpts, groupFolder: string, points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return;
  await ensureCollection(opts, groupFolder);
  await qdrantFetch(opts, `/collections/${collectionName(groupFolder)}/points?wait=true`, {
    method: 'PUT', body: JSON.stringify({ points }),
  });
}

export async function search(opts: VectorStoreOpts, groupFolder: string, queryVector: number[], topK = 5, scoreThreshold = 0.5): Promise<SearchResult[]> {
  const name = collectionName(groupFolder);
  let raw: unknown;
  try {
    raw = await qdrantFetch(opts, `/collections/${name}/points/search`, {
      method: 'POST',
      body: JSON.stringify({ vector: queryVector, limit: topK, score_threshold: scoreThreshold, with_payload: true }),
    });
  } catch (err) {
    logger.debug({ groupFolder, err }, 'Qdrant search returned no results');
    return [];
  }
  const result = raw as { result: { payload: { text: string; source: string }; score: number }[] };
  return (result.result ?? []).map((r) => ({ text: r.payload.text, source: r.payload.source, score: r.score }));
}

export async function deleteGroup(opts: VectorStoreOpts, groupFolder: string): Promise<void> {
  const name = collectionName(groupFolder);
  try {
    await qdrantFetch(opts, `/collections/${name}`, { method: 'DELETE' });
    logger.info({ collection: name }, 'Qdrant collection deleted');
  } catch { /* ignore */ }
}
```
   Keep the existing `QdrantPoint`/`SearchResult` interface bodies verbatim from the current file.

   `src/rag/indexer.ts` — add `IndexerConfig`, thread `embed(chunks, config.embedding)` and `upsertPoints({endpoint, dim}, ...)`, use `config.chunkSize`/`config.chunkOverlap`:

```ts
import crypto from 'crypto';
import { embed } from '../runtime/embedding-client.js';
import { upsertPoints, QdrantPoint } from './store.js';
import { logger } from '../logger.js';
import type { RagMetrics } from '../metrics/rag.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export interface IndexerConfig {
  endpoint: string;
  embedding: EmbeddingConfig;
  dim: number;
  chunkSize: number;
  chunkOverlap: number;
}

function chunk(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const slice = text.slice(start, end).trim();
    if (slice.length > 50) chunks.push(slice);
    if (end >= text.length) break;
    start = end - chunkOverlap;
  }
  return chunks;
}

function chunkId(groupFolder: string, text: string): string { /* unchanged body */ }

export async function indexText(config: IndexerConfig, groupFolder: string, text: string, source: string, metrics?: RagMetrics): Promise<void> {
  const chunks = chunk(text, config.chunkSize, config.chunkOverlap);
  if (chunks.length === 0) return;
  const start = Date.now();
  const vectors = await embed(chunks, config.embedding);
  const now = Date.now();
  const points: QdrantPoint[] = chunks.map((c, i) => ({
    id: chunkId(groupFolder, c),
    vector: vectors[i],
    payload: { text: c, source, timestamp: now, groupFolder },
  }));
  await upsertPoints({ endpoint: config.endpoint, dim: config.dim }, groupFolder, points);
  metrics?.recordIndex({ group: groupFolder, chunks: chunks.length, durationMs: Date.now() - start });
  logger.debug({ groupFolder, source, chunks: chunks.length }, 'Indexed text chunks');
}

export async function indexConversationTurn(config: IndexerConfig, groupFolder: string, userMessage: string, agentResponse: string): Promise<void> {
  const turn = `User: ${userMessage}\nAssistant: ${agentResponse}`;
  await indexText(config, groupFolder, turn, 'conversation').catch((err) => {
    logger.warn({ err, groupFolder }, 'Failed to index conversation turn');
  });
}
```
   Copy the existing `chunkId` body verbatim.

   `src/rag/retriever.ts` — add `RetrieverConfig`, remove the `RAG_ENABLED` import and the `TOP_K`/`SCORE_THRESHOLD` env consts, thread config:

```ts
import { embed } from '../runtime/embedding-client.js';
import { search } from './store.js';
import { logger } from '../logger.js';
import type { RagMetrics } from '../metrics/rag.js';
import type { EmbeddingConfig } from '../capabilities/types.js';

export interface RetrieverConfig {
  endpoint: string;
  embedding: EmbeddingConfig;
  dim: number;
  topK: number;
  scoreThreshold: number;
}

export async function retrieveContext(config: RetrieverConfig, groupFolder: string, query: string, metrics?: RagMetrics): Promise<string> {
  const start = Date.now();
  try {
    const [queryVector] = await embed([query], config.embedding);
    const results = await search(
      { endpoint: config.endpoint, dim: config.dim },
      groupFolder, queryVector, config.topK, config.scoreThreshold,
    );
    const hit = results.length > 0;
    metrics?.recordQuery({ group: groupFolder, hit, durationMs: Date.now() - start });
    if (!hit) return '';
    const chunks = results
      .map((r, i) => `[${i + 1}] (${r.source}, relevance ${r.score.toFixed(2)})\n${r.text}`)
      .join('\n\n');
    return `<retrieved_context>\nThe following excerpts from past conversations and documents may be relevant:\n\n${chunks}\n</retrieved_context>\n\n`;
  } catch (err) {
    metrics?.recordBackendError({ backend: 'qdrant' });
    logger.warn({ err, groupFolder }, 'RAG retrieval failed, continuing without context');
    return '';
  }
}

export async function augmentPrompt(config: RetrieverConfig, groupFolder: string, prompt: string): Promise<string> {
  const context = await retrieveContext(config, groupFolder, prompt);
  return context ? context + prompt : prompt;
}
```

   Remove `RAG_ENABLED` from `src/runtime/embedding-client.ts` (delete the `export const RAG_ENABLED = ...` line added back in Task 2 step 4). Migrate the three `RAG_ENABLED` describe-block tests out of `embedding-client.test.ts` (delete them — gating is now provider presence, covered by the NullRagProvider tests in this same task's provider.test.ts).

4. [ ] Run store/indexer/retriever tests, expect PASS:
   `... npx vitest run src/rag/store.test.ts src/rag/indexer.test.ts src/rag/retriever.test.ts src/runtime/embedding-client.test.ts`

5. [ ] Write the failing provider test. Rewrite `src/rag/provider.test.ts` (provider.ts is rewritten in step 6 below; run this test first to confirm it fails with the old shape):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../capabilities/client.js', () => ({ getRagEntry: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRagProvider, resetRagProvider } from './provider.js';
import { getRagEntry } from '../capabilities/client.js';

beforeEach(() => {
  resetRagProvider();
  vi.mocked(getRagEntry).mockReset();
  delete process.env.KUBECLAW_CHANNEL;
});

describe('getRagProvider (adapter-based)', () => {
  it('returns the remote provider for a remote adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'lr', endpoint: 'http://lr',
      kindMetadata: { backend: 'lightrag', provider: { adapter: 'remote' } },
    } as never);
    expect(getRagProvider().name).toBe('remote');
  });

  it('returns the vector-store provider for a vector-store adapter entry', () => {
    vi.mocked(getRagEntry).mockReturnValue({
      kind: 'rag', name: 'q', endpoint: 'http://q',
      kindMetadata: {
        backend: 'qdrant',
        provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
      },
    } as never);
    expect(getRagProvider().name).toBe('vector-store');
  });

  it('returns NullRagProvider when nothing configured', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    expect(getRagProvider().name).toBe('none');
  });

  it('passes KUBECLAW_CHANNEL to getRagEntry', () => {
    process.env.KUBECLAW_CHANNEL = 'telegram';
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('telegram');
  });

  it('falls back to wildcard channel name when KUBECLAW_CHANNEL is unset', () => {
    vi.mocked(getRagEntry).mockReturnValue(undefined);
    getRagProvider();
    expect(vi.mocked(getRagEntry)).toHaveBeenCalledWith('*');
  });
});
```

5b. [ ] Run, expect FAIL:
   `... npx vitest run src/rag/provider.test.ts`
   Expected: name `'qdrant'`/`'lightrag'` no longer matches; provider doesn't read `kindMetadata.provider`.

6. [ ] Implement. Rewrite `src/rag/provider.ts`:

```ts
import { logger } from '../logger.js';
import { getRagEntry } from '../capabilities/client.js';
import {
  DEFAULT_VECTOR_STORE_CONFIG,
  DEFAULT_REMOTE_CONFIG,
} from '../capabilities/rag-config.js';
import { resolveEmbeddingDefaults } from '../runtime/embedding-client.js';
import type {
  VectorStoreProviderConfig,
  RemoteProviderConfig,
} from '../capabilities/types.js';

export interface RagProvider {
  readonly name: string;
  indexConversationTurn(groupFolder: string, userMessage: string, agentResponse: string): Promise<void>;
  retrieveContext(groupFolder: string, query: string): Promise<string>;
}

class NullRagProvider implements RagProvider {
  readonly name = 'none';
  async indexConversationTurn(): Promise<void> {}
  async retrieveContext(): Promise<string> { return ''; }
}

class VectorStoreProvider implements RagProvider {
  readonly name = 'vector-store';
  private readonly endpoint: string;
  private readonly cfg: VectorStoreProviderConfig;
  private readonly dim: number;

  constructor(endpoint: string, cfg: VectorStoreProviderConfig) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.cfg = cfg;
    this.dim = resolveEmbeddingDefaults(cfg.embedding).dim;
  }

  private indexerConfig() {
    return {
      endpoint: this.endpoint,
      embedding: this.cfg.embedding,
      dim: this.dim,
      chunkSize: this.cfg.chunkSize ?? DEFAULT_VECTOR_STORE_CONFIG.chunkSize,
      chunkOverlap: this.cfg.chunkOverlap ?? DEFAULT_VECTOR_STORE_CONFIG.chunkOverlap,
    };
  }

  private retrieverConfig() {
    return {
      endpoint: this.endpoint,
      embedding: this.cfg.embedding,
      dim: this.dim,
      topK: this.cfg.topK ?? DEFAULT_VECTOR_STORE_CONFIG.topK,
      scoreThreshold: this.cfg.scoreThreshold ?? DEFAULT_VECTOR_STORE_CONFIG.scoreThreshold,
    };
  }

  async indexConversationTurn(groupFolder: string, userMessage: string, agentResponse: string): Promise<void> {
    try {
      const { indexConversationTurn } = await import('./indexer.js');
      await indexConversationTurn(this.indexerConfig(), groupFolder, userMessage, agentResponse);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'vector-store RAG indexing failed');
    }
  }

  async retrieveContext(groupFolder: string, query: string): Promise<string> {
    try {
      const { retrieveContext } = await import('./retriever.js');
      return await retrieveContext(this.retrieverConfig(), groupFolder, query);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'vector-store RAG retrieval failed');
      return '';
    }
  }
}

class RemoteProvider implements RagProvider {
  readonly name = 'remote';
  private readonly baseUrl: string;
  private readonly cfg: RemoteProviderConfig;

  constructor(endpoint: string, cfg: RemoteProviderConfig) {
    this.baseUrl = endpoint.replace(/\/$/, '');
    this.cfg = cfg;
  }

  async indexConversationTurn(groupFolder: string, userMessage: string, agentResponse: string): Promise<void> {
    const text = `[Group: ${groupFolder}]\nUser: ${userMessage}\nAssistant: ${agentResponse}`;
    const path = this.cfg.indexPath ?? DEFAULT_REMOTE_CONFIG.indexPath;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_REMOTE_CONFIG.indexTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn({ status: res.status, body, groupFolder }, 'remote RAG indexing failed');
      }
    } catch (err) {
      logger.warn({ err, groupFolder }, 'remote RAG indexing failed');
    }
  }

  async retrieveContext(groupFolder: string, query: string): Promise<string> {
    const path = this.cfg.queryPath ?? DEFAULT_REMOTE_CONFIG.queryPath;
    const mode = this.cfg.queryMode ?? DEFAULT_REMOTE_CONFIG.queryMode;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_REMOTE_CONFIG.queryTimeoutMs),
      });
      if (!res.ok) {
        logger.debug({ status: res.status, groupFolder }, 'remote RAG query failed');
        return '';
      }
      const json = (await res.json()) as { response?: string };
      const response = json.response?.trim();
      if (!response) return '';
      return `<retrieved_context>\n${response}\n</retrieved_context>\n\n`;
    } catch (err) {
      logger.warn({ err, groupFolder }, 'remote RAG retrieval failed');
      return '';
    }
  }
}

let _provider: RagProvider | undefined;

export function getRagProvider(): RagProvider {
  if (_provider) return _provider;
  try {
    const channelName = process.env.KUBECLAW_CHANNEL ?? '*';
    const entry = getRagEntry(channelName);
    if (entry) {
      const provider = entry.kindMetadata.provider;
      if (provider.adapter === 'remote') {
        _provider = new RemoteProvider(entry.endpoint, provider);
        logger.info({ url: entry.endpoint }, 'RAG provider: remote');
        return _provider;
      }
      if (provider.adapter === 'vector-store') {
        _provider = new VectorStoreProvider(entry.endpoint, provider);
        logger.info({ url: entry.endpoint }, 'RAG provider: vector-store');
        return _provider;
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Capability lookup unavailable');
  }
  _provider = new NullRagProvider();
  logger.info('RAG provider: none (disabled)');
  return _provider;
}

export function resetRagProvider(): void { _provider = undefined; }

/** @deprecated Use resetRagProvider(). */
export function __resetRagProviderForTest(): void { _provider = undefined; }

export async function augmentPrompt(groupFolder: string, prompt: string): Promise<string> {
  const context = await getRagProvider().retrieveContext(groupFolder, prompt);
  return context ? context + prompt : prompt;
}
```

   Note: `getRagEntry` returns the new entry shape (`kindMetadata.provider`) only once the entry is built from a normalized spec — that wiring is Task 4/5. The provider trusts `kindMetadata.provider` to be present; the channel-side `syncCapabilitiesToLocalDb` (Task 5) must store the full normalized spec so `specToDiscoveryEntry` (Task 4) re-derives it.

6. [ ] Run provider test, expect PASS:
   `... npx vitest run src/rag/provider.test.ts`

7. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**'`
   `... npx tsc --noEmit` must also pass.

8. [ ] Commit:
   `git add -A && git commit -m "refactor(rag): thread config through store/indexer/retriever + adapter-based providers; drop env reads (SP2 task 3)"`

---

### Task 4: Generic RAG builder + registry collapse + discovery provider

Delete `rag-qdrant.ts`/`rag-lightrag.ts`; the `rag` case in `builders/index.ts` calls the generic renderer with a RAG storage default; `registry.ts` collapses the per-backend port table to a single 6333 fallback and emits `kindMetadata.provider` from the normalized spec. Consumes: `normalizeRagSpec` (Task 1); `VectorStoreOpts`/`RetrieverConfig` (Task 3).

**Files:**
- Delete: `src/capabilities/builders/rag-qdrant.ts`, `src/capabilities/builders/rag-lightrag.ts`, `src/capabilities/builders/rag-qdrant.test.ts`.
- Modify: `src/capabilities/builders/index.ts` (lines 1–26), `src/capabilities/registry.ts` (lines 29–48 ports/defaultPort, lines 55–85 specToDiscoveryEntry rag case).
- Test: `src/capabilities/builders/rag.test.ts` (new), extend `src/capabilities/registry.test.ts`.

**Interfaces:**
- **Consumes:** `normalizeRagSpec` from `../rag-config.js`; `renderDeploymentAndService`, `deploymentName` from `./common.js`; `KUBECLAW_NAMESPACE`.
- **Produces:** `buildRagYaml(spec: RagCapabilitySpec): string` in `builders/index.ts` (inline in the `rag` case, or a small local helper). `specToDiscoveryEntry` rag branch returns `kindMetadata: { backend, provider }`.

**Steps:**

1. [ ] Write the failing tests. Create `src/capabilities/builders/rag.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

vi.mock('../../config.js', () => ({ KUBECLAW_NAMESPACE: 'kubeclaw' }));

import { buildYaml } from './index.js';
import type { RagCapabilitySpec } from '../types.js';

const base: RagCapabilitySpec = {
  kind: 'rag', backend: 'qdrant', name: 'main-rag', image: 'qdrant/qdrant:latest',
};

describe('generic rag builder', () => {
  it('renders Deployment, Service, and PVC with the RAG storage default', () => {
    const yaml = buildYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('storage: 20Gi');
    expect(yaml).toContain('mountPath: /qdrant/storage');
    expect(yaml).toContain('containerPort: 6333');
  });

  it('parses to exactly Deployment + Service + PVC', () => {
    const docs = parseAllDocuments(buildYaml(base)).map((d) => d.toJSON());
    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
  });

  it('honours an explicit port and storage', () => {
    const yaml = buildYaml({
      ...base, backend: 'weaviate', port: 8080,
      storage: { sizeGi: 5, mountPath: '/data' },
    });
    expect(yaml).toContain('containerPort: 8080');
    expect(yaml).toContain('storage: 5Gi');
    expect(yaml).toContain('mountPath: /data');
  });

  it('applies SP1 probe + podSecurity fields', () => {
    const yaml = buildYaml({
      ...base, probe: { type: 'tcp', port: 6333 },
      podSecurity: { fsGroup: 1000 },
    });
    expect(yaml).toContain('tcpSocket:');
    expect(yaml).toContain('fsGroup: 1000');
  });
});
```

   Extend `src/capabilities/registry.test.ts` — add inside `describe('endpoint scheme')` or a new block:

```ts
  describe('rag discovery entry', () => {
    it('emits backend + normalized provider in kindMetadata for a legacy spec', () => {
      const entry = specToDiscoveryEntry({
        kind: 'rag', backend: 'qdrant', name: 'r', image: 'qdrant/qdrant',
      });
      if (entry.kind !== 'rag') throw new Error('expected rag entry');
      expect(entry.kindMetadata.backend).toBe('qdrant');
      expect(entry.kindMetadata.provider.adapter).toBe('vector-store');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-r:6333');
    });

    it('passes an explicit provider through to kindMetadata', () => {
      const entry = specToDiscoveryEntry({
        kind: 'rag', backend: 'lightrag', name: 'lr', image: 'lightrag', port: 9621,
        provider: { adapter: 'remote', queryMode: 'naive' },
      });
      if (entry.kind !== 'rag') throw new Error('expected rag entry');
      expect(entry.kindMetadata.provider.adapter).toBe('remote');
      expect(entry.endpoint).toBe('http://kubeclaw-cap-lr:9621');
    });
  });
```

2. [ ] Run, expect FAIL:
   `... npx vitest run src/capabilities/builders/rag.test.ts src/capabilities/registry.test.ts`
   Expected: builder still dispatches to deleted-soon `buildRagQdrantYaml`; entry has no `provider`.

3. [ ] Implement.

   Delete the three files:
   `git rm src/capabilities/builders/rag-qdrant.ts src/capabilities/builders/rag-lightrag.ts src/capabilities/builders/rag-qdrant.test.ts`

   Rewrite `src/capabilities/builders/index.ts`:

```ts
import { KUBECLAW_NAMESPACE } from '../../config.js';
import type { CapabilitySpec, RagCapabilitySpec } from '../types.js';
import { buildMcpYaml } from './mcp.js';
import { buildHttpYaml } from './http.js';
import { renderDeploymentAndService, deploymentName } from './common.js';

const RAG_DEFAULT_PORT = 6333;
const RAG_DEFAULT_STORAGE = { sizeGi: 20, mountPath: '/qdrant/storage' };
const RAG_DEFAULT_HEALTH_PATH = '/healthz';

function buildRagYaml(spec: RagCapabilitySpec): string {
  return renderDeploymentAndService({
    name: deploymentName(spec.name),
    namespace: KUBECLAW_NAMESPACE,
    component: 'capability-rag',
    image: spec.image,
    port: spec.port ?? RAG_DEFAULT_PORT,
    env: spec.env,
    envFromSecrets: spec.envFromSecrets,
    command: spec.command,
    args: spec.args,
    resources: spec.resources,
    healthPath: spec.healthPath ?? RAG_DEFAULT_HEALTH_PATH,
    storage: spec.storage ?? RAG_DEFAULT_STORAGE,
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
  });
}

export function buildYaml(spec: CapabilitySpec): string {
  switch (spec.kind) {
    case 'mcp':
      return buildMcpYaml(spec);
    case 'http':
      return buildHttpYaml(spec);
    case 'rag':
      return buildRagYaml(spec);
    default: {
      const _exhaustive: never = spec;
      void _exhaustive;
      throw new Error('Unknown capability kind');
    }
  }
}
```

   Edit `src/capabilities/registry.ts`. Replace the port consts + `defaultPort` (lines 29–48):

```ts
const MCP_DEFAULT_PORT = 3000;
const HTTP_DEFAULT_PORT = 8080;
const RAG_DEFAULT_PORT = 6333;

function defaultPort(spec: CapabilitySpec): number {
  switch (spec.kind) {
    case 'mcp':
      return spec.port ?? MCP_DEFAULT_PORT;
    case 'http':
      return spec.port ?? HTTP_DEFAULT_PORT;
    case 'rag':
      return spec.port ?? RAG_DEFAULT_PORT;
  }
}
```

   Add the import at the top of `registry.ts`:
   ```ts
   import { normalizeRagSpec } from './rag-config.js';
   ```
   Replace the `case 'rag':` block in `specToDiscoveryEntry` (lines 70–76):

```ts
    case 'rag': {
      const normalized = normalizeRagSpec(spec);
      return {
        name: spec.name,
        kind: 'rag',
        endpoint,
        kindMetadata: { backend: normalized.backend, provider: normalized.provider },
      };
    }
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/capabilities/builders/rag.test.ts src/capabilities/registry.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**' && ... npx tsc --noEmit`
   The old `rag-qdrant.test.ts` is deleted so its `.toThrow()` on bad backend no longer exists — expected.

6. [ ] Commit:
   `git add -A && git commit -m "feat(rag): generic builder + registry port collapse + provider in discovery (SP2 task 4)"`

---

### Task 5: Channel-runner adapter-aware sync

Replace the `backend !== 'qdrant' && backend !== 'lightrag'` guard so the channel pod mirrors the full normalized provider config into its local DB, and validates `provider.adapter ∈ {vector-store, remote}` (skipping unknown adapters gracefully).

**Files:**
- Modify: `src/channel-runner.ts` — the `kindMetadata` lite types (lines 172–176, 240–244) and `syncCapabilitiesToLocalDb` rag case (lines 281–289).
- Test: `src/channel-runner.test.ts` if it exists for sync; else create `src/channel-runner.sync.test.ts` exercising `handleCapabilitiesUpdate` (it is exported from `src/channel-runner.ts` at line 164).

**Interfaces:**
- **Consumes:** `RagProviderConfig` from `./capabilities/types.js`; `getAllCapabilities`/`setCapability`/`deleteCapability` from `./capabilities/db.js` (already imported by channel-runner.ts).
- **Produces:** local DB rows for rag specs now carry `provider` (so `specToDiscoveryEntry` → `getRagEntry` re-derives the same `kindMetadata.provider` the channel uses).

**Steps:**

1. [ ] Write the failing test. Create `src/channel-runner.sync.test.ts` (mirror the registry.test mocking style; mock the DB and redis modules `channel-runner.ts` imports — inspect its imports first and stub each). Core assertion:

```ts
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
// ... mock logger, redis-client, direct-llm-runner.getDirectLLMRunner (configureMcp/configureGroupMcpTemplates no-ops),
//     rag/provider.resetRagProvider — keep these minimal; the unit under test is the DB sync.
import { _initTestDatabase, __resetDbForTest } from './db.js';
import { getAllCapabilities } from './capabilities/db.js';
import { handleCapabilitiesUpdate } from './channel-runner.js';

beforeAll(async () => { await _initTestDatabase(); });
beforeEach(() => { __resetDbForTest(); });

it('mirrors a vector-store rag entry with its provider config into local DB', async () => {
  await handleCapabilitiesUpdate({
    capabilities: JSON.stringify([{
      name: 'r', kind: 'rag', endpoint: 'http://kubeclaw-cap-r:6333',
      kindMetadata: {
        backend: 'qdrant',
        provider: { adapter: 'vector-store', embedding: { provider: 'openai' } },
      },
    }]),
  } as never);
  const rows = getAllCapabilities().filter((c) => c.kind === 'rag');
  expect(rows).toHaveLength(1);
  expect((rows[0] as { provider?: { adapter: string } }).provider?.adapter).toBe('vector-store');
});

it('skips an unknown adapter without writing a malformed row', async () => {
  await handleCapabilitiesUpdate({
    capabilities: JSON.stringify([{
      name: 'bad', kind: 'rag', endpoint: 'http://x:1',
      kindMetadata: { backend: 'x', provider: { adapter: 'mystery' } },
    }]),
  } as never);
  expect(getAllCapabilities().filter((c) => c.kind === 'rag')).toHaveLength(0);
});
```
   Note for the implementer: stub exactly the modules `channel-runner.ts` imports at top-of-file that would otherwise require Redis/K8s. Read its import block before writing the mocks. Keep `db.js` real (in-memory test DB) so the sync's writes are observable.

2. [ ] Run, expect FAIL:
   `... npx vitest run src/channel-runner.sync.test.ts`

3. [ ] Implement. In `src/channel-runner.ts`, widen the two `kindMetadata` lite types (lines 172–176 and 240–244) to carry the provider:

```ts
      kindMetadata: {
        path?: string;
        allowedTools?: string[];
        backend?: string;
        provider?: import('./capabilities/types.js').RagProviderConfig;
      };
```
   (apply the same `provider?` addition to the `DiscoveryEntryLite` interface at lines 240–244).

   Replace the rag case in `syncCapabilitiesToLocalDb` (lines 281–289):

```ts
      case 'rag': {
        const backend = entry.kindMetadata.backend;
        const provider = entry.kindMetadata.provider;
        // Validate the adapter; skip unknown shapes rather than write a bad row.
        if (
          !provider ||
          (provider.adapter !== 'vector-store' && provider.adapter !== 'remote')
        ) {
          continue;
        }
        spec = {
          ...common,
          kind: 'rag',
          backend: backend ?? 'unknown',
          provider,
        };
        break;
      }
```

4. [ ] Run, expect PASS:
   `... npx vitest run src/channel-runner.sync.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**' && ... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(rag): channel-runner mirrors adapter provider config; drop backend string guard (SP2 task 5)"`

---

### Task 6: Wire retrieval into the agent loop

Apply `augmentPrompt(groupFolder, userMessage)` before the LLM turn so retrieved context prefixes the user message. The indexed `persistedUserContent` (stored history) must stay the ORIGINAL prompt, not the augmented one.

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts` — message assembly at lines 1126–1133; keep the existing `getRagProvider().indexConversationTurn(...)` at line 1429 unchanged; ensure `persistedUserContent` (line 1398) derives from the original `input.prompt`.
- Test: `src/runtime/direct-llm-runner.rag.test.ts` (new) — fake provider, assert the augmented prompt reaches `messages` and the persisted/indexed content is the original.

**Interfaces:**
- **Consumes:** `augmentPrompt(groupFolder, prompt)` and `getRagProvider()` from `../rag/provider.js` (Task 3). `augmentPrompt` is NOT yet imported — only `getRagProvider` is imported at line 28 of `direct-llm-runner.ts`. Add `augmentPrompt` to that import.
- **Produces:** none for later tasks.

**Steps:**

1. [ ] Write the failing test. Create `src/runtime/direct-llm-runner.rag.test.ts`. Because `runAgent` is large, assert at the seam: mock `../rag/provider.js` so `augmentPrompt` prefixes a sentinel and `getRagProvider().retrieveContext` is observable, and capture the `messages` array passed to the chat client. The existing tests for this file show the client-mocking pattern — read `src/runtime/direct-llm-runner.test.ts` (if present) for the OpenAI client mock; reuse it. Minimal assertion shape:

```ts
import { describe, it, expect, vi } from 'vitest';

const augmentPrompt = vi.hoisted(() => vi.fn(async (_g: string, p: string) => `<retrieved_context>\nMEM\n</retrieved_context>\n\n${p}`));
const indexConversationTurn = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../rag/provider.js', () => ({
  augmentPrompt,
  getRagProvider: () => ({ indexConversationTurn, retrieveContext: async () => '' }),
}));
// ... mock the chat client to capture messages and return a fixed assistant reply.
// ... mock conversation-history append fns to capture what gets persisted.

it('prefixes retrieved context onto the user message sent to the LLM', async () => {
  // build a minimal RegisteredGroup + ContainerInput { prompt: 'hello', groupFolder: 'g' }
  // run runAgent; capture messages
  const userMsg = capturedMessages.find((m) => m.role === 'user');
  expect(userMsg.content).toContain('<retrieved_context>');
  expect(userMsg.content).toContain('hello');
  expect(augmentPrompt).toHaveBeenCalledWith('g', expect.stringContaining('hello'));
});

it('persists the ORIGINAL user content, not the augmented prompt', async () => {
  // assert the appendConversation* mock received content without <retrieved_context>
  expect(persistedUser).not.toContain('<retrieved_context>');
});
```
   If the surrounding `runAgent` machinery is too heavy to drive in a focused unit test, instead extract a tiny pure helper and test that: add `export function buildUserTurnContent(augmented: string)` is NOT needed — prefer driving `runAgent` with the same harness the existing `direct-llm-runner.test.ts` uses. Read that file first and mirror its setup exactly. Do not invent a parallel harness.

2. [ ] Run, expect FAIL:
   `... npx vitest run src/runtime/direct-llm-runner.rag.test.ts`
   Expected: user message has no `<retrieved_context>` prefix (augment not wired).

3. [ ] Implement. In `src/runtime/direct-llm-runner.ts`:

   Update the import at line 28:
   ```ts
   import { getRagProvider, augmentPrompt } from '../rag/provider.js';
   ```

   Just before building `messages` (insert before line 1126), compute the augmented prompt:

```ts
    // RAG retrieval (non-fatal): prefix any retrieved context onto the user
    // turn. augmentPrompt returns the original prompt unchanged when RAG is
    // disabled or retrieval fails. We augment ONLY the live LLM turn — the
    // persisted history (persistedUserContent below) keeps the original text
    // so stored conversation is not polluted with ephemeral context.
    const augmentedPrompt = await augmentPrompt(input.groupFolder, input.prompt);
```

   Change the user message at line 1132 to use the augmented prompt:
   ```ts
      { role: 'user', content: augmentedPrompt },
   ```

   Leave line 1398 (`const persistedUserContent = stripContextHeader(input.prompt);`) referencing `input.prompt` (the original) — it already does. Leave line 1429 indexing `persistedUserContent` unchanged.

4. [ ] Run, expect PASS:
   `... npx vitest run src/runtime/direct-llm-runner.rag.test.ts`

5. [ ] Regression run + compile:
   `... npx vitest run --exclude 'e2e/**' && ... npx tsc --noEmit`

6. [ ] Commit:
   `git add -A && git commit -m "feat(rag): wire augmentPrompt into the agent loop (SP2 task 6)"`

---

### Task 7: Remove the Helm-baked Qdrant + rag.* values + baked channel env

Delete `templates/qdrant.yaml`, the `rag:` values block, and the `rag.enabled`-gated env in `channel-pods.yaml` and `orchestrator.yaml`. Keep `VOYAGE_API_KEY`/`OPENAI_API_KEY` delivery to channel pods (the adapter reads the key by env-var name).

**Files:**
- Delete: `helm/kubeclaw/templates/qdrant.yaml`.
- Modify: `helm/kubeclaw/values.yaml` (lines 307–318 `rag:` block), `helm/kubeclaw/templates/channel-pods.yaml` (lines 100–134 `{{- if $.Values.rag.enabled }}` block), `helm/kubeclaw/templates/orchestrator.yaml` (lines 217–236 `{{- if .Values.rag.enabled }}` block).
- Test: `e2e/helm-chart-template.test.ts` (add a no-Qdrant assertion).

**Interfaces:** none (infra only).

**Steps:**

1. [ ] Write the failing test. Add to `e2e/helm-chart-template.test.ts` (a static `helm template` test, no cluster):

```ts
  it('does not render a baked Qdrant StatefulSet', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR,
       '--set', 'secrets.anthropicApiKey=test', '--set', 'redis.password=test'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('name: kubeclaw-qdrant');
    expect(result.stdout).not.toContain('QDRANT_URL');
  });
```

2. [ ] Run, expect FAIL (Qdrant still in chart only if `rag.enabled` defaults true — it defaults false, so QDRANT/StatefulSet are absent by default already; the test may PASS immediately if so). Run:
   `... npx vitest run e2e/helm-chart-template.test.ts`
   If it PASSES before changes (because `rag.enabled: false` already gates everything), still proceed — the value of this task is removing the dead template + values so `--set rag.enabled=true` can no longer resurrect the StatefulSet. After deletion, also confirm `helm template --set rag.enabled=true` (added as a second assertion below) does not render Qdrant:

```ts
  it('rag.enabled=true no longer resurrects a baked Qdrant (value is gone)', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR,
       '--set', 'secrets.anthropicApiKey=test', '--set', 'redis.password=test',
       '--set', 'rag.enabled=true'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('name: kubeclaw-qdrant');
  });
```
   This second assertion FAILS before the change (StatefulSet renders) → real red.

3. [ ] Implement.
   - `git rm helm/kubeclaw/templates/qdrant.yaml`
   - Remove the `rag:` block from `helm/kubeclaw/values.yaml` (the `rag:` key and its children at lines 307–318, plus the comment lines 304–306 describing embedding providers if they only describe the deleted block).
   - In `helm/kubeclaw/templates/channel-pods.yaml`, delete the entire `{{- if $.Values.rag.enabled }} … {{- end }}` region (lines 100–134). Channel pods no longer get `QDRANT_URL`/`EMBEDDING_*`/`RAG_*` baked in — these now travel on the capability spec. If `VOYAGE_API_KEY` was delivered ONLY inside that block, re-add a minimal unconditional (or `secrets.voyageApiKey`-gated) `VOYAGE_API_KEY` env so the `voyage` embedding adapter can read its key; gate it on `secrets.voyageApiKey` presence, not on `rag.enabled`.
   - In `helm/kubeclaw/templates/orchestrator.yaml`, delete the `{{- if .Values.rag.enabled }} … {{- end }}` region (lines 217–236). The orchestrator does not embed.

4. [ ] Run, expect PASS:
   `... npx vitest run e2e/helm-chart-template.test.ts`
   Also run `helm lint helm/kubeclaw` manually to ensure no dangling `.Values.rag` reference: `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && helm lint helm/kubeclaw`. Grep for stragglers: `grep -rn '\.Values\.rag' helm/` must return nothing.

5. [ ] Regression run (helm template tests + full suite):
   `... npx vitest run --exclude 'e2e/**'` then `... npx vitest run e2e/helm-chart-template.test.ts`

6. [ ] Commit:
   `git add -A && git commit -m "chore(helm): remove baked Qdrant StatefulSet + rag.* values + baked channel RAG env (SP2 task 7)"`

---

### Task 8: Generalize credential-injection NO_PROXY

Drop the hardcoded `kubeclaw-qdrant` from `NO_PROXY` (Qdrant is now an arbitrary in-cluster capability reached via `.svc`/`.cluster.local`, already bypassed). Keep the TS constant and the Helm `_helpers.tpl` value in sync, and update the parity test.

**Files:**
- Modify: `src/credential-injection/workload-env.ts` (line 21), `helm/kubeclaw/templates/_helpers.tpl` (line 110).
- Test: `src/credential-injection/workload-env.test.ts` (lines 49–53 `kubeclaw-qdrant` test → remove/replace; the helm-parity test at lines 62–79 string must match the new value).

**Interfaces:** none.

**Steps:**

1. [ ] Write the failing test. In `src/credential-injection/workload-env.test.ts`:
   - Replace the `'NO_PROXY includes kubeclaw-qdrant'` test (lines 49–53) with:

```ts
  it('NO_PROXY does NOT hardcode kubeclaw-qdrant (capabilities bypass via .svc)', () => {
    const env = workloadEnvForSidecar({ port: 8443 });
    const noProxy = env.find((e) => e.name === ENV_NO_PROXY)?.value ?? '';
    expect(noProxy.split(',')).not.toContain('kubeclaw-qdrant');
    // In-cluster capability traffic still bypasses the broker via the .svc suffix.
    expect(noProxy.split(',')).toContain('.svc.cluster.local');
  });
```
   - Update the `expectedNoProxy` string in the helm-parity test (lines 71–72) to the new value (without `kubeclaw-qdrant`):
     `'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,.svc,.svc.cluster.local,.cluster.local'`

2. [ ] Run, expect FAIL:
   `... npx vitest run src/credential-injection/workload-env.test.ts`
   Expected: TS const still contains `kubeclaw-qdrant`; parity string mismatch.

3. [ ] Implement.
   - `src/credential-injection/workload-env.ts` line 21 — new value:
     `value: 'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,.svc,.svc.cluster.local,.cluster.local',`
   - `helm/kubeclaw/templates/_helpers.tpl` line 110 — same value:
     `- { name: NO_PROXY,           value: "localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,.svc,.svc.cluster.local,.cluster.local" }`

4. [ ] Run, expect PASS:
   `... npx vitest run src/credential-injection/workload-env.test.ts`
   (The helm-parity test runs `helm template … --set channels.http.enabled=true`; it requires the helm CLI — it already does today.)

5. [ ] Regression run:
   `... npx vitest run --exclude 'e2e/**'`

6. [ ] Commit:
   `git add -A && git commit -m "chore(cred-injection): drop hardcoded kubeclaw-qdrant from NO_PROXY (SP2 task 8)"`

---

### Task 9: Docs — Qdrant capability install recipe

Add a documented Qdrant-as-capability install recipe (the spec JSON for the admin shell / Redis IPC) and describe the two adapters in the capability install docs.

**Files:**
- Modify: `docs/INSTALLING_A_CHANNEL.md` (the "Installing a capability" section starting line 75).
- (No code; no test level applies — call this out explicitly.)

**Interfaces:** none.

**Steps:**

1. [ ] No automated test (docs-only). State this in the commit and in the task report: "Docs task — no unit/integration/e2e level applies; verified by rendering review."

2. [ ] Implement. Under the "Installing a capability" section of `docs/INSTALLING_A_CHANNEL.md`, add a subsection:

```markdown
### Installing Qdrant as a RAG capability

RAG is no longer baked into the chart. Install Qdrant as a `rag` capability with
an embedded `provider` block. The `vector-store` adapter embeds + chunks in the
channel pod and upserts/searches Qdrant's REST API.

Spec (passed to the admin shell `install_capability` tool / Redis IPC):

```json
{
  "kind": "rag",
  "name": "main-rag",
  "backend": "qdrant",
  "image": "qdrant/qdrant:latest",
  "port": 6333,
  "healthPath": "/healthz",
  "storage": { "sizeGi": 20, "mountPath": "/qdrant/storage" },
  "podSecurity": { "fsGroup": 1000, "runAsUser": 1000 },
  "provider": {
    "adapter": "vector-store",
    "embedding": { "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY" },
    "topK": 5,
    "scoreThreshold": 0.5
  }
}
```

The embedding API key is read from the channel pod's `OPENAI_API_KEY`
(or `VOYAGE_API_KEY` for `provider: "voyage"`) — the raw key never appears in the
spec. To install a backend that embeds server-side (e.g. LightRAG), use the
`remote` adapter instead:

```json
{
  "kind": "rag",
  "name": "lightrag",
  "backend": "lightrag",
  "image": "ghcr.io/hkuds/lightrag:latest",
  "port": 9621,
  "provider": { "adapter": "remote", "queryMode": "hybrid" }
}
```

A backend speaking either protocol installs as pure config — no code change.
```

3. [ ] Verify the markdown renders (read it back; ensure code fences balance).

4. [ ] Commit:
   `git add -A && git commit -m "docs(capabilities): Qdrant + remote RAG capability install recipes (SP2 task 9)"`

---

### Task 10: E2E rewrite — install Qdrant as a capability; index → retrieve

Rework `e2e/minikube-live-rag.test.ts` to install Qdrant **as a capability** (no Helm StatefulSet), with `podSecurity.fsGroup/runAsUser` so the Qdrant pod actually becomes Ready, then index a message and assert retrieval augments a subsequent turn. Update the install spec to carry `provider`. Mark live-run deferred per the unattended-cluster policy.

**Files:**
- Modify: `e2e/minikube-live-rag.test.ts` (the install XADD spec at lines 211–225; the comments at lines 1–25, 243–251, 318–336 that assert the cap pod CrashLoops / routes to the helm Qdrant — those assumptions are now invalid).
- Modify: `e2e/minikube-live-setup.ts` (lines ~611–627, ~1109–1110) — drop `rag.enabled=true` and the `waitForPod('app=kubeclaw-qdrant')`; the test installs Qdrant itself.
- Test: this IS the e2e test.

**Interfaces:** none.

**Steps:**

1. [ ] Update the e2e test. The change is the test definition; "failing first" here means the test reflects the new contract and will only pass against a live cluster (deferred). Key edits:

   - Install spec (lines 212–225 XADD `spec`): use the new shape with `provider` and pod security so Qdrant runs:
```ts
spec: JSON.stringify({
  kind: 'rag',
  name: RAG_CAPABILITY_NAME,
  backend: 'qdrant',
  image: 'qdrant/qdrant:latest',
  port: 6333,
  healthPath: '/healthz',
  storage: { sizeGi: 5, mountPath: '/qdrant/storage' },
  podSecurity: { fsGroup: 1000, runAsUser: 1000 },
  provider: {
    adapter: 'vector-store',
    embedding: {
      provider: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      // point at the deterministic test embedding server + its dim
      baseUrl: 'http://kubeclaw-capability-test-embed:8080/v1',
      dim: 1536,
    },
  },
}),
```
   - Now WAIT for the capability Qdrant pod to be Ready (the old test deliberately did NOT — that caveat is gone). Replace the "do NOT wait for the cap pod" comment block (lines 243–251) and add a readiness poll on `app=${RAG_CAP_SERVICE}`.
   - The Qdrant queries that previously hit `kubeclaw-qdrant:6333` (the helm StatefulSet) must now target the capability Service `kubeclaw-cap-test-rag:6333`. Update `listScript`/`countScript`/`searchScript` host from `kubeclaw-qdrant` to `RAG_CAP_SERVICE` (`kubeclaw-cap-test-rag`).
   - Add a NEW retrieval assertion (the spec's headline goal): after indexing `purple-orchid-7392`, POST a SECOND message that asks about it and assert the augmented turn caused retrieval. Since asserting LLM output is flaky, assert the channel pod logged `RAG provider: vector-store` and that a `<retrieved_context>` block was produced — drive this by checking the channel pod logs for the retrieval path, or by exec'ing the same deterministic-embedding search the test already does (which proves index→retrieve round-trips). Keep the existing direct-search test as the retrieval proof; relabel it to reflect it now reads the capability Qdrant.
   - Update the header comment (lines 1–25) to describe the capability-install flow (no `rag.enabled`, no StatefulSet).

   - In `e2e/minikube-live-setup.ts`: remove `'rag.enabled=true'` (line 614) and the `waitForPod('app=kubeclaw-qdrant', …)` (lines 1109–1110). Keep the test-embed capability deploy + `secrets.embeddingBaseUrl`/`secrets.embeddingDim` only if other suites use them; the rag test now sets `baseUrl`/`dim` on the spec, so these helm secrets are no longer required by the rag test — but DO NOT remove them if another e2e references them (grep first: `grep -rn 'embeddingBaseUrl\|embeddingDim\|test-embed' e2e/`).

2. [ ] Run, expect SKIP/DEFER (no live cluster in this environment). Document the run command for when a cluster is available:
   `cd /home/peter/projects/kubeclaw/.worktrees/cap-overhaul && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null && npx vitest run e2e/minikube-live-rag.test.ts`
   Per house policy on unattended clusters, the live run is **deferred**. Verify the test file at least type-checks and lints:
   `... npx tsc --noEmit` and `... npx eslint e2e/minikube-live-rag.test.ts e2e/minikube-live-setup.ts`.

3. [ ] No implementation beyond the test/setup edits (the feature is already wired by Tasks 1–8).

4. [ ] Regression: ensure the non-e2e suite is still green:
   `... npx vitest run --exclude 'e2e/**'`

5. [ ] Commit:
   `git add -A && git commit -m "test(e2e): install Qdrant as a capability + assert index→retrieve (live-run deferred) (SP2 task 10)"`

---

## Self-Review

**Spec coverage (every Design section → task):**
- §1 Spec & types (RagProviderConfig union; discovery `kindMetadata.provider`; back-compat normalization) → **Task 1**.
- §2 Generic builder (delete rag-qdrant/lightrag; generic `rag` case; registry port collapse) → **Task 4**.
- §3 Provider layer (VectorStore/Remote from discovery config; switch on adapter; resetRagProvider unchanged; augmentPrompt signature kept) → **Task 3** (merged with store/indexer/retriever to keep every commit green).
- §4 Config-threaded core (store/indexer/retriever/embedding-client; remove RAG_ENABLED/EMBEDDING_DIM env consts) → **Tasks 2 (embedding-client) + 3 (store/indexer/retriever + provider)**.
- §5 Retrieval wiring (`augmentPrompt` into direct-llm-runner before the turn; original prompt persisted) → **Task 6**.
- §6 Channel-side consumer (replace `backend !== 'qdrant'/'lightrag'` guard with adapter validation) → **Task 5**.
- §7 Infra/UX cleanup (delete qdrant.yaml + rag.* values + baked channel env; NO_PROXY generalization; install recipe docs) → **Tasks 7 + 8 + 9**.
- Tests three levels: unit (Tasks 1–5 colocated), integration (Task 4 registry round-trip, Task 5 channel sync, Task 6 agent-loop seam), e2e (Task 10). Helm template tests (Task 7) + cred-injection parity (Task 8) covered.

**Placeholder scan:** No "TBD"/"similar to"/"add error handling" left as the substance of a step; every code-changing step shows the code. Two intentional "read the existing harness first" notes (Task 5 mocks, Task 6 client mock) point the implementer at concrete existing files (`registry.test.ts`, `direct-llm-runner.test.ts`) rather than inventing a harness — this is guidance, not a placeholder for the change itself.

**Type/name consistency:** `EmbeddingConfig`, `VectorStoreProviderConfig`, `RemoteProviderConfig`, `RagProviderConfig` (Task 1) are consumed verbatim by Tasks 2 (`resolveEmbeddingDefaults(config: EmbeddingConfig)`), 3 (`IndexerConfig.embedding: EmbeddingConfig`, `RetrieverConfig`, `VectorStoreProvider`/`RemoteProvider` ctor types), 4 (`kindMetadata: { backend, provider }`), 5 (`provider?: RagProviderConfig`). `VectorStoreOpts { endpoint; dim }` (Task 3 store) is the exact object Task 3's `VectorStoreProvider` builds for indexer/retriever. `augmentPrompt(groupFolder, prompt)` (Task 3) is the exact signature Task 6 imports and calls.

**Ordering / green-on-commit:** Each task widens or adds before any caller depends on it; `backend` widened to `string` (Task 1) is assignment-compatible so no commit breaks until the per-backend builders are deleted (Task 4), by which point the generic builder + discovery provider are in place. `RAG_ENABLED` is kept through Task 2 and removed only in Task 3 alongside its last consumers, tests, and the updated provider.ts — ensuring the codebase compiles and tests pass at every commit. `tsc --noEmit` is run in Tasks 3–8 to catch cross-file breakage before each commit.
