#!/bin/sh
set -eu

: "${BOOKKEEPING_METRICS_TOKEN:?BOOKKEEPING_METRICS_TOKEN is required}"

secret_dir=/etc/prometheus/secrets
credential_file="${secret_dir}/bookkeeping-metrics-token"
install -d -m 0700 "$secret_dir"
umask 077
printf '%s' "$BOOKKEEPING_METRICS_TOKEN" > "$credential_file"
chmod 0400 "$credential_file"
unset BOOKKEEPING_METRICS_TOKEN

exec /bin/prometheus "$@"
