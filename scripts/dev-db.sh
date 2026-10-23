#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for development and tests (no Docker required).
set -euo pipefail
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="${PGDATA_DIR:-$(pwd)/.pgdata}"
PORT="${PGPORT:-54329}"
# PostgreSQL refuses to run as root; delegate to the postgres system user when needed.
run() { if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown postgres "$DATA"
      run "$PGBIN/initdb" -D "$DATA" -U erp_owner --auth=trust >/dev/null
    fi
    if ! run "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      run "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null
    fi
    psql -h localhost -p "$PORT" -U erp_owner -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='erp'" | grep -q 1 \
      || psql -h localhost -p "$PORT" -U erp_owner -d postgres -c "CREATE DATABASE erp" >/dev/null
    psql -h localhost -p "$PORT" -U erp_owner -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='erp_test'" | grep -q 1 \
      || psql -h localhost -p "$PORT" -U erp_owner -d postgres -c "CREATE DATABASE erp_test" >/dev/null
    echo "postgres running on localhost:$PORT (databases: erp, erp_test)"
    ;;
  stop) run "$PGBIN/pg_ctl" -D "$DATA" stop ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
