# TemcoTools v2 cutover and recovery

This is a prepared maintenance procedure, not deployment approval. The standing build mandate authorizes source, local synthetic qualification, commits and publication on `v2`; it does not authorize production migration/deployment, mail, DNS, paid provisioning, real printer output or live MARS/DMP mutations. Preserve `v1` at `fea1f22af1b2fae788388f2aefed3e3998e98d09`, published `main`, the original checkout and all operational evidence. The integrated [build status](build-status.md) is authoritative for the final tested HEAD and remaining workflow/device gates. [Implementation plan](implementation-plan.md) and [MCP runbook](mcp-runbook.md) provide context.

## What the source upgrade does

Migrations are additive to the v1 schema. They preserve existing user IDs/PIN hashes, Inventory Audit rows/archive/verification state, independent scans, MARS submissions/events/audits, waves/recons, printer/template definitions, favorites and files. V1 cookie sessions lack the new persistent session/generation fields and must sign in again. Retaining a PIN hash for history does **not** enable PIN login.

The [warehouse migration](../../prisma/migrations/20261101020000_shared_warehouse_units/migration.sql) seeds one deterministic `WarehouseUnit` and WMS LPN alias per retained inventory row, plus its current full source-row revision marked `migrationSnapshot`. It does not reconstruct overwritten revisions, complete old report membership, physical presence, DMP relationships, serial/MSN links or MARS-to-unit identity. Archived/delivered source rows remain reported history. A genuine new import retains complete new membership; independent scans retain their original time and strength.

New MARS imports retain immutable full source rows and batch membership; old uncaptured MARS rows/membership and unsigned local captures are not invented. Unit-note corrections append revisions. Audit membership withdrawal preserves the original scan/physical evidence. Local MARS intents and label receipts survive independently of external submission, printing or departure.

The [identity migration](../../prisma/migrations/20261101020000_strong_identity_sessions/migration.sql) assigns legacy-equivalent bundles. The subsequent [permission correction](../../prisma/migrations/20261101030000_explicit_identity_review_permission/migration.sql) removes new identity-edit rights from legacy managers and revokes affected sessions. Office/dispatch/reviewer bundles are proposals, initially unassigned; review actual assignments before launch. Passwords and privileged MFA need individual enrollment. Password/reset/access changes revoke existing authority; normal warehouse login does not force all operators to adopt an authenticator.

## Maintenance tools

Run from the pinned external checkout with installed locked dependencies and generated Prisma client. These tools deliberately do not load `.env`. Supply the exact `DATABASE_URL` through a protected process environment and `--expect-database NAME`. They never print that URL, credential hashes, enrollment codes or customer/source rows. Driver errors are sanitized. Default targets must be loopback databases ending in `_test`, with no URL query parameters. A future authorized operational target additionally requires `--allow-operational-target`; that flag is an operator guard, not proof of owner authority.

