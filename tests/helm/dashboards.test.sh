#!/usr/bin/env bash
# tests/helm/dashboards.test.sh
# Integration-level: render dashboards and verify JSON validity with jq/python3.
set -euo pipefail

CHART="./helm/kubeclaw"
NAMESPACE="kubeclaw-test"

echo "=== [1/3] Render chart with dashboards.enabled=true ==="
helm template kubeclaw "$CHART" \
  --set dashboards.enabled=true \
  --namespace "$NAMESPACE" \
  > /tmp/kubeclaw-dashboards.yaml

echo "=== [2/3] Validate kubeclaw-overview.json ==="
python3 -c "
import yaml, json, sys

with open('/tmp/kubeclaw-dashboards.yaml') as f:
    docs = list(yaml.safe_load_all(f))

overview = None
for d in docs:
    if d and d.get('kind') == 'ConfigMap' and d.get('metadata', {}).get('name') == 'kubeclaw-overview-dashboard':
        overview = d
        break

if not overview:
    print('ERROR: kubeclaw-overview-dashboard ConfigMap not found')
    sys.exit(1)

json_str = overview['data']['kubeclaw-overview.json']
parsed = json.loads(json_str)
panel_count = len(parsed['panels'])
print(f'kubeclaw-overview.json: valid JSON, {panel_count} panels')

if panel_count < 6:
    print(f'ERROR: expected >= 6 panels in overview dashboard, found {panel_count}')
    sys.exit(1)
"

echo "=== [3/3] Validate kubeclaw-llm-detail.json ==="
python3 -c "
import yaml, json, sys

with open('/tmp/kubeclaw-dashboards.yaml') as f:
    docs = list(yaml.safe_load_all(f))

detail = None
for d in docs:
    if d and d.get('kind') == 'ConfigMap' and d.get('metadata', {}).get('name') == 'kubeclaw-llm-detail-dashboard':
        detail = d
        break

if not detail:
    print('ERROR: kubeclaw-llm-detail-dashboard ConfigMap not found')
    sys.exit(1)

json_str = detail['data']['kubeclaw-llm-detail.json']
parsed = json.loads(json_str)
panel_count = len(parsed['panels'])
print(f'kubeclaw-llm-detail.json: valid JSON, {panel_count} panels')

if panel_count < 6:
    print(f'ERROR: expected >= 6 panels in LLM detail dashboard, found {panel_count}')
    sys.exit(1)
"

echo "=== ALL CHECKS PASSED ==="
