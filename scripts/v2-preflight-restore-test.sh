#!/usr/bin/env bash
# Synthetic-only pg_dump/pg_restore rehearsal. Never accepts a production source.
set -euo pipefail
umask 077

container=temcotools-v2-build-db
source_db=${3:-temcotools_v2_upgrade_40_test}
target_db=${2:-temcotools_v2_roundtrip_40_test}
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
if [[ "$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" != 40 ]]; then echo 'The renewed rehearsal requires all 40 qualified migrations.' >&2; exit 1; fi
for table in UserSession UserMfa WarehouseUnitNote WarehouseUnitNoteRevision MarsImportRow MarsAuditScan MarsAuditReport MarsSubmissionIntent MarsSubmissionIntentEvent MarsCommandReceipt OfficeDisposition WarehousePhysicalObservation PrintingDevice LabelIssuance LabelIssuanceEvent AppAccessGrant Payload PayloadVersion PayloadAudit SiteProfile WorkflowDefinitionRecord WorkflowDefinitionVersion WorkflowRunRecord WorkflowRunEvent WorkflowIntentRecord IntegrationActionRecord IntegrationActionVersion ProviderConnection PlatformTemplateRecord PlatformTemplateVersion IdentityAudit SiteTemplateBinding WarehouseUnitOrigin WarehouseUnitSite WarehouseUnitAlias WarehouseUnitAliasVisibility WarehouseUnitTransfer WarehouseUnitTransferEvent; do
  if [[ "$(docker exec "$container" psql -U postgres -d "$source_db" -Atqc "SELECT count(*)>0 FROM \"$table\"")" != t ]]; then echo "Missing populated synthetic $table fixture; run the full renewed upgrade test first." >&2; exit 1; fi
done
mkdir -m 700 "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd -P)
if [[ "$evidence_dir" != /Volumes/MacDev/ProjectArchive/Development/Qualification/* ]]; then echo 'Resolved evidence directory is outside MacDev Qualification.' >&2; exit 1; fi

# A database archive excludes cluster roles. Prepare only the documented
# NOLOGIN principals on a new recovery cluster; never turn an application role
# into a superuser or silently repair a conflicting existing role.
docker exec -i "$container" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 > "$evidence_dir/restore-role-preparation.txt" <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_runtime') THEN CREATE ROLE temco_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_custody_reader') THEN CREATE ROLE temco_custody_reader NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_custody_writer') THEN CREATE ROLE temco_custody_writer NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('temco_runtime','temco_custody_reader','temco_custody_writer') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole))
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_runtime' AND rolbypassrls)
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('temco_custody_reader','temco_custody_writer') AND (NOT rolbypassrls OR rolinherit))
 OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname IN ('temco_custody_reader','temco_custody_writer') AND u.rolname='temco_runtime') THEN RAISE EXCEPTION 'Conflicting recovery role attributes/membership; ordinary runtime must remain restricted.'; END IF;
END $$;
SQL

docker exec "$container" pg_dump -U postgres -Fc "$source_db" > "$evidence_dir/synthetic-v2.dump"
shasum -a 256 "$evidence_dir/synthetic-v2.dump" > "$evidence_dir/synthetic-v2.dump.sha256"
shasum -a 256 -c --status "$evidence_dir/synthetic-v2.dump.sha256"
docker exec "$container" createdb -U postgres "$target_db"
docker exec -i "$container" pg_restore -U postgres --dbname="$target_db" --exit-on-error < "$evidence_dir/synthetic-v2.dump"

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

# Compare owners, effective ACLs, fixed SECURITY DEFINER settings, forced RLS,
# policies, triggers and defaults. A row-only comparison misses these controls.
cat > "$evidence_dir/security-catalog.sql" <<'SQL'
WITH entries AS (
 SELECT 'relation:'||c.relname AS object, jsonb_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'acl',coalesce((SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a),'[]'::jsonb)) AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')
 UNION ALL SELECT 'function:'||p.oid::regprocedure::text,jsonb_build_object('owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'settings',p.proconfig,'definition',md5(pg_get_functiondef(p.oid)),'acl',coalesce((SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'[]'::jsonb)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
 UNION ALL SELECT 'policy:'||tablename||':'||policyname,to_jsonb(p)-'schemaname'-'tablename'-'policyname' FROM pg_policies p WHERE schemaname='public'
 UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
 UNION ALL SELECT 'defaults:'||pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'')||':'||d.defaclobjtype::text,jsonb_build_object('acl',coalesce((SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(d.defaclacl) a),'[]'::jsonb)) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
) SELECT object||' '||value::text FROM entries ORDER BY object COLLATE "C";
SQL
docker exec -i "$container" psql -X -U postgres -d "$source_db" -At -v ON_ERROR_STOP=1 < "$evidence_dir/security-catalog.sql" > "$evidence_dir/source-security.txt"
docker exec -i "$container" psql -X -U postgres -d "$target_db" -At -v ON_ERROR_STOP=1 < "$evidence_dir/security-catalog.sql" > "$evidence_dir/restored-security.txt"
if ! cmp -s "$evidence_dir/source-security.txt" "$evidence_dir/restored-security.txt"; then echo 'Restored ownership/ACL/RLS/functions differ; do not open admission.' >&2; exit 1; fi

# Restoration must retain the actual append-only guards, not only their rows.
for table in MarsImportRow WarehouseUnitNoteRevision PayloadVersion IntegrationActionVersion PlatformTemplateVersion WarehouseUnitTransferEvent; do
  if docker exec "$container" psql -U postgres -d "$target_db" -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE \"$table\" SET id=id; ROLLBACK;" > "$evidence_dir/$table-immutable-check.txt" 2>&1; then
    echo "Restored $table unexpectedly allowed rewriting; retain the fixture." >&2; exit 1
  fi
  if ! rg -q 'immutable' "$evidence_dir/$table-immutable-check.txt"; then echo "Restored $table check failed for an unexpected reason; retain diagnostics." >&2; exit 1; fi
done
# Exercise restored RLS as the actual restricted SQL principal, including the
# destination's accepted shared identity without its source private history.
docker exec -i "$container" psql -X -U postgres -d "$target_db" -v ON_ERROR_STOP=1 > "$evidence_dir/restored-runtime-rls.txt" <<'SQL'
SELECT s.id AS restore_session,u."authVersion" AS restore_generation FROM "UserSession" s JOIN "User" u ON u.id=s."userId" WHERE u.id='synthetic-v1-admin' AND s."revokedAt" IS NULL ORDER BY s."createdAt" DESC LIMIT 1 \gset
SET SESSION AUTHORIZATION temco_runtime;
SELECT set_config('temco.site_id','warehouse-initial',false),set_config('temco.user_id','synthetic-v1-admin',false),set_config('temco.session_id',:'restore_session',false),set_config('temco.auth_version',:'restore_generation',false);
DO $$ BEGIN IF (SELECT count(*) FROM "WarehouseUnitNote")<1 OR (SELECT count(*) FROM "WarehouseUnitOrigin")<1 THEN RAISE EXCEPTION 'Restored authorized source records are unavailable.'; END IF; END $$;
SELECT set_config('temco.site_id',(SELECT id FROM "WarehouseSite" WHERE slug='synthetic-restore-destination'),false);
DO $$ BEGIN IF (SELECT count(*) FROM "WarehouseUnit")<>1 OR (SELECT count(*) FROM "WarehouseUnitOrigin")<>0 OR (SELECT count(*) FROM "WarehouseUnitNote")<>0 OR (SELECT count(*) FROM "WarehouseIdentifier")<>0 THEN RAISE EXCEPTION 'Restored shared identity/private history isolation failed.'; END IF; END $$;
SELECT set_config('temco.site_id','',false);
DO $$ BEGIN IF (SELECT count(*) FROM "WarehouseUnit")<>0 THEN RAISE EXCEPTION 'Restored context-free runtime saw units.'; END IF; END $$;
SQL
if docker exec "$container" psql -X -U postgres -d "$target_db" -v ON_ERROR_STOP=1 -c 'SET SESSION AUTHORIZATION temco_runtime; SET ROLE temco_custody_writer;' > "$evidence_dir/runtime-escalation-denied.txt" 2>&1; then echo 'Ordinary runtime acquired a privileged custody role.' >&2; exit 1; fi
if ! rg -q 'permission denied' "$evidence_dir/runtime-escalation-denied.txt"; then echo 'Runtime escalation check failed for an unexpected reason.' >&2; exit 1; fi
printf 'PASS: all 40 migrations restored; %s public tables matched counts/data fingerprints; populated ledgers, owners/ACL/RLS, restricted runtime and six immutable guards retained. No database dropped.\n' "$table_count"
