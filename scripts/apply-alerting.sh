#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
context=${GCX_CONTEXT:-grafana}
rules=(
  availability-rule.json
  application-error-rule.json
  telemetry-export-failure-rule.json
  django-unauthorized-rate-rule.json
  bookkeeping-worker-stale-rule.json
  bookkeeping-worker-failure-rule.json
  amul-catalog-stale-rule.json
  amul-catalog-failure-rate-rule.json
)

for filename in "${rules[@]}"; do
  path="${repo_dir}/grafana/alerting/${filename}"
  uid=$(jq -r '.uid' "${path}")
  if gcx --context "${context}" api "/api/v1/provisioning/alert-rules/${uid}" >/dev/null 2>&1; then
    gcx --context "${context}" api "/api/v1/provisioning/alert-rules/${uid}" -X PUT -d "@${path}" >/dev/null
    echo "updated alert rule ${uid}"
  else
    gcx --context "${context}" api /api/v1/provisioning/alert-rules -X POST -d "@${path}" >/dev/null
    echo "created alert rule ${uid}"
  fi
done

gcx --context "${context}" api /api/v1/provisioning/policies \
  -X PUT -d "@${repo_dir}/grafana/alerting/notification-policy.json" >/dev/null
echo "updated notification policy"
