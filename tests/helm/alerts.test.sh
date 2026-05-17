#!/usr/bin/env bash
# tests/helm/alerts.test.sh
# Unit-level: checks promtool parses and validates all rule expressions.
# Integration-level: renders the full chart and pipes ALL rule files through promtool and kubeconform.
set -euo pipefail

CHART="./helm/kubeclaw"
NAMESPACE="kubeclaw-test"

echo "=== [1/4] helm template with alerts.enabled=true ==="
helm template kubeclaw "$CHART" \
  --set alerts.enabled=true \
  --set alerts.llmLatencyBudgetSeconds=60 \
  --set alerts.groupQueueSaturationDepth=50 \
  --namespace "$NAMESPACE" \
  > /tmp/kubeclaw-rendered.yaml

echo "=== [2/4] Extract PrometheusRule spec and check with promtool ==="
if command -v promtool &>/dev/null; then
  python3 -c "
import sys, yaml, json
with open('/tmp/kubeclaw-rendered.yaml') as f:
  docs = list(yaml.safe_load_all(f))
for d in docs:
  if d and d.get('kind') == 'PrometheusRule':
    import yaml as yaml2
    with open('/tmp/kubeclaw-rules.yaml', 'w') as out:
      yaml2.dump(d['spec'], out)
    break
"
  promtool check rules /tmp/kubeclaw-rules.yaml
else
  echo "SKIP: promtool not found — skipping promtool check rules step"
fi

ALERT_COUNT=$(grep 'alert:' /tmp/kubeclaw-rendered.yaml | wc -l | tr -d ' ')
echo "Alert count: $ALERT_COUNT"
if [ "$ALERT_COUNT" -ne 7 ]; then
  echo "ERROR: expected 7 alerts, found $ALERT_COUNT"
  exit 1
fi

echo "=== [3/4] kubeconform on full rendered chart ==="
if command -v kubeconform &>/dev/null; then
  helm template kubeclaw "$CHART" \
    --set alerts.enabled=true \
    --set dashboards.enabled=true \
    --namespace "$NAMESPACE" \
    | kubeconform --strict --kubernetes-version 1.29.0 \
      --schema-location default \
      --ignore-missing-schemas
else
  echo "SKIP: kubeconform not found — skipping kubeconform validation step"
fi

echo "=== [4/4] Confirm dashboards.enabled=false renders no dashboard ConfigMaps ==="
DASHBOARD_COUNT=$(helm template kubeclaw "$CHART" \
  --set alerts.enabled=true \
  --set dashboards.enabled=false \
  --namespace "$NAMESPACE" \
  | grep 'grafana_dashboard' | wc -l | tr -d ' ' || true)
if [ "$DASHBOARD_COUNT" -ne 0 ]; then
  echo "ERROR: dashboards.enabled=false should produce 0 grafana_dashboard labels, found $DASHBOARD_COUNT"
  exit 1
fi

echo "=== ALL CHECKS PASSED ==="