| Tool | Default and effect |
| --- | --- |
| [v2-preflight.ts](../../scripts/v2-preflight.ts) | Read-only repeatable snapshot. Compares local migration SQL SHA-256 against applied history; reports pending/failed/checksum drift, account enrollment/MFA counts, WMS identity/snapshot/alias gaps, and durable label/DMP/MARS states. Privately checks enabled authenticator envelopes against the current MFA key; only aggregate unreadable-factor counts leave the process. `--phase migrate` permits reviewed pending SQL; `--phase launch` blocks pending SQL, incomplete active-account enrollment, unreadable/missing privileged MFA or recovery administrator and pending durable effect dispatch/human MARS handoffs. Unknown MARS/DMP/print results stay warnings requiring preserved evidence and separate reconciliation, never automatic retry. A prepared local MARS intent alone does not claim an upstream action. Exit `0`: no automated blockers; `2`: readiness blockers; `1`: invalid target/inspection error. Warnings and manual gates still require review. |
| [v2-backfill.ts](../../scripts/v2-backfill.ts) | Dry-run. `--apply --reason '…'` repairs only missing deterministic units, current full-row snapshots and safe canonical LPN aliases. Uses the WMS import advisory lock, bounded serializable transactions, `--limit 1..5000` (default 500), and `--after INTERNAL_ID`. Follow `nextCursor` until null. Repeating a page is safe. Existing links, revoked aliases and conflicting aliases survive; conflicts require the normal authorized identity-review workflow. An immutable current-revision conflict aborts rather than overwriting history. No old report membership or physical scan evidence is manufactured. |
| [v2-bootstrap.ts](../../scripts/v2-bootstrap.ts) | Dry-run, explicit exact username and exactly one mode. `--create --display-name '…'` creates an initial admin only when no enrolled active admin exists. `--enroll-existing` retains the exact active legacy admin ID and PIN hash. If an enrolled admin exists, use its authenticated assisted recovery. Applying also requires a reason and a new absolute `--delivery-file` outside the checkout in an operator-owned mode-0700 directory. The mode-0600 file receives one code, never stdout; only its hash is stored, expiring in 30 minutes. No email is sent. |
| Bootstrap compatibility | `npm run bootstrap -- …` / [bootstrap-admin.ts](../../scripts/bootstrap-admin.ts) invokes the same guarded tool. Legacy `BOOTSTRAP_ADMIN_PASSWORD`, default account/PIN and silent credential overwrite paths are gone. No seed script creates a public default login. |
| Synthetic restore rehearsal | [v2-preflight-upgrade.test.ts](../../scripts/v2-preflight-upgrade.test.ts) defaults through `20261101170000` (all 30 migrations) and refuses an outdated default cutoff. Fresh explicit upgrade/recovery/roundtrip `_test` names preserve prior fixtures. [v2-preflight-restore-test.sh](../../scripts/v2-preflight-restore-test.sh) accepts only the labeled local build container, a new MacDev evidence directory and a new synthetic destination; it compares every public table and checks restored immutable guards. |
| Recovery modes | The explicit offline admin mode and restored-access invalidation are described below. They are host-maintenance authority, not unauthenticated application endpoints or MCP self-approval. Normal user/session/recovery administration remains in the shared authorized UI/MCP services. |

Example local inspection and repair, after explicitly selecting the synthetic database:

```sh
export DATABASE_URL=postgresql://postgres@127.0.0.1:55439/temcotools_v2_test
dev-run -- npx tsx scripts/v2-preflight.ts --expect-database temcotools_v2_test --phase migrate
dev-run -- npx tsx scripts/v2-backfill.ts --expect-database temcotools_v2_test
dev-run -- npx tsx scripts/v2-backfill.ts --expect-database temcotools_v2_test --apply --reason 'Synthetic baseline repair rehearsal' --limit 500
# If nextCursor is non-null, repeat with --after and that exact internal ID.
```

These scripts do not silently retry transaction/connection failures. Preserve the receipt and private delivery file. Rerun read-only inspection; an ambiguous credential issuance or external dispatch is not permission to replay it. A failed bootstrap can leave an empty or populated private file; server token state decides validity. Use a new file for a deliberately reissued code; prior pending codes are consumed.

## Prepare before an authorized maintenance window

