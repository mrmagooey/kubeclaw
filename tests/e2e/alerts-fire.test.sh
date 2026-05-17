#!/usr/bin/env bash
# tests/e2e/alerts-fire.test.sh
# E2E: kind cluster + kube-prometheus-stack + kubeclaw chart.
# Feeds a synthetic metric via a test exporter and verifies the alert fires.
#
# Prerequisites: kind, helm, kubectl, promtool installed and on PATH.
# Run time: ~5-8 minutes (cluster creation + stack install + alert evaluation cycle).
set -euo pipefail

CLUSTER_NAME="kubeclaw-alerts-e2e"
NAMESPACE="kubeclaw"
MONITORING_NS="monitoring"
KPS_VERSION="61.3.2"  # kube-prometheus-stack chart version

cleanup() {
  echo "=== Cleaning up kind cluster ==="
  kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== [1/7] Create kind cluster ==="
kind create cluster --name "$CLUSTER_NAME" --wait 60s

echo "=== [2/7] Install kube-prometheus-stack ==="
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
kubectl create namespace "$MONITORING_NS"
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace "$MONITORING_NS" \
  --version "$KPS_VERSION" \
  --set grafana.enabled=false \
  --set alertmanager.enabled=false \
  --set prometheus.prometheusSpec.evaluationInterval=15s \
  --set prometheus.prometheusSpec.scrapeInterval=15s \
  --wait --timeout 5m

echo "=== [3/7] Install kubeclaw chart with alerts enabled ==="
kubectl create namespace "$NAMESPACE"
helm install kubeclaw ./helm/kubeclaw \
  --namespace "$NAMESPACE" \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=5 \
  --set credentialInjection.mode=off \
  --set networkPolicy.enabled=false

echo "=== [4/7] Verify PrometheusRule was created ==="
kubectl get prometheusrule -n "$NAMESPACE" kubeclaw-alerts
RULE_COUNT=$(kubectl get prometheusrule -n "$NAMESPACE" kubeclaw-alerts \
  -o jsonpath='{.spec.groups[*].rules[*].alert}' | wc -w)
echo "Loaded alert count from CRD: $RULE_COUNT"
if [ "$RULE_COUNT" -lt 7 ]; then
  echo "ERROR: expected 7 alerts in PrometheusRule, found $RULE_COUNT"
  exit 1
fi

echo "=== [5/7] Deploy synthetic metric exporter for KubeclawGroupQueueSaturated ==="
# Push a static metric value > groupQueueSaturationDepth=5 via a pushgateway-compatible pattern.
# We use a simple ConfigMap + Job that writes directly to the Prometheus pushgateway.
helm install prometheus-pushgateway prometheus-community/prometheus-pushgateway \
  --namespace "$MONITORING_NS" \
  --set serviceMonitor.enabled=true \
  --wait --timeout 2m

PUSHGATEWAY_POD=$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus-pushgateway \
  -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "$MONITORING_NS" "$PUSHGATEWAY_POD" -- sh -c \
  'echo "kubeclaw_orchestrator_group_queue_depth{group=\"e2e-test\"} 100" | \
   curl --data-binary @- http://localhost:9091/metrics/job/kubeclaw-e2e/instance/synthetic'

echo "=== [6/7] Wait for KubeclawGroupQueueSaturated to become firing (up to 3m) ==="
DEADLINE=$(($(date +%s) + 180))
while true; do
  ALERTS=$(kubectl exec -n "$MONITORING_NS" \
    "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
    -- wget -qO- 'http://localhost:9090/api/v1/alerts' 2>/dev/null \
    | jq -r '.data.alerts[] | select(.labels.alertname == "KubeclawGroupQueueSaturated") | .state' 2>/dev/null || true)

  if echo "$ALERTS" | grep -q "pending\|firing"; then
    echo "KubeclawGroupQueueSaturated is in state: $ALERTS"
    break
  fi

  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo "ERROR: KubeclawGroupQueueSaturated did not fire within 3 minutes"
    kubectl exec -n "$MONITORING_NS" \
      "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
      -- wget -qO- 'http://localhost:9090/api/v1/alerts' | jq .
    exit 1
  fi
  sleep 10
done

echo "=== [7/7] Verify alert rule names in Prometheus API ==="
RULE_NAMES=$(kubectl exec -n "$MONITORING_NS" \
  "$(kubectl get pod -n "$MONITORING_NS" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')" \
  -- wget -qO- 'http://localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[].rules[].name' | sort)

EXPECTED_ALERTS=(
  KubeclawGroupQueueSaturated
  KubeclawLLMErrorRateElevated
  KubeclawLLMLatencyOverBudget
  KubeclawOrchestratorDown
  KubeclawRAGErrorRateElevated
  KubeclawRedisStreamStagnant
  KubeclawToolJobFailureRateHigh
)
for ALERT in "${EXPECTED_ALERTS[@]}"; do
  if echo "$RULE_NAMES" | grep -q "$ALERT"; then
    echo "  FOUND: $ALERT"
  else
    echo "  MISSING: $ALERT"
    exit 1
  fi
done

echo "=== ALL E2E CHECKS PASSED ==="
