#!/usr/bin/env bash
# Synthetic-only pg_dump/pg_restore rehearsal. Never accepts a production source.
set -euo pipefail
umask 077

container=temcotools-v2-build-db
source_db=temcotools_v2_upgrade_test
target_db=${2:-temcotools_v2_roundtrip_test}
evidence_dir=${1:-}
if [[ "$evidence_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]] || [[ "$target_db" != temcotools_v2_roundtrip*_test ]] || [[ ! "$target_db" =~ ^[a-z0-9_]+$ ]]; then
  echo 'Supply a new MacDev Qualification directory; an optional destination must match temcotools_v2_roundtrip*_test.' >&2
  exit 1
fi
if ! mount | rg -q ' on /Volumes/MacDev '; then echo 'MacDev is not mounted; no internal fallback.' >&2; exit 1; fi
parent_dir=$(cd "$(dirname "$evidence_dir")" && pwd -P)
if [[ "$parent_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification && "$parent_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]]; then echo 'Resolved evidence parent is outside MacDev Qualification.' >&2; exit 1; fi
evidence_dir="$parent_dir/$(basename "$evidence_dir")"
if [[ "$(docker inspect --format '{{index .Config.Labels "temcotools.task"}}' "$container")" != v2-build-20261031 ]]; then echo 'Task database container ownership label mismatch.' >&2; exit 1; fi
if [[ "$(docker exec "$container" psql -U postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname='$source_db'")" != 1 ]]; then echo 'Run the synthetic v1 upgrade test first.' >&2; exit 1; fi
if [[ "$(docker exec "$container" psql -U postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname='$target_db'")" != 0 ]]; then echo 'Restore destination already exists; no database will be overwritten or dropped.' >&2; exit 1; fi
mkdir -m 700 "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd -P)
if [[ "$evidence_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]]; then echo 'Resolved evidence directory is outside MacDev Qualification.' >&2; exit 1; fi

docker exec "$container" pg_dump -U postgres -Fc --no-owner --no-privileges "$source_db" > "$evidence_dir/synthetic-v2.dump"
shasum -a 256 "$evidence_dir/synthetic-v2.dump" > "$evidence_dir/synthetic-v2.dump.sha256"
docker exec "$container" createdb -U postgres "$target_db"
docker exec -i "$container" pg_restore -U postgres --dbname="$target_db" --no-owner --no-privileges --exit-on-error < "$evidence_dir/synthetic-v2.dump"

# Aggregate counts and deterministic data fingerprints, never row contents.
for table in User UserSession UserMfa IdentityRecoveryToken IdentityAudit InventoryAuditItem InventoryAuditImport InventoryAuditScan InventorySourceRevision InventoryImportMembership WarehouseUnit WarehouseIdentifier WarehousePhysicalObservation MarsUnit LabelPrinter LabelTemplate LabelIssuance; do
  key=id
  if [[ "$table" == UserMfa ]]; then key=userId; fi
  sql="SELECT count(*)::text || ':' || md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY \"$key\"),'')) FROM \"$table\" t"
  before=$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc "$sql")
  after=$(docker exec "$container" psql -U postgres -d "$target_db" -Atqc "$sql")
  if [[ "$before" != "$after" ]]; then echo "Restore comparison failed for $table; retain this backup and destination for investigation." >&2; exit 1; fi
  printf '%s %s\n' "$table" "$after" >> "$evidence_dir/table-fingerprints.txt"
done
printf 'PASS: synthetic pg_dump/pg_restore matched 17 table counts and data fingerprints; source and destination retained.\n'
