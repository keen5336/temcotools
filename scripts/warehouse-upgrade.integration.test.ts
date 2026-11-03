import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
const url = process.env.WAREHOUSE_UPGRADE_TEST_DATABASE_URL;
test("published 31-migration identity upgrades without changing credentials, factors, sessions or grants", { skip: !url }, async () => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.match(target.pathname, /^\/temcotools_v2_site_upgrade(?:_[a-z0-9]+)?_test$/);
  const pool = new pg.Pool({ connectionString: url });
  const scratch = await mkdtemp(join(tmpdir(), "warehouse-upgrade-")), root = process.cwd();
  const baseline = join(scratch, "migrations"); await mkdir(baseline);
  const allMigrations = (await readdir(join(root, "prisma/migrations"))).filter(n => /^\d/.test(n));
  const names = allMigrations.filter(n => n < "20261103"); assert.equal(names.length, 31);
  for (const name of names) { await mkdir(join(baseline, name)); await copyFile(join(root, "prisma/migrations", name, "migration.sql"), join(baseline, name, "migration.sql")); }
  await copyFile(join(root, "prisma/migrations/migration_lock.toml"), join(baseline, "migration_lock.toml"));
  const config = join(scratch, "prisma.config.mjs");
  await writeFile(config, `export default ${JSON.stringify({ schema: resolve(root, "prisma/schema.prisma"), migrations: { path: baseline } })};`);
  // URL belongs solely to the child environment, never the argument list/log.
  await writeFile(config, `const c=${JSON.stringify({ schema: resolve(root, "prisma/schema.prisma"), migrations: { path: baseline } })};c.datasource={url:process.env.DATABASE_URL};export default c;`);
  const migrate = (args: string[]) => execFileSync(process.execPath, [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", ...args], { env: { ...process.env, DATABASE_URL: url! }, stdio: "pipe", timeout: 90_000 });
  try {
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, "Refuse a populated target; never reset an existing test database.");
    migrate(["--config", config]);
    await pool.query(`INSERT INTO "User"(id,username,"displayName","pinHash","passwordHash",role,"authVersion","updatedAt") VALUES('synthetic-adam','adam','Synthetic owner','disabled:v2','synthetic-preserved-password-envelope','admin',7,now()),('synthetic-local','local','Synthetic manager','disabled:v2',null,'admin',1,now())`);
    await pool.query(`INSERT INTO "UserSession"(id,"userId","authVersion","expiresAt","deviceLabel") VALUES('synthetic-preserved-session','synthetic-adam',7,now()+interval '1 hour','Synthetic scanner')`);
    await pool.query(`INSERT INTO "UserMfa"("userId","encryptedSecret","enrollmentSessionId","enabledAt") VALUES('synthetic-adam','synthetic-preserved-encrypted-envelope','synthetic-preserved-session',now())`);
    await pool.query(`INSERT INTO "MfaRecoveryCode"(id,"userId","codeHash") VALUES('synthetic-preserved-recovery','synthetic-adam','synthetic-preserved-recovery-hash')`);
    await pool.query(`INSERT INTO "AppAccessGrant"(id,"userId","sessionId","authVersion","clientName","tokenHash",scopes,"expiresAt") VALUES('synthetic-preserved-grant','synthetic-adam','synthetic-preserved-session',7,'Synthetic client','synthetic-preserved-token-hash',ARRAY['workflow.read'],now()+interval '1 hour')`);
    await pool.query(`INSERT INTO "WarehouseUnit"(id,"createdByUserId","creationEvidence","creationFingerprint") VALUES('synthetic-preserved-unit','synthetic-adam','Synthetic private origin evidence','synthetic-private-idempotency')`);
    await pool.query(`INSERT INTO "WarehouseIdentifier"(id,"unitId",kind,namespace,value,"rawValue",evidence,"createdByUserId") VALUES('synthetic-preserved-alias','synthetic-preserved-unit','lpn','wms','SYNTHETIC-UPGRADE-LPN','SYNTHETIC-UPGRADE-LPN','Synthetic private alias evidence','synthetic-adam')`);
    await pool.query(`INSERT INTO "WarehousePhysicalObservation"(id,"userId","eventId",fingerprint,"rawIdentifier","identifierType",type,"captureMethod","capturedAt","unitId",resolution,"candidateUnitIds") VALUES('synthetic-preserved-observation','synthetic-adam','synthetic-upgrade-event','synthetic-upgrade-fingerprint','SYNTHETIC-UPGRADE-LPN','lpn','presence','manual',now(),'synthetic-preserved-unit','resolved','["synthetic-preserved-unit"]'::jsonb)`);
    const snapshot = async () => {
      const data: Record<string, unknown[]> = {};
      for (const [table, fields] of Object.entries({ User: 'id,username,"passwordHash","passwordChangedAt","pinHash",role,"isActive","authVersion"', UserSession: 'id,"userId","authVersion","createdAt","lastActivityAt","lastStrongAuthenticatedAt","mfaVerifiedAt","expiresAt","revokedAt","lockedAt"', UserMfa: '*', MfaRecoveryCode: '*', AppAccessGrant: 'id,"userId","sessionId","authVersion","clientName","tokenHash",scopes,"expiresAt","revokedAt"' })) data[table] = (await pool.query(`SELECT ${fields} FROM "${table}" ORDER BY 1`)).rows;
      return data;
    };
    const before = await snapshot(); migrate([]); assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await pool.query('SELECT username,"isPlatformAdmin" FROM "User" ORDER BY username')).rows, [{ username: "adam", isPlatformAdmin: true }, { username: "local", isPlatformAdmin: false }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "WarehouseMembership"')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].n, allMigrations.length);
    assert.deepEqual((await pool.query('SELECT id,"creationEvidence","creationFingerprint","createdByUserId" FROM "WarehouseUnit" WHERE id=\'synthetic-preserved-unit\'')).rows, [{ id: "synthetic-preserved-unit", creationEvidence: null, creationFingerprint: null, createdByUserId: null }]);
    assert.deepEqual((await pool.query('SELECT "unitId","creationEvidence","creationFingerprint","createdByUserId" FROM "WarehouseUnitOrigin" WHERE "unitId"=\'synthetic-preserved-unit\'')).rows, [{ unitId: "synthetic-preserved-unit", creationEvidence: "Synthetic private origin evidence", creationFingerprint: "synthetic-private-idempotency", createdByUserId: "synthetic-adam" }]);
    const participation = (await pool.query('SELECT phase,"holdsCustody" FROM "WarehouseUnitSite" WHERE "unitId"=\'synthetic-preserved-unit\'')).rows;
    assert.deepEqual(participation, [{ phase: "unestablished", holdsCustody: false }], "Backfill preserves observations without manufacturing a current physical custodian.");
    assert.equal((await pool.query('SELECT value FROM "WarehouseUnitAlias" WHERE id=\'synthetic-preserved-alias\'')).rows[0].value, "SYNTHETIC-UPGRADE-LPN");
    assert.equal((await pool.query('SELECT evidence FROM "WarehouseIdentifier" WHERE id=\'synthetic-preserved-alias\'')).rows[0].evidence, "Synthetic private alias evidence");
  } finally { await pool.end(); }
});
