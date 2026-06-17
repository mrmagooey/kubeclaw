# Config-Driven RAG Capabilities + Installable Qdrant (SP2) — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Builds on:** SP1 ([2026-06-17-capability-base-generalization-design.md](2026-06-17-capability-base-generalization-design.md)) — tunable/tcp probes, scheduling, pod-security, endpoint scheme. And the existing RAG subsystem: `src/rag/{provider,store,indexer,retriever}.ts`, `src/runtime/embedding-client.ts`, the `rag` capability kind, and the Helm-baked `kubeclaw-qdrant` StatefulSet.

## Where this fits (decomposition)

```
SP1  Capability base generalization                 ✅ COMPLETE
SP2  Config-driven RAG + Qdrant install + retrieval  ← THIS SPEC
SP3  Inbound-preprocessor framework + voice transcription
SP4  Capability composition (doc-parse → rag)        (optional, later)
```

## Problem

RAG works today but is neither optional nor extensible, and is only half-wired:

1. **Qdrant is double-deployed.** A Helm StatefulSet `kubeclaw-qdrant` (gated on `rag.enabled`) runs as always-on infra, *and* a `buildRagQdrantYaml` capability builder can deploy Qdrant on demand. "Optional/installable" requires one path.
2. **The backend abstraction is closed.** Adding a RAG backend means editing four switch sites: `types.ts` (the `backend: 'qdrant' | 'lightrag'` union), `registry.ts` (default port), `builders/index.ts` (dispatch), `provider.ts` (provider selection). A third-party backend can't be installed without code changes to all four.
3. **Embedding config is global channel env** (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `QDRANT_URL`, `RAG_TOP_K`, `RAG_SCORE_THRESHOLD`) read at module load. An installed RAG capability is therefore not self-describing, and all installs share one embedding config.
4. **Retrieval is built but never called.** `direct-llm-runner.ts` indexes each turn (`getRagProvider().indexConversationTurn`) but never calls `retrieveContext`/`augmentPrompt`, so indexed data is never read back. RAG indexes write-only.

## Goal

Make RAG an **optional, installable, pluggable** capability: Qdrant is installed as a capability (no Helm StatefulSet), embedding/backend config travels **on the capability spec**, new backends that speak a supported protocol install as **pure config**, and retrieval is **wired into the agent loop** so RAG is usable end to end.

## Decisions (answered during brainstorming)

- **Remove the Helm-baked Qdrant entirely.** No `rag.enabled` infra; no bootstrap auto-install. Qdrant becomes a deliberate admin-shell install. **Existing indexed Qdrant data is discarded** — acceptable because retrieval was never wired, so nothing ever read it.
- **Config-driven generic via protocol adapters** (the pragmatic reading of "config-driven generic"): the container is fully generic (SP1 renderer), and channel-side behavior is one of a small set of built-in **adapters** selected by spec data. Two adapters cover everything today:
  - **`vector-store`** — channel embeds + chunks locally, then upserts/searches a Qdrant-compatible REST API. (Qdrant.)
  - **`remote`** — channel POSTs raw text to index and a query to retrieve; the backend embeds. (LightRAG.)
  A new backend speaking either protocol installs as **pure config, no code**; a genuinely new protocol adds one adapter. The `backend` field opens to a free-form `string` (label/metrics only); behavior is driven by the adapter.
- **Embedding config lives on the capability spec.** `vector-store` adapter carries `{ provider, model, dim, baseUrl?, apiKeyEnv? }`. **Key delivery (decided default):** the embedding API key is read from a channel-pod env var named by `apiKeyEnv` (default `OPENAI_API_KEY` / `VOYAGE_API_KEY`); the **raw key never travels in the spec or discovery entry**. Routing embedding egress through the credential broker is noted as future alignment (see Non-goals) but is out of SP2 scope — SP2 does not change the credential-injection flow.
- **Retrieval is wired in this work** (`augmentPrompt` into `direct-llm-runner.ts`).

## Design

### 1. Spec & types — `src/capabilities/types.ts`

```ts
export interface RagCapabilitySpec extends CapabilityBase {
  kind: 'rag';
  backend: string;            // free label ('qdrant', 'weaviate'…) — not behaviour-bearing
  provider: RagProviderConfig;
}

export type RagProviderConfig =
  | {
      adapter: 'vector-store';
      embedding: {
        provider: 'openai' | 'voyage';
        model?: string;          // default per provider
        dim?: number;            // default per provider (openai 1536, voyage 1024)
        baseUrl?: string;
        apiKeyEnv?: string;      // channel-pod env var holding the key; default per provider
      };
      chunkSize?: number;        // default 1800
      chunkOverlap?: number;     // default 200
      topK?: number;             // default 5
      scoreThreshold?: number;   // default 0.5
    }
  | {
      adapter: 'remote';
      indexPath?: string;        // default '/documents/text'
      queryPath?: string;        // default '/query'
      queryMode?: string;        // default 'hybrid'
      timeoutMs?: number;        // default 30000 index / 15000 query
    };
```

- The `CapabilityDiscoveryEntry` rag member's `kindMetadata` becomes `{ backend: string; provider: RagProviderConfig }` (replacing `{ backend: 'qdrant' | 'lightrag' }`). **No secrets** travel in the entry (`apiKeyEnv` is an env-var *name*, not a value).
- **Back-compat parse:** a legacy persisted spec `{kind:'rag', backend:'qdrant'}` is normalized on read to `{backend:'qdrant', provider:{adapter:'vector-store', embedding:{provider: <from env or 'openai'>}}}`; `{backend:'lightrag'}` → `{provider:{adapter:'remote'}}`. So existing SQLite rows keep working without migration.

