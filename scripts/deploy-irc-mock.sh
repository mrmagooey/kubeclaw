#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Deploying IRC Mock Server to Kubernetes ==="

# Build the image first
echo "Step 1: Building IRC Mock image..."
"${SCRIPT_DIR}/build-irc-mock.sh" latest

# Load the image into minikube
echo ""
echo "Step 2: Loading image into minikube..."
minikube image load "kubeclaw-irc-mock:latest"

# Apply the Kubernetes manifests
echo ""
echo "Step 3: Applying Kubernetes manifests..."
kubectl apply -f "${PROJECT_ROOT}/k8s/15-irc-mock.yaml"

# Wait for the deployment to be ready
echo ""
echo "Step 4: Waiting for deployment to be ready..."
kubectl rollout status deployment/kubeclaw-irc-mock -n kubeclaw --timeout=120s

# Check service
echo "Step 4: Verifying service..."
kubectl get service kubeclaw-irc-mock -n kubeclaw

echo ""
echo "=== Deployment Complete ==="
echo "IRC Mock Server is running at: kubeclaw-irc-mock.kubeclaw.svc.cluster.local:16667"
echo ""
echo "To view logs:"
echo "  kubectl logs -n kubeclaw -l app=kubeclaw-irc-mock -f"
