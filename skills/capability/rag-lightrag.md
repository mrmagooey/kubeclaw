---
name: rag-lightrag
description: Graph-based RAG via LightRAG (knowledge graph + vector retrieval)
type: capability
dependencies: []
env:
  - LIGHTRAG_URL
  - LIGHTRAG_LLM_BINDING
  - LIGHTRAG_LLM_MODEL
  - LIGHTRAG_EMBEDDING_BINDING
  - LIGHTRAG_EMBEDDING_MODEL
---

# RAG-LightRAG — Knowledge Graph RAG for Channels

Deploys [LightRAG](https://github.com/HKUDS/LightRAG) as a capability pod.
Unlike pure vector RAG (Qdrant), LightRAG builds a knowledge graph from
indexed documents — extracting entities and relationships — and combines
graph traversal with vector similarity for retrieval. This produces more
contextually coherent results, especially for multi-hop reasoning.

## Architecture

A **Capability** pod running the LightRAG server (`ghcr.io/hkuds/lightrag`).
Channels index conversation turns and retrieve context via the REST API
after orchestrator-mediated discovery.

## What Gets Deployed

- **LightRAG Deployment** (`kubeclaw-lightrag`) running the server image
- **LightRAG Service** on port 9621 (HTTP REST API + Web UI)
- **PVC** for graph and vector storage persistence

## Kubernetes Manifests

Create a values override or apply directly via the admin shell:

```yaml
# lightrag-values.yaml (example overlay for helm)
# Not included in the default chart — deploy via admin shell or kubectl.
```

### Manual Deployment

```bash
# Create the PVC
kubectl apply -n kubeclaw -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kubeclaw-lightrag-data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
EOF

# Create the Secret with LightRAG config
kubectl create secret generic kubeclaw-lightrag-config -n kubeclaw \
  --from-literal=LLM_BINDING=openai \
  --from-literal=LLM_BINDING_HOST=https://api.openai.com/v1 \
  --from-literal=LLM_MODEL=gpt-4o-mini \
  --from-literal=EMBEDDING_BINDING=openai \
  --from-literal=EMBEDDING_BINDING_HOST=https://api.openai.com/v1 \
  --from-literal=EMBEDDING_MODEL=text-embedding-3-small \
  --from-literal=EMBEDDING_DIM=1536

# Create the Deployment
kubectl apply -n kubeclaw -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeclaw-lightrag
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubeclaw-lightrag
  template:
    metadata:
      labels:
        app: kubeclaw-lightrag
    spec:
      containers:
        - name: lightrag
          image: ghcr.io/hkuds/lightrag:latest
          ports:
            - name: http
              containerPort: 9621
          envFrom:
            - secretRef:
                name: kubeclaw-lightrag-config
          env:
            - name: LLM_BINDING_API_KEY
              valueFrom:
                secretKeyRef:
                  name: kubeclaw-secrets
                  key: openai-api-key
            - name: EMBEDDING_BINDING_API_KEY
              valueFrom:
                secretKeyRef:
                  name: kubeclaw-secrets
                  key: openai-api-key
          volumeMounts:
            - name: data
              mountPath: /app/data
          resources:
            requests:
              memory: 512Mi
              cpu: 250m
            limits:
              memory: 2Gi
              cpu: "2"
          readinessProbe:
            httpGet:
              path: /health
              port: 9621
            initialDelaySeconds: 10
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: kubeclaw-lightrag-data
---
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-lightrag
spec:
  selector:
    app: kubeclaw-lightrag
  ports:
    - name: http
      port: 9621
      targetPort: 9621
EOF
```

## Channel Integration

Channels communicate with LightRAG via its REST API at
`http://kubeclaw-lightrag:9621`.

### Indexing (after each conversation turn)

```
POST /documents/text
Content-Type: application/json

{"text": "conversation content to index"}
```

### Retrieval (before each LLM prompt)

```
POST /query
Content-Type: application/json

{"query": "user's question", "mode": "hybrid"}
```

Query modes:
- `naive` — vector similarity only (like traditional RAG)
- `local` — entity-centric graph search
- `global` — high-level theme summaries
- `hybrid` — combines local + global (recommended)

### Web UI

LightRAG includes a built-in web UI for document management and knowledge
graph exploration. Access via port-forward:

```bash
kubectl port-forward -n kubeclaw svc/kubeclaw-lightrag 9621:9621
# Open http://localhost:9621
```

## LLM Provider Configuration

LightRAG needs its own LLM access for entity extraction during indexing.
By default it reuses the same `OPENAI_API_KEY` from kubeclaw-secrets.

| Setting | Default | Description |
|---------|---------|-------------|
| `LLM_BINDING` | `openai` | LLM provider (`openai`, `ollama`, `lollms`) |
| `LLM_MODEL` | `gpt-4o-mini` | Model for entity extraction |
| `EMBEDDING_BINDING` | `openai` | Embedding provider |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBEDDING_DIM` | `1536` | Embedding dimensions (must match model) |

For local models via Ollama:

```bash
kubectl create secret generic kubeclaw-lightrag-config -n kubeclaw \
  --from-literal=LLM_BINDING=ollama \
  --from-literal=LLM_BINDING_HOST=http://ollama:11434 \
  --from-literal=LLM_MODEL=llama3.2 \
  --from-literal=EMBEDDING_BINDING=ollama \
  --from-literal=EMBEDDING_BINDING_HOST=http://ollama:11434 \
  --from-literal=EMBEDDING_MODEL=nomic-embed-text \
  --from-literal=EMBEDDING_DIM=768
```

## Storage Backends

Default storage uses local JSON + NanoVectorDB (persisted on the PVC).
For production, LightRAG supports:

- **PostgreSQL** — all-in-one relational backend
- **Neo4j** — dedicated graph database
- **MongoDB** — document storage
- **OpenSearch** — unified search backend

Configure via additional env vars in the Secret. See the
[LightRAG docs](https://github.com/HKUDS/LightRAG) for backend-specific
configuration.

## Comparison with RAG-Qdrant

| | RAG-Qdrant | RAG-LightRAG |
|---|---|---|
| **Approach** | Pure vector similarity | Knowledge graph + vector hybrid |
| **Strengths** | Simple, fast, low resource | Multi-hop reasoning, entity relationships |
| **Storage** | Qdrant vector DB | Graph + vector (local or PostgreSQL/Neo4j) |
| **LLM needed** | No (embeddings only) | Yes (entity extraction during indexing) |
| **Web UI** | No | Yes (document management, graph explorer) |
| **Resource cost** | Lower | Higher (LLM calls during indexing) |

## Verification

```bash
kubectl get pods -n kubeclaw -l app=kubeclaw-lightrag
kubectl logs deployment/kubeclaw-lightrag -n kubeclaw --tail=20

# Test the API
kubectl exec -n kubeclaw deployment/kubeclaw-orchestrator -- \
  curl -s http://kubeclaw-lightrag:9621/health
```