### 2. Generic builder — `src/capabilities/builders/`

Delete `rag-qdrant.ts` and `rag-lightrag.ts`. In `builders/index.ts`, the `rag` case calls the generic `renderDeploymentAndService` directly (driven by `image`/`port`/`storage`/`probe`/etc. from the spec, with the RAG storage default applied). `registry.ts`'s per-backend default-port table collapses to a single fallback (RAG specs carry their own `port`; default to 6333 when absent). `reconciler.ts`'s "has PVC?" heuristic (`kind === 'rag' || !!storage`) is unchanged.

### 3. Provider layer — `src/rag/provider.ts` + adapters

- `QdrantRagProvider` → **`VectorStoreProvider`**, `LightRagProvider` → **`RemoteRagProvider`**, both **parameterized from the discovery entry's `provider` config** — no module-level `process.env` reads.
- `getRagProvider()` switches on `provider.adapter` (not `backend`). `NullRagProvider` (no capability) and the `resetRagProvider()` hot-swap-on-`capabilities_update` path are unchanged.
- `augmentPrompt(groupFolder, prompt)` keeps its signature.

### 4. Config-threaded core — `store.ts`, `indexer.ts`, `retriever.ts`, `embedding-client.ts`

These read `process.env` at module load today. Refactor each to accept a config object passed down from the provider:
- `store.ts`: takes `{ endpoint }` instead of reading `QDRANT_URL`.
- `embedding-client.ts`: `embed(texts, embeddingConfig)` instead of the module-level `PROVIDER`/`MODEL`/`DIM` constants; the per-provider defaults move into a pure function of the passed config.
- `indexer.ts` / `retriever.ts`: take `{ endpoint, embedding, chunkSize, chunkOverlap, topK, scoreThreshold }` from the provider.
- The exported `RAG_ENABLED` / `EMBEDDING_DIM` env-derived constants are removed or recomputed from config; any consumers are updated.

### 5. Retrieval wiring — `src/runtime/direct-llm-runner.ts`

Indexing already fires after each turn (~line 1429). Add the read side: before the LLM turn, call `augmentPrompt(groupFolder, userMessage)` and use the returned (context-prefixed) prompt. The exact injection point (which message/prompt string, ordering vs. system prompt and history) is pinned in the implementation plan. Retrieval is non-fatal (returns the original prompt on any failure, per the provider contract).

### 6. Channel-side consumer — `src/channel-runner.ts`

The `backend !== 'qdrant' && backend !== 'lightrag'` guard (~line 283) is replaced by adapter-based handling (validate `provider.adapter ∈ {vector-store, remote}`; ignore unknown backends gracefully).

### 7. Infra & UX cleanup

- Delete `helm/kubeclaw/templates/qdrant.yaml` and the `rag.*` values block from `helm/kubeclaw/values.yaml` (and any `QDRANT_URL`/embedding env injected into channel pods from Helm that assumed the baked instance).
- `src/credential-injection/workload-env.ts`: stop hardcoding `kubeclaw-qdrant` in `NO_PROXY`; bypass the broker for in-cluster capability traffic generically (e.g. the cluster-local `.svc` suffix / service CIDR). Embedding egress to OpenAI/Voyage stays *on* the broker path.
- Ship a documented **Qdrant capability install recipe** (the spec JSON for the admin shell) and update the capability/installation docs to describe installing a RAG backend.

## Back-compat & migration

- Legacy persisted `rag` specs are normalized on read (§1) — no DB migration.
- Discarding existing Qdrant data is accepted (retrieval was never wired).
- Removing the Helm StatefulSet on `helm upgrade` deletes the baked Qdrant; its PVC follows the chart's retention. Operators who want RAG re-install Qdrant as a capability.

## Tests (three levels)

- **Unit:** generic RAG builder output (Deployment/Service/PVC, with SP1 probe/storage defaults); `VectorStoreProvider`/`RemoteRagProvider` constructed from each adapter config (no env); back-compat legacy-spec normalization; `embedding-client` driven by passed config (provider/model/dim defaults); `store`/`indexer`/`retriever` parameterized (no env reads); the conflict guard `assertNoConflictingRag` still holds.
- **Integration:** `installCapability(ragSpec)` → reconciler applies generic RAG YAML → discovery round-trips the new `kindMetadata.provider`; `resetRagProvider` selects the adapter from the entry; `augmentPrompt` end-to-end against a faked vector store returns a context-prefixed prompt; index→retrieve round-trip against a faked store + faked embedder.
- **E2E (minikube, written; live run deferred per the unattended-cluster policy):** rework `e2e/minikube-live-rag.test.ts` to install Qdrant **as a capability** (no Helm StatefulSet), index a message, and assert **retrieval** augments a subsequent turn end to end.

## Non-goals (deferred)

- The general inbound-preprocessor framework and voice transcription (SP3) — SP2 keeps RAG-specific naming where the seam isn't yet shared.
- Capability-feeds-capability composition / document-parse ingestion (SP4).
- Routing embedding egress through the credential broker (future; SP2 leaves the embedding-key-in-channel-env flow unchanged).
- Fully-templated no-code-for-any-protocol backends (rejected in favor of the two-adapter model; a new protocol adds one adapter).
- Collapsing the non-RAG builders (mcp/http) — out of scope.