1. Pin the intended published `v2` commit and image digests; inspect branch/status/remotes, applied migration checksums and any drift from `main`. Never force-push/move `main` or `v1`. Preserve original local changes. The current [deploy.sh](../../scripts/deploy.sh) deliberately requires clean published `main`; it is **not** a v2 deployment command. Do not weaken or invoke that guard to deploy a worktree. Prepare a reviewed, pinned deployment change only under actual launch authority.
2. Rehearse from a protected copy of the actual v1 database in an isolated non-production environment before production cutover. A live backup contains customer data and credential material; keep it out of git, public logs and fixtures. Current synthetic receipts prove the migration mechanics, not production volume or data mapping.
3. Establish private secret custody: production `SESSION_SECRET`, persistent independent `MFA_ENCRYPTION_KEY` (32 random bytes encoded as 43 base64url characters), database access, any configured relay secrets and backup encryption/key access. Keep the MFA key available with a separate protected backup: replacing it makes enrolled authenticators unreadable. Request/deliver actual secrets through the runtime's secure secret mechanism when launch is authorized, never chat or a committed file. Check current Compose/runtime mapping at that time; a development fallback key is not production configuration.
4. Confirm HTTPS app origin, exact-origin proxy forwarding, secure cookies and private internal relay routes. Configure remote MCP issuer/resource/proxy only per the [MCP runbook](mcp-runbook.md); no unauthenticated database-backed MCP listener may be published. Preserve named DMP operations, per-user pairing and current relay restrictions. Read actual account/domain readiness before claiming outbound mail is configured. Admin-assisted recovery works without mail; no provider purchase/DNS/mail action is implied here.
5. Name the maintenance owner and office/floor contacts; record the window, enrollment delivery method, capability assignments and recovery custody privately. Ensure at least one active system administrator can enroll and regain access. Additional independently recoverable administrators are useful when staffing permits; the tool does not invent another account. Decide which inactive/unneeded accounts to disable deliberately rather than sharing one person's credential.
6. Obtain actual Zebra/phone/operator/printer acceptance and qualified DMP/finals/MARS mappings for the features being enabled. Unqualified automation stays visibly pending or human-assisted. Do not launch a partial feature as official DMP finals or automated MARS creation merely because its local extension boundary exists.

## Backup and restore before touching the operational database

Stop admission of new app/relay/device mutations during the final snapshot, including new offline captures that would later sync. Let current operations settle; record unresolved receipts and the selected source/dispatch versions. Inspect both durable label/DMP receipts and live relay/device queues. Aggregate SQL cannot see an unacknowledged browser queue or prove an upstream mutation completed. No queued/unknown print or MARS/DMP submission may be automatically replayed after restart.

Use PostgreSQL backup tools compatible with the server major version. Protect `PGSERVICEFILE`/`PGPASSFILE` and the backup directory; do not put a password/URL in arguments or output. A future operator can use a privately configured `temcotools_backup` service and a separately configured **empty isolated** `temcotools_restore` service:

```sh
umask 077
# Set backup_dir to a NEW protected path on the mounted authorized backup volume.
mkdir -m 700 "$backup_dir"
PGSERVICE=temcotools_backup pg_dump --format=custom --no-owner --no-privileges --file="$backup_dir/database.dump"
shasum -a 256 "$backup_dir/database.dump" > "$backup_dir/database.dump.sha256"
PGSERVICE=temcotools_restore pg_restore --no-owner --no-privileges --exit-on-error "$backup_dir/database.dump"
```

The restore service must select the new empty rehearsal database, never the original database. Do not use `--clean`, drop/reset the live database, or alter `_prisma_migrations` to hide a failure. Preserve original roles/grants separately when needed; `--no-owner --no-privileges` intentionally does not reproduce database ownership/security. Protect a copy of `runtime/admin-files`, required private configuration/key material, image/source digests and any external relay custody records. PostgreSQL alone does not back up uploaded files or browser/device queues. Verify restore table counts, migration history and representative full source/scan/submission/archive/label relationships; then rehearse enrollment and read-only smoke behavior. An archive existing on disk is not a verified restore.

## Apply, enroll, verify and open admission

After backup restoration is proven and the maintenance owner authorizes the actual target:

