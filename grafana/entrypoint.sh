#!/bin/sh
set -eu

# Grafana 13.1.3's SQLite driver drops the WAL pragma from its connection URL.
sqlite3 "${GF_PATHS_DATA}/grafana.db" 'PRAGMA journal_mode=WAL;' >/dev/null
exec /run.sh "$@"
