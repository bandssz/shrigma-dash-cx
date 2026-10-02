#!/usr/bin/env bash
# Public, one-use catalog audit. No connection URI or credential belongs here.
set -euo pipefail
umask 077
export LC_ALL=C

readonly SQL_FILE=/audit/catalog.sql
readonly STATE_DIR=/audit-state
readonly SQL_SHA256=286b54d7b591b6cb2302ea4fe091bf7caf9acf8ae8e436a14855a41ebedb093c

hold_without_database() {
  unset PGPASSWORD
  exec sleep infinity
}

finish_failure() {
  local reason=$1
  rm -f "$STATE_DIR/result.pending"
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"failed","reason":"%s"}\n' "$reason" > "$STATE_DIR/status.json"
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"failed","reason":"%s"}\n' "$reason"
  hold_without_database
}

# This exact internal destination is part of the reviewed deployment contract.
# Do not change it to a public host or reuse an application PostgreSQL role.
if [[ ${PGHOST:-} != comunicacao_postgres || ${PGDATABASE:-} != listmonk || ${PGUSER:-} != postgres || ${PGPORT:-5432} != 5432 || -z ${PGPASSWORD:-} ]]; then
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"setup_failed","reason":"connection_contract"}\n'
  hold_without_database
fi
if [[ ! -r "$SQL_FILE" || ! -d "$STATE_DIR" || ! -w "$STATE_DIR" ]]; then
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"setup_failed","reason":"mount_contract"}\n'
  hold_without_database
fi
if [[ $(sha256sum "$SQL_FILE" | awk '{print $1}') != "$SQL_SHA256" ]]; then
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"setup_failed","reason":"sql_checksum"}\n'
  hold_without_database
fi

# Claim before any database connection. Reboots/redeploys never retry the query.
# A pre-existing marker requires explicit review and a different fresh volume.
if ! mkdir "$STATE_DIR/attempt" 2>/dev/null; then
  printf '{"schema":"dashboard-catalog-audit-status-v1","state":"already_attempted"}\n'
  hold_without_database
fi
printf '{"schema":"dashboard-catalog-audit-status-v1","state":"claimed"}\n' > "$STATE_DIR/status.json"
sync "$STATE_DIR/attempt" "$STATE_DIR/status.json" "$STATE_DIR"

# Ignore ambient libpq service/address/password-file overrides and startup files.
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGPASSFILE PGREQUIRESSL PGREQUIREAUTH
export PGPORT=5432 PGCONNECT_TIMEOUT=5 PGSSLMODE=disable
export PGCLIENTENCODING=UTF8 PGAPPNAME=dashboard-catalog-audit-20261002
export PGTARGETSESSIONATTRS=any
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=250 -c idle_in_transaction_session_timeout=15000 -c search_path=pg_catalog'

# One psql process, one connection, fixed SQL. Never publish raw stderr.
# No -1: the SQL already owns BEGIN READ ONLY and ends with ROLLBACK.
if ! psql -X -w -q -A -t -v ON_ERROR_STOP=1 -P pager=off -f "$SQL_FILE" > "$STATE_DIR/result.pending" 2>/dev/null; then
  finish_failure query_failed
fi
unset PGPASSWORD

# Pinned queries return eight JSON records containing fixed names and scalars.
# This rejects control characters, unexpected escaping, long output and sections.
if [[ $(wc -l < "$STATE_DIR/result.pending") -ne 8 || $(wc -c < "$STATE_DIR/result.pending") -gt 65536 ]]; then
  finish_failure output_shape
fi
if [[ $(tr -d 'A-Za-z0-9_.,: []{}()"\n' < "$STATE_DIR/result.pending" | wc -c) -ne 0 ]]; then
  finish_failure output_characters
fi
if ! awk '
  $0 !~ /^\{"rows": / { bad=1 }
  $0 !~ /, "section": "(database|relations|columns|constraints|indexes|functions|reader_role|reader_privileges)"\}$/ { bad=1 }
  /, "section": "database"\}$/ { database++ }
  /, "section": "relations"\}$/ { relations++ }
  /, "section": "columns"\}$/ { columns++ }
  /, "section": "constraints"\}$/ { constraints++ }
  /, "section": "indexes"\}$/ { indexes++ }
  /, "section": "functions"\}$/ { functions++ }
  /, "section": "reader_role"\}$/ { reader_role++ }
  /, "section": "reader_privileges"\}$/ { reader_privileges++ }
  END { exit (bad || NR != 8 || database != 1 || relations != 1 || columns != 1 || constraints != 1 || indexes != 1 || functions != 1 || reader_role != 1 || reader_privileges != 1) }
' "$STATE_DIR/result.pending"; then
  finish_failure output_sections
fi

mv "$STATE_DIR/result.pending" "$STATE_DIR/result.jsonl"
printf '{"schema":"dashboard-catalog-audit-status-v1","state":"ok","sections":8}\n' > "$STATE_DIR/status.json"
sync "$STATE_DIR/result.jsonl" "$STATE_DIR/status.json" "$STATE_DIR"
cat "$STATE_DIR/result.jsonl"
printf '{"schema":"dashboard-catalog-audit-status-v1","state":"ok","sections":8}\n'
hold_without_database
