#!/usr/bin/env bash
# Tear down the mock LLM server from Kubernetes.
# Usage: ./scripts/mock-llm-teardown.sh [namespace]
set -euo pipefail

NS="${1:-kubeclaw}"

echo "=== Tearing down Mock LLM Server from namespace: ${NS} ==="

kubectl delete deployment kubeclaw-mock-llm -n "${NS}" --ignore-not-found
kubectl delete service    kubeclaw-mock-llm -n "${NS}" --ignore-not-found
kubectl delete configmap  kubeclaw-mock-llm -n "${NS}" --ignore-not-found

echo ""
echo "=== Teardown Complete ==="
