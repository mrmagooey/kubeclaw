---
name: rag-lightrag
description: Graph-based RAG via LightRAG (knowledge graph + vector retrieval)
type: capability
dependencies: []
env:
  - LIGHTRAG_LLM_BINDING
  - LIGHTRAG_LLM_MODEL
  - LIGHTRAG_EMBEDDING_BINDING
  - LIGHTRAG_EMBEDDING_MODEL
---

# RAG-LightRAG — Knowledge-Graph RAG Capability

LightRAG ([HKUDS/LightRAG](https://github.com/HKUDS/LightRAG)) is a
`kind: 'rag'` capability with `backend: 'lightrag'`. Unlike pure-vector
RAG, LightRAG builds a knowledge graph from indexed documents — extracting
entities and relationships — and combines graph traversal with vector
similarity for retrieval. This produces more contextually coherent
results, especially for multi-hop reasoning.

Channels resolve LightRAG via `getRagEntry(channelName)`; the
LightRagProvider in `src/rag/provider.ts` calls its REST API directly
(no local embedding — LightRAG handles it).

## Prerequisites — create the config Secret

LightRAG needs its own LLM access for entity extraction during
indexing. Create the config Secret BEFORE installing the capability:

```bash
kubectl create secret generic kubeclaw-lightrag-config -n kubeclaw \
  --from-literal=LLM_BINDING=openai \
  --from-literal=LLM_BINDING_HOST=https://api.openai.com/v1 \
  --from-literal=LLM_MODEL=gpt-4o-mini \
  --from-literal=EMBEDDING_BINDING=openai \
  --from-literal=EMBEDDING_BINDING_HOST=https://api.openai.com/v1 \
  --from-literal=EMBEDDING_MODEL=text-embedding-3-small \
  --from-literal=EMBEDDING_DIM=1536
```

For local models via Ollama, swap the values to point at your Ollama
endpoint and an embedding model with matching dimensions.

## Install

From the orchestrator admin shell:

```json
{
  "tool": "install_capability",
  "arguments": {
    "spec": {
      "kind": "rag",
      "backend": "lightrag",
      "name": "graph-rag",
      "image": "ghcr.io/hkuds/lightrag:latest",
      "envFromSecrets": ["kubeclaw-lightrag-config"],
      "storage": { "sizeGi": 20, "mountPath": "/app/data" }
    }
  }
}
```

The orchestrator deploys the pod and probes `/health`. Allow ~60 seconds
for LightRAG to initialize before issuing queries.

## Web UI

LightRAG ships with a web UI for document management and knowledge-graph
exploration. Port-forward to access it:

```bash
kubectl port-forward -n kubeclaw svc/kubeclaw-cap-graph-rag 9621:9621
# Open http://localhost:9621
```

## LLM Binding Reference

| Field | Default | Description |
|---|---|---|
| `LLM_BINDING` | `openai` | LLM provider (`openai`, `ollama`, `lollms`) |
| `LLM_MODEL` | `gpt-4o-mini` | Model for entity extraction |
| `EMBEDDING_BINDING` | `openai` | Embedding provider |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBEDDING_DIM` | `1536` | Embedding dimensions (must match model) |

## Storage backends

Default storage is local JSON + NanoVectorDB on the PVC. For production
LightRAG supports PostgreSQL, Neo4j, MongoDB, OpenSearch — add the
appropriate keys to the `kubeclaw-lightrag-config` Secret. See the
[LightRAG docs](https://github.com/HKUDS/LightRAG) for backend-specific
configuration.

## Compared to RAG-Qdrant

| | RAG-Qdrant | RAG-LightRAG |
|---|---|---|
| Approach | Pure vector similarity | Knowledge graph + vector hybrid |
| Strengths | Simple, fast, low resource | Multi-hop reasoning, entity relationships |
| Storage | Qdrant vector DB | Graph + vector (local or external) |
| LLM needed | No (embeddings only) | Yes (entity extraction during indexing) |
| Web UI | No | Yes |
| Resource cost | Lower | Higher (LLM calls during indexing) |

## Verify

```json
{ "tool": "list_capabilities", "arguments": {} }
```

```json
{ "tool": "get_capability_logs", "arguments": { "name": "graph-rag" } }
```

## Remove

```json
{ "tool": "remove_capability", "arguments": { "name": "graph-rag" } }
```

This deletes the Deployment, Service, and PVC. The `kubeclaw-lightrag-config`
Secret is preserved (delete manually if you don't intend to reinstall).
