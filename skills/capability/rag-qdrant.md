---
name: rag-qdrant
description: RAG via Qdrant vector database with OpenAI or Voyage embeddings
type: capability
dependencies: []
env:
  - QDRANT_URL
  - EMBEDDING_PROVIDER
  - EMBEDDING_MODEL
  - RAG_TOP_K
  - RAG_SCORE_THRESHOLD
  - VOYAGE_API_KEY
---

# RAG-Qdrant — Vector Memory for Channels

Deploys a Qdrant vector database and wires channels to embed and retrieve
conversational context. Each message turn is indexed; relevant past context
is injected before the LLM call.

## Architecture

A **Capability** pod — a long-lived Qdrant StatefulSet that channels talk
to directly via HTTP after orchestrator-mediated discovery.

## Providers

| Provider | Model | API Key |
|----------|-------|---------|
| `openai` | `text-embedding-3-small` | Reuses `OPENAI_API_KEY` (already in kubeclaw-secrets) |
| `voyage` | `voyage-3` | Requires `VOYAGE_API_KEY` added to kubeclaw-secrets |

## Helm Configuration

Enable in your values override:

```yaml
rag:
  enabled: true
  provider: openai        # "openai" or "voyage"
  model: ""               # uses provider default if empty
  storage: 20Gi           # Qdrant PVC size
  qdrantVersion: latest
  topK: 5                 # chunks injected per message
  scoreThreshold: "0.5"   # minimum cosine similarity (0-1)
  resources:
    limits:
      memory: 1Gi
      cpu: "1"
```

If using the Voyage provider, add the API key to secrets:

```yaml
secrets:
  voyageApiKey: "your-voyage-api-key"
```

## What Gets Deployed

- **Qdrant StatefulSet** (`kubeclaw-qdrant`) with a PVC for vector storage
- **Qdrant Service** on ports 6333 (HTTP) and 6334 (gRPC)
- Env vars injected into orchestrator and channel pods:
  `QDRANT_URL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `RAG_TOP_K`, `RAG_SCORE_THRESHOLD`

## Source Code

- `src/rag/store.ts` — Qdrant collection management and vector upsert/query
- `src/rag/indexer.ts` — conversation turn indexing (called after each LLM response)
- `src/rag/retriever.ts` — context retrieval (called before each LLM prompt)

## Verification

After enabling, check that Qdrant is running:

```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-qdrant
kubectl logs statefulset/kubeclaw-qdrant -n kubeclaw --tail=10
```

Test embedding by sending a message through any channel — the orchestrator
logs should show RAG indexing and retrieval activity.
