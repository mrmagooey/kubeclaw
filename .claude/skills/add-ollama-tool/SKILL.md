---
name: add-ollama-tool
description: Add Ollama MCP tools so agents can delegate sub-tasks to local models running in a Kubernetes Service.
---

# Add Ollama MCP Tools

This skill adds two tools to the agent container:
- `ollama_list_models` — lists models installed in the Ollama K8s Service
- `ollama_generate` — runs inference on a local model

**Note:** This is different from `llmProvider: 'ollama'`, where Ollama is the *primary* LLM backend for the whole agent. Here, the orchestrating model (e.g. Claude or GPT-4o) remains in control and can *delegate* specific sub-tasks to cheaper/faster local models.

## Prerequisites

Ollama must be running as a Kubernetes Deployment + Service in your cluster, accessible at `http://ollama:11434` from within agent pods.

The Service should carry the label `app: ollama` so the kubeclaw NetworkPolicy allows agent pods to reach it on port 11434.

Example minimal Ollama K8s resources:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: kubeclaw
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ollama
  template:
    metadata:
      labels:
        app: ollama
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:latest
          ports:
            - containerPort: 11434
---
apiVersion: v1
kind: Service
metadata:
  name: ollama
  namespace: kubeclaw
spec:
  selector:
    app: ollama
  ports:
    - port: 11434
      targetPort: 11434
```

Pull a model after deployment:
```bash
kubectl exec -n kubeclaw deploy/ollama -- ollama pull llama3.2
```

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-ollama-tool
npm run build
./container/build.sh
```

## Configure

Set `OLLAMA_HOST` in your `.env` or Helm values if Ollama runs at a non-default address:

```
OLLAMA_HOST=http://ollama.ai-tools:11434
```

Default: `http://ollama:11434` (same namespace as agent pods)

## Verify

Send a message to the agent:
> "Use ollama_list_models to check available local models"

The agent should return a list of installed models from your Ollama Service.

## Troubleshooting

**"Failed to connect to Ollama"**: Check that the `ollama` K8s Service exists in the same namespace and `OLLAMA_HOST` matches its cluster DNS name.

**NetworkPolicy blocking**: Ensure the Ollama Deployment has label `app: ollama`. The kubeclaw agent NetworkPolicy allows egress to port 11434 on pods with that label.

**Cross-namespace**: If Ollama runs in a different namespace, set `OLLAMA_HOST=http://ollama.<namespace>:11434` and add a `namespaceSelector` to the NetworkPolicy manually.
