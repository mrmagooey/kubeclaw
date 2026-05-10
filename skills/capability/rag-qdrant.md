---
name: rag-qdrant
description: Vector RAG via Qdrant — installable as a unified capability
type: capability
dependencies: []
---

# RAG-Qdrant — Vector RAG Capability

Qdrant is a `kind: 'rag'` capability with `backend: 'qdrant'`. The
orchestrator deploys it as a Deployment + Service + PVC and exposes it
to channels through capability discovery.

Channels resolve a Qdrant endpoint via `getRagEntry(channelName)` from
`src/capabilities/client.ts`. The existing `src/rag/` indexer/retriever
pipeline transparently uses the resolved endpoint via `QDRANT_URL`.

## Install

From the orchestrator admin shell, call `install_capability` with:

```json
{
  "tool": "install_capability",
  "arguments": {
    "spec": {
      "kind": "rag",
      "backend": "qdrant",
      "name": "main-rag",
      "image": "qdrant/qdrant:latest",
      "storage": { "sizeGi": 20, "mountPath": "/qdrant/storage" }
    }
  }
}
```

The orchestrator persists the spec to the `capabilities` SQLite table,
applies the K8s manifests via the reconciler, health-probes the
endpoint at `/healthz`, and broadcasts a `capabilities_update` to all
channel pods. Channels resolve the new endpoint on their next message
turn.

## Verify

```json
{ "tool": "list_capabilities", "arguments": {} }
```

The Qdrant entry's `lifecycle` should transition `pending → ready`
within ~30 seconds (one health-probe cycle).

For pod logs:

```json
{ "tool": "get_capability_logs", "arguments": { "name": "main-rag" } }
```

## Remove

```json
{ "tool": "remove_capability", "arguments": { "name": "main-rag" } }
```

This deletes the Deployment, Service, and PVC. Existing vector data is
gone — back up `/qdrant/storage` first if you need to retain it.

## Channel-side use

Channels see Qdrant via `getRagEntry()`. The selection cache is
process-local per channel pod, so an install/remove takes effect on
channel-pod restart. (Future improvement: bust the cache on
`capabilities_update`.)