1. Keep admissions stopped. Run `v2-preflight --phase migrate` against that exact target with the operational guard, retaining its private report and migration listing. Investigate failed/checksum/unknown migrations first. Run the pinned migrator's `prisma migrate deploy` against the selected database; the actual composition/image must carry the intended schema/SQL. Do not use `migrate dev`, reset or schema push on production.
2. Re-run preflight. The normal migration seeds WMS identities/snapshots; backfill should usually be a no-op. Inspect its dry-run, then apply only if missing structures require it. Retain cursor/checkpoints privately; no raw data needs to enter the repository. Resolve conflicts through normal identity review, never order-only merges or alias resurrection.
3. Behind the maintenance boundary, use the exact existing legacy administrator with `--enroll-existing` (or `--create` for an actually empty installation). Preview first. Supply a private new delivery file on apply, with the maintenance owner/window in the reason. Privately deliver that one-use code to the named person. At `/signin/recovery` they set their own 15–256 character password/passphrase, then sign in and enroll an authenticator at `/account/security`. Manual secret/otpauth enrollment is supported; verify a current code and save the one-use recovery codes in that person's protected custody. Confirm a second-factor proof before user/role or payload publication actions.
4. The enrolled admin issues each active person's enrollment code through `/admin/users`, with recent password and MFA. Each person sets their own password and retains attribution. Privileged staff enroll MFA; ordinary floor work can use password login and per-device sessions. Confirm assisted reset/code delivery and the initial admin recovery route before public cutover. No PIN-only fallback or shared admin login.
5. Review bundle assignments with the owner. Test demotion/deactivation, individual session revocation, quick lock/switch and UI/MCP scope denial. New sensitive permissions are assigned deliberately. Refresh the legacy DMP connection and printer device under the correct person's current session; old sessions/grants/pairings must not regain access. A locked/expired session also ends delegated clients.
6. Run launch preflight, examine warnings and carry out the smoke list below. Record final DB/app/source versions, DMP-as-of and finals sign-off versions separately from physical observations. Open admission only after the accountable operator accepts the intended scope. Keep receipts and the pre-cutover backup; monitor current authorization errors, unresolved scans, queue age, unknown outcomes and first-day workflow results. Roll back feature admission or repair forward if a gate fails.

