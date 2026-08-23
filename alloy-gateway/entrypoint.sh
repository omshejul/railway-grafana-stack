#!/bin/sh
set -eu

/usr/local/bin/alloy run --server.http.listen-addr=0.0.0.0:12345 /etc/alloy/config.alloy &
alloy_pid=$!
printf '%s' "$alloy_pid" > /tmp/alloy.pid

stop() {
  kill -TERM "$alloy_pid" 2>/dev/null || true
  wait "$alloy_pid" 2>/dev/null || true
}
trap stop EXIT INT TERM

exec nginx -g 'daemon off;'
