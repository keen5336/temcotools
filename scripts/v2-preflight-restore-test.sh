#!/usr/bin/env bash
# Synthetic-only pg_dump/pg_restore rehearsal. Never accepts a production source.
set -euo pipefail
umask 077

container=temcotools-v2-build-db
source_db=${3:-temcotools_v2_upgrade_31_test}
target_db=${2:-temcotools_v2_roundtrip_31_test}
evidence_dir=${1:-}
if [[ "$evidence_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]] || [[ ! "$target_db" =~ ^temcotools_v2_roundtrip(_[a-z0-9]+)*_test$ ]] || [[ ! "$source_db" =~ ^temcotools_v2_upgrade(_[a-z0-9]+)*_test$ ]]; then
  echo 'Supply a new MacDev Qualification directory; optional destination/source must be explicitly named synthetic roundtrip/upgrade test databases.' >&2
  exit 1
fi
if ! mount | rg -q ' on /Volumes/MacDev '; then echo 'MacDev is not mounted; no internal fallback.' >&2; exit 1; fi
parent_dir=$(cd "$(dirname "$evidence_dir")" && pwd -P)
if [[ "$parent_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification && "$parent_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]]; then echo 'Resolved evidence parent is outside MacDev Qualification.' >&2; exit 1; fi
evidence_dir="$parent_dir/$(basename "$evidence_dir")"
if [[ "$(docker inspect --format '{{index .Config.Labels "temcotools.task"}}' "$container")" != v2-build-20261031 ]]; then echo 'Task database container ownership label mismatch.' >&2; exit 1; fi
if [[ "$(docker exec "$container" psql -U postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname='$source_db'")" != 1 ]]; then echo 'Run the synthetic v1 upgrade test first.' >&2; exit 1; fi
if [[ "$(docker exec "$container" psql -U postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname='$target_db'")" != 0 ]]; then echo 'Restore destination already exists; no database will be overwritten or dropped.' >&2; exit 1; fi
if [[ "$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" != 31 ]]; then echo 'The renewed rehearsal requires all 31 qualified migrations.' >&2; exit 1; fi
for table in UserSession UserMfa WarehouseUnitNote WarehouseUnitNoteRevision MarsImportRow MarsAuditScan MarsAuditReport MarsSubmissionIntent MarsSubmissionIntentEvent MarsCommandReceipt OfficeDisposition WarehousePhysicalObservation PrintingDevice LabelIssuance LabelIssuanceEvent AppAccessGrant Payload PayloadVersion PayloadAudit SiteProfile; do
  if [[ "$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc "SELECT count(*)>0 FROM \"$table\"")" != t ]]; then echo "Missing populated synthetic $table fixture; run the full renewed upgrade test first." >&2; exit 1; fi
done
mkdir -m 700 "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd -P)
if [[ "$evidence_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]]; then echo 'Resolved evidence directory is outside MacDev Qualification.' >&2; exit 1; fi

docker exec "$container" pg_dump -U postgres -Fc --no-owner --no-privileges "$source_db" > "$evidence_dir/synthetic-v2.dump"
shasum -a 256 "$evidence_dir/synthetic-v2.dump" > "$evidence_dir/synthetic-v2.dump.sha256"
docker exec "$container" createdb -U postgres "$target_db"
docker exec -i "$container" pg_restore -U postgres --dbname="$target_db" --no-owner --no-privileges --exit-on-error < "$evidence_dir/synthetic-v2.dump"

# Compare every public table, including composite-key tables. Sorting the full
# synthetic row text avoids assumptions about an `id` column. No rows are emitted.
docker exec "$container" psql -U postgres -d "$source_db" -Atqc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename" > "$evidence_dir/tables.txt"
docker exec "$container" psql -U postgres -d "$target_db" -Atqc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename" > "$evidence_dir/restored-tables.txt"
if ! cmp -s "$evidence_dir/tables.txt" "$evidence_dir/restored-tables.txt"; then echo 'Restore table inventory differs; retain both databases for investigation.' >&2; exit 1; fi
table_count=0
while IFS= read -r table; do
  if [[ ! "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then echo 'Unexpected table identifier; no SQL interpolation attempted.' >&2; exit 1; fi
  sql="SELECT count(*)::text || ':' || md5(coalesce(string_agg(row_json, E'\\n' ORDER BY row_json COLLATE \"C\"),'')) FROM (SELECT row_to_json(t)::text AS row_json FROM \"$table\" t) source_rows"
  before=$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc "$sql")
  after=$(docker exec "$container" psql -U postgres -d "$target_db" -Atqc "$sql")
  if [[ "$before" != "$after" ]]; then echo "Restore comparison failed for $table; retain this backup and destination for investigation." >&2; exit 1; fi
  printf '%s %s\n' "$table" "$after" >> "$evidence_dir/table-fingerprints.txt"
  table_count=$((table_count+1))
done < "$evidence_dir/tables.txt"

# Restoration must retain the actual append-only guards, not only their rows.
for table in MarsImportRow WarehouseUnitNoteRevision PayloadVersion; do
  if docker exec "$container" psql -U postgres -d "$target_db" -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE \"$table\" SET id=id; ROLLBACK;" > "$evidence_dir/$table-immutable-check.txt" 2>&1; then
    echo "Restored $table unexpectedly allowed rewriting; retain the fixture." >&2; exit 1
  fi
  if ! rg -q 'immutable' "$evidence_dir/$table-immutable-check.txt"; then echo "Restored $table check failed for an unexpected reason; retain diagnostics." >&2; exit 1; fi
done
printf 'PASS: all 31 migrations restored; %s public tables matched counts/data fingerprints; populated new custody tables and immutable guards retained. No database dropped.\n' "$table_count"