The existing [deploy.sh](../../scripts/deploy.sh) shortcut continues to require clean, published `main`; it cannot deploy this `v2` checkout. When a future separately approved release reaches main, the v2 guard additionally requires an explicit `TEMCO_V2_EXPECT_DATABASE` and an already prepared real managed-file directory. It builds revision-labeled app/migration/MCP images, then runs launch preflight through the MCP image **before** changing file permissions, applying SQL or restarting services. Pending SQL or unenrolled/unrecoverable accounts stop the shortcut. Use the maintenance procedure above for first cutover and future schema changes; do not bypass preflight to turn replacement of public PIN login into an unattended restart. The shortcut does not stop admissions, create a verified backup, deliver enrollment, prove live relay quiescence or grant deployment authority. After a qualified already-migrated release, it also restarts the opt-in MCP HTTP service; the separately approved proxy must route only the [listed public paths](mcp-runbook.md#configure-and-run).

In Docker Compose, set `TEMCO_PUBLIC_ORIGIN` to the exact approved HTTPS application origin, without path or trailing slash. App, DMP/label relay and default MCP issuer/resource URLs derive from it; explicit `MCP_ISSUER_URL`/`MCP_RESOURCE_URL` overrides must agree. Bare local Node processes instead need their explicit local `NEXT_PUBLIC_APP_URL` and MCP URLs. Do not carry development localhost overrides into an operational composition. A successful authenticator-envelope check proves key compatibility only; the person must still demonstrate real factor/recovery access and retain protected key custody.

## Smoke checks

For a local source build, run from MacDev with the disposable original test DB. Identity/OAuth tests enforce its exact synthetic name; never substitute production credentials. A production build is required before the HTTP/OAuth suites that launch Next:

```sh
dev-run -- npx prisma generate
dev-run -- npx tsc --noEmit
dev-run -- npx eslint scripts/v2-preflight*.ts scripts/v2-backfill.ts scripts/v2-bootstrap.ts scripts/v2-maintenance.test.ts scripts/bootstrap-admin.ts
dev-run -- env IDENTITY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/temcotools_v2_test npx tsx --test scripts/identity.integration.test.ts
dev-run -- env IDENTITY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/temcotools_v2_test npx tsx --test scripts/mfa.integration.test.ts
dev-run -- env IDENTITY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/temcotools_v2_test npx tsx --test scripts/oauth.integration.test.ts
```

The normal identity/session/MFA/OAuth tests use synthetic users and no real mail or upstream mutation. Consult their actual environment guards and [build status](build-status.md) for the latest complete workflow suite/build commands. Do not claim a skipped suite as a pass. The dedicated maintenance tests below require fresh isolated target databases, retain their synthetic evidence, and intentionally refuse rerunning over populated targets:

```sh
# Use UNUSED suffixes; existing targets/evidence are deliberately refused.
temco_upgrade_db=temcotools_v2_upgrade_new_test
temco_recovery_db=temcotools_v2_recovery_new_test
temco_restore_db=temcotools_v2_roundtrip_new_test
temco_restore_evidence=/Volumes/MacDev/ProjectArchive/Development/Qualification/NEW-synthetic-restore-directory
docker exec temcotools-v2-build-db createdb -U postgres "$temco_upgrade_db"
dev-run -- env MAINTENANCE_UPGRADE_DATABASE_NAME="$temco_upgrade_db" MAINTENANCE_UPGRADE_DATABASE_URL="postgresql://postgres@127.0.0.1:55439/$temco_upgrade_db" npx tsx --test scripts/v2-preflight-upgrade.test.ts
# Backup/restore the populated upgraded fixture into a NEW destination.
dev-run -- bash scripts/v2-preflight-restore-test.sh "$temco_restore_evidence" "$temco_restore_db" "$temco_upgrade_db"
dev-run -- env MAINTENANCE_RESTORE_DATABASE_NAME="$temco_restore_db" MAINTENANCE_RESTORE_DATABASE_URL="postgresql://postgres@127.0.0.1:55439/$temco_restore_db" npx tsx --test scripts/v2-preflight-upgrade.test.ts
# Separately renew the fresh bootstrap/backfill/recovery path.
docker exec temcotools-v2-build-db createdb -U postgres "$temco_recovery_db"
dev-run -- env DATABASE_URL="postgresql://postgres@127.0.0.1:55439/$temco_recovery_db" npx prisma migrate deploy
dev-run -- env MAINTENANCE_TEST_DATABASE_NAME="$temco_recovery_db" MAINTENANCE_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55439/$temco_recovery_db" npx tsx --test scripts/v2-maintenance.test.ts
```

Operational smoke uses the intended phone/Zebra and ordinary phone: sign-in/enrollment/MFA/recovery; admin revoke/demote; global LPN lookup showing reported state separately from observed state; buffered duplicate scan/reconnect; existing pick/wave/import exports; alias correction denial; lane/move evidence without false destination credit; office A/B missed-exchange case; authorized label preview/queue/uncertain receipt/reprint; admin payload draft/diff/publish/rollback/loader; scoped MCP consent/query/denial/revocation. Actual print, scanner/OCR, live DMP mapping, official finals and MARS mutation each require their own authorized qualification; local synthetic results do not establish those outcomes.

## Recovery and rollback boundaries

| Situation | Safe next step |
| --- | --- |
| Failure before migration/real effects | Keep the original operational database and binaries; preserve diagnostics and stopped admissions. Correct the source/configuration or defer the window. |
| Additive migration applied, no operational writes yet | Prefer forward repair while admission stays stopped. A restore to a separate database can recover the pre-window state; verify it before selecting it. Never delete the migrated database/evidence merely to make a branch look rolled back. |
| New credentials, aliases, dispositions, finals or physical/external effects already exist | Reverting the app branch does not undo them. V1 lacks the strong-session/capability checks and would reopen PIN risk; new users have disabled PIN hashes. A v1 binary rollback is not a safe authentication rollback. Keep v2 access controls and repair/disable the affected workflow. A snapshot restore can lose post-snapshot facts or resurrect consumed authority; reconcile those facts/receipts before resuming. |
| Unknown print/MARS/DMP result | Preserve the original intent and receipt. Inspect upstream/physical outcome and reconcile through the authorized workflow. Do not resend because a browser, network response or restored database looks incomplete. |

After restoring a v2 snapshot, keep app/relay/device admission stopped and invalidate restored authority **before** reopening it:

```sh
# DATABASE_URL must explicitly select the restored database, with its exact name.
dev-run -- npx tsx scripts/v2-backfill.ts --expect-database temcotools_v2_recovery_test --invalidate-restored-access
dev-run -- npx tsx scripts/v2-backfill.ts --expect-database temcotools_v2_recovery_test --invalidate-restored-access --apply --reason 'Synthetic database restore access invalidation'
```

The invalidation step does not reconstruct security decisions made after the snapshot: a later deactivation, role/password change, factor replacement or revocation can be absent from the backup. Reconcile the retained security audit/current access roster before reopening admission; require fresh assisted recovery where credential history cannot be established. Incrementing a generation does not invalidate the restored password hash.

This increments user access generations, revokes persistent sessions, opaque client/OAuth grants and printing devices, and consumes pending password/setup codes and MFA recovery codes. It retains password hashes, encrypted authenticator secrets, all consumed-code rows and warehouse/external evidence. People sign in again; clients/devices reauthorize. Working authenticators remain usable with the restored independent MFA key. Regenerate recovery codes using the real authenticator; a code consumed after the snapshot must not become usable again. On an actual operational target the separate operational-target flag and launch/recovery authority are required. This is intentionally a different operation from inventory backfill.

For staff who lose both authenticator and recovery codes, `/admin/users` provides **Recover lost authenticator** through the shared assisted-factor command. It requires current `users.manage`, recent password/MFA, authority covering the target's capabilities and another usable administrator when resetting an administrator. Its exact-target one-use code revokes the old password/factor/sessions/clients; the person chooses a new password and enrolls a new authenticator. A normal password-only reset retains MFA. No email is automatically sent, and identity verification/private delivery remain the responsible administrator's work.

If the last usable system administrator has lost every factor, authenticated factor removal/reset deliberately refuses to strand recovery. The separately gated offline host-maintenance mode is the concrete last resort:

```sh
# Preview using the exact enrolled active administrator username.
dev-run -- npx tsx scripts/v2-bootstrap.ts --expect-database temcotools_v2_recovery_test --username SYNTHETIC_ADMIN --recover-enrolled-admin
# Future real use requires explicit owner recovery authority, stopped admission,
# a verified protected backup, and the exact operational target guard.
dev-run -- npx tsx scripts/v2-bootstrap.ts --expect-database temcotools_v2_recovery_test --username SYNTHETIC_ADMIN --recover-enrolled-admin --apply --reason 'Synthetic owner-authorized lost-factor recovery' --delivery-file "$private_delivery_dir/new-recovery-code"
```

It accepts only an already enrolled active `admin` with existing `users.manage` (or its recorded interrupted offline recovery), does not promote/reactivate or broaden bundles, clears the old password, disables the old authenticator, revokes that account's sessions/grants/devices and consumes its old recovery codes. A lost/expired delivery can be deliberately reissued with a new private file and reason; the prior code becomes invalid, and no permission bundle is expanded. The encrypted old authenticator secret remains in the disabled record until genuine new enrollment replaces it; preserve the protected backup. The target ID and explicit offline reason are audited; this is attributed host-maintenance context, not an impersonated application session. A private one-use 30-minute reset code lets the named person set a new password and enroll a new authenticator through the human UI. Complete MFA/custody before privileged work. No public endpoint, agent token or MCP tool can self-approve this host recovery operation. No real account recovery was exercised in this build.

## Latest qualification

Renewed against all **30 migrations** through `20261101170000`, using the `v2` source at code checkpoint `8c65740a66e5755391c49be3c3a85079b744ca46` (documentation checkpoint `b2f1f8c`) plus the maintenance-test changes. The labeled task-owned PostgreSQL 16 container remains `temcotools-v2-build-db`, loopback port 55439; the running pinned MCP service was not changed or used as a test target.

- Fresh `temcotools_v2_upgrade_30_test`: applied the 12 actual published-v1 SQL files from `fea1f22`, retained synthetic account/PIN-hash/favorite, archived delivered WMS revision 7/full extras, scan time, MARS submission and printer/template fixtures, then applied all 30 SQL files with exact checksum/no-pending/no-failed checks. No old source revisions, MARS batch rows, import membership, notes or physical sightings were invented. Shared commands then enrolled the retained admin, exercised real synthetic TOTP, and populated new note revisions, immutable MARS source/audit/report/void history, an uncertain human MARS intent and an unsent queued label. No upstream or printer request ran.
- Custom-format dump restored into fresh `temcotools_v2_roundtrip_30_test`: all **79 public tables** matched inventory, counts and deterministic row-data fingerprints, including composite-key tables and the populated new custody tables. Both restored source-row/note-revision UPDATE guards actually rejected rewriting. These comparisons precede the deliberate access invalidation/new sign-in below; its security-table changes are expected, while operational ledgers stayed identical. Backup/SHA-256/comparisons/guard diagnostics: `/Volumes/MacDev/ProjectArchive/Development/Qualification/temcotools-v2-populated-restore-30-20261031`. No existing database was overwritten or dropped.
- The populated post-restore check proved the preserved MFA key decrypts its original envelope, a wrong key fails closed, and access invalidation rejects the copied session, revokes copied client/device authority and consumes restored recovery codes. Source rows, note revisions, shared observations, unknown MARS work and queued print receipts remained unchanged. A fresh password sign-in created a new session with **no automatic MFA proof**. Separately, six fresh bootstrap/backfill/recovery tests passed on `temcotools_v2_recovery_30_test`, including one-use enrollment, exact target guards, idempotent repair, immutable-conflict refusal and explicit interrupted offline-admin recovery/reissue.
- `dev-run` receipts under `/Volumes/MacDev/ProjectArchive/Development/MigrationReceipts/maintenance/`: upgrade `20261031-235641-build-98563.json`; all-table restore `20261031-235732-build-98954.json`; populated post-restore invalidation/key check `20261031-235857-build-99517.json`; fresh recovery suite `20261031-235720-build-98953.json`; full TypeScript `20261101-000448-build-1652.json`; scoped lint `20261101-000443-build-1653.json`. Existing restore-target refusal also passed before any archive/database mutation (`20261101-000614-build-2322.json`). Upgrade and post-restore are separate modes in one file; each mode's other test is intentionally skipped and is not counted as a pass. Earlier 25/27-migration fixtures and backups remain preserved under their original names.

These are local synthetic database/source qualification results. They do not establish production volume, production backup/key/volume custody, actual email delivery, real hardware/operator acceptance or upstream correctness. DMP qualification questions are parked under the owner's current steering. The integrated [build status](build-status.md) tracks the usable MCP endpoint and remaining implementation/launch gates; no production deployment or live operational effect is authorized by these checks.

Follow-on cutover guards were checked on fresh `temcotools_v2_recovery_guard_test` with all30 migrations (`20261101-010701-build-21501.json`). The native recovery/readiness suite passed8 checks (`20261101-010725-build-21598.json`), including correct-key readiness, wrong-key launch denial without exposing/changing factor custody, and prepared/in-progress/unknown MARS distinctions without any external request. Scoped lint and shell syntax passed (`20261101-010724-build-21600.json`). Structured Compose rendering with synthetic values verified one alternate origin reaches app, both relays and MCP issuer/resource, and the selected revision reaches MCP build arguments (`20261101-005431-build-18972.json`). No deployment script or operational composition was executed; these checks do not qualify a real proxy, service restart or account's factor possession.
