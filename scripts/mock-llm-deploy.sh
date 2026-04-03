#!/usr/bin/env bash
# Deploy the mock LLM server into Kubernetes using a ConfigMap to embed the JS script.
# Usage: ./scripts/mock-llm-deploy.sh [namespace]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

NS="${1:-kubeclaw}"

JS_FILE="${PROJECT_ROOT}/scripts/mock-llm-server.js"

if [[ ! -f "${JS_FILE}" ]]; then
  echo "ERROR: ${JS_FILE} not found" >&2
  exit 1
fi

echo "=== Deploying Mock LLM Server to namespace: ${NS} ==="

# Step 1: ConfigMap — read JS from disk to avoid heredoc escaping issues
echo ""
echo "Step 1: Applying ConfigMap (kubeclaw-mock-llm)..."
kubectl create configmap kubeclaw-mock-llm \
  --from-file=mock-llm-server.js="${JS_FILE}" \
  -n "${NS}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Step 2: Deployment
echo ""
echo "Step 2: Applying Deployment (kubeclaw-mock-llm)..."
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeclaw-mock-llm
  namespace: ${NS}
  labels:
    app: kubeclaw-mock-llm
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubeclaw-mock-llm
  template:
    metadata:
      labels:
        app: kubeclaw-mock-llm
    spec:
      containers:
        - name: mock-llm
          image: node:22-alpine
          command: ["node", "/scripts/mock-llm-server.js"]
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
          volumeMounts:
            - name: mock-llm-script
              mountPath: /scripts/mock-llm-server.js
              subPath: mock-llm-server.js
      volumes:
        - name: mock-llm-script
          configMap:
            name: kubeclaw-mock-llm
EOF

# Step 3: Service
echo ""
echo "Step 3: Applying Service (kubeclaw-mock-llm)..."
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: kubeclaw-mock-llm
  namespace: ${NS}
  labels:
    app: kubeclaw-mock-llm
spec:
  type: ClusterIP
  selector:
    app: kubeclaw-mock-llm
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
EOF

# Step 4: Wait for rollout
echo ""
echo "Step 4: Waiting for deployment to be ready..."
kubectl rollout status deployment/kubeclaw-mock-llm -n "${NS}" --timeout=60s

echo ""
echo "=== Deployment Complete ==="
echo "In-cluster base URL: http://kubeclaw-mock-llm.${NS}.svc.cluster.local/v1"
echo ""
echo "To view logs:"
echo "  kubectl logs -n ${NS} -l app=kubeclaw-mock-llm -f"
