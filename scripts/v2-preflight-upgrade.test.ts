import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { maintenanceClient, maintenanceTarget, tableExists } from "./v2-preflight-support";
import { inspectV2Readiness } from "./v2-preflight";
import { backfillV2Inventory } from "./v2-backfill";
import { bootstrapV2Administrator } from "./v2-bootstrap";

const testUrl = process.env.MAINTENANCE_UPGRADE_DATABASE_URL;
test("published v1 migrations and retained fixtures upgrade additively to the qualified v2 migration set", { skip: !testUrl }, async () => {
  const target = maintenanceTarget("temcotools_v2_upgrade_test", false, testUrl);
  const prisma = maintenanceClient(target);
  const root = process.cwd();
  const scratch = await mkdtemp(join(tmpdir(), "temco-upgrade-"));
  const baseline = join(scratch, "v1"), upgraded = join(scratch, "v2");
  const cutoff = process.env.MAINTENANCE_MIGRATION_CUTOFF ?? "20261101140000";
  assert.match(cutoff, /^\d{14}$/);
  const baselineRef = "fea1f22af1b2fae788388f2aefed3e3998e98d09";
  async function configFor(directory: string) {
    const config = join(directory, "prisma.config.mjs");
    // Configure the URL through process environment, never source or stdout.
    await writeFile(config, `const config = ${JSON.stringify({ schema: resolve(root, "prisma/schema.prisma"), migrations: { path: join(directory, "migrations") } })};\nconfig.datasource = {url:process.env.DATABASE_URL};\nexport default config;\n`, "utf8");
    return config;
  }
  function migrate(config: string) {
    execFileSync(process.execPath, [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config], { cwd: root, env: { ...process.env, DATABASE_URL: target.url }, stdio: "pipe", timeout: 90_000 });
  }
  try {
    assert.equal(await prisma.$transaction(tx => tableExists(tx, "User")), false, "Refusing a nonempty upgrade database.");
    await mkdir(join(baseline, "migrations"), { recursive: true }); await mkdir(join(upgraded, "migrations"), { recursive: true });
    const legacyNames = execFileSync("git", ["ls-tree", "--name-only", `${baselineRef}:prisma/migrations`], { encoding: "utf8" }).trim().split("\n").filter(name => name !== "migration_lock.toml");
    assert.equal(legacyNames.length, 12);
    for (const name of legacyNames) {
      await mkdir(join(baseline, "migrations", name));
      await writeFile(join(baseline, "migrations", name, "migration.sql"), execFileSync("git", ["show", `${baselineRef}:prisma/migrations/${name}/migration.sql`], { encoding: "utf8" }));
    }
    await copyFile(resolve(root, "prisma/migrations/migration_lock.toml"), join(baseline, "migrations/migration_lock.toml"));
    const currentNames = (await readdir(resolve(root, "prisma/migrations"), { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.slice(0, 14) <= cutoff).map(entry => entry.name).sort();
    for (const name of currentNames) { await mkdir(join(upgraded, "migrations", name)); await copyFile(resolve(root, "prisma/migrations", name, "migration.sql"), join(upgraded, "migrations", name, "migration.sql")); }
    await copyFile(resolve(root, "prisma/migrations/migration_lock.toml"), join(upgraded, "migrations/migration_lock.toml"));
    migrate(await configFor(baseline));
    const [v1Count] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`; assert.equal(Number(v1Count.count), 12);
    await prisma.$executeRaw`INSERT INTO "User" (id,username,"displayName","pinHash",role,"updatedAt","favoriteToolIds") VALUES ('synthetic-v1-admin','synthetic-v1-admin','Synthetic retained administrator','retained-synthetic-pin-hash','admin'::"Role",CURRENT_TIMESTAMP,ARRAY['inventory-audit'])`;
    await prisma.$executeRaw`INSERT INTO "User" (id,username,"displayName","pinHash",role,"updatedAt") VALUES ('synthetic-v1-manager','synthetic-v1-manager','Synthetic retained manager','retained-synthetic-manager-pin','manager'::"Role",CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditItem" (id,lpn,status,"orderNumber",vendor,"receivedDate",description,"customerName","sourceData","contentHash",revision,"verifiedAt","lastScannedAt","archivedAt") VALUES ('synthetic-v1-item','SYNTHETIC-V1-LPN','Delivered','SYNTHETIC-ORDER','Synthetic vendor','2026-10-01','Synthetic retained appliance','Synthetic recipient','{"syntheticExtraColumn":"retained"}'::jsonb,'synthetic-v1-content',7,'2026-10-22T11:00:00Z','2026-10-22T11:00:00Z','2026-10-23T12:00:00Z')`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditImport" (id,filename,"uploadedByName","rowCount","insertedCount","changedCount","unchangedCount","duplicateCount","blankCount") VALUES ('synthetic-v1-import','synthetic-v1.xlsx','Synthetic operator',1,1,0,0,0,0)`;
    await prisma.$executeRaw`INSERT INTO "InventoryAuditScan" (id,"sourceScanId","pickWaveId","pickWaveName","scannedValue",lpn,"matchedPickWave","duplicateInWave","scannedAt") VALUES ('synthetic-v1-scan','synthetic-v1-source-scan','synthetic-v1-wave','Synthetic retained wave','SYNTHETIC-V1-LPN','SYNTHETIC-V1-LPN',false,false,'2026-10-22T11:00:00Z')`;
    await prisma.$executeRaw`INSERT INTO "MarsUnit" (id,"requestNumber","orderNumber","serialNumber","requestStatus","updatedAt") VALUES ('synthetic-v1-mars','SYNTHETIC-SUBMISSION','SYNTHETIC-ORDER','SYNTHETIC-SERIAL','Pending',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "LabelPrinter" (id,name,endpoint,"updatedAt") VALUES ('synthetic-v1-printer','Synthetic retained printer','https://printer.invalid/print',CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`INSERT INTO "LabelTemplate" (id,name,kind,zpl,"isDefault","updatedAt") VALUES ('synthetic-v1-template','Synthetic retained template','pick_wave'::"LabelTemplateKind",'^XA^FDSynthetic label^FS^XZ',true,CURRENT_TIMESTAMP)`;
    const before = await inspectV2Readiness(prisma); assert.equal(before.identity, null); assert.equal(before.inventory, null); assert.equal(before.migrations.checksumMismatch.length, 0);
    migrate(await configFor(upgraded));
    const state = await inspectV2Readiness(prisma);
    assert.equal(state.migrations.appliedCount, currentNames.length); assert.equal(state.migrations.checksumMismatch.length, 0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: "synthetic-v1-admin" } });
    assert.equal(user.passwordHash, null); assert.equal(user.pinHash, "retained-synthetic-pin-hash"); assert.deepEqual(user.favoriteToolIds, ["inventory-audit"]);
    const manager = await prisma.userRoleBundle.findMany({ where: { userId: "synthetic-v1-manager" }, include: { bundle: true } });
    assert.ok(manager.some(item => item.bundleId === "legacy-manager")); assert.ok(manager.every(item => !item.bundle.capabilities.includes("inventory.identify")));
    const item = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: "synthetic-v1-item" } });
    assert.equal(item.unitId, "wms-unit:synthetic-v1-item"); assert.equal(item.revision, 7); assert.ok(item.archivedAt); assert.ok(item.verifiedAt);
    const source = await prisma.inventorySourceRevision.findUniqueOrThrow({ where: { inventoryItemId_revision: { inventoryItemId: item.id, revision: 7 } } });
    assert.deepEqual(source.sourceData, { syntheticExtraColumn: "retained" }); assert.equal(source.migrationSnapshot, true);
    assert.equal(await prisma.inventorySourceRevision.count(), 1, "Older overwritten revisions cannot be invented.");
    assert.equal(await prisma.inventoryImportMembership.count(), 0, "Legacy reports have no fabricated complete membership.");
    assert.equal(await prisma.warehousePhysicalObservation.count(), 0, "Reported stock and legacy scans do not become invented v2 presence.");
    assert.equal(await prisma.inventoryAuditScan.count(), 1); assert.equal(await prisma.marsUnit.count(), 1); assert.equal(await prisma.labelPrinter.count(), 1); assert.equal(await prisma.labelTemplate.count(), 1);
    assert.equal((await prisma.inventoryAuditScan.findUniqueOrThrow({ where: { id: "synthetic-v1-scan" } })).scannedAt.toISOString(), "2026-10-22T11:00:00.000Z");
    assert.equal((await backfillV2Inventory(prisma, { apply: false })).before.missingUnits, 0);
    const dry = await bootstrapV2Administrator(prisma, { username: user.username, create: false, enrollExisting: true, apply: false }); assert.equal(dry.mode, "dry-run");
    const applied = await bootstrapV2Administrator(prisma, { username: user.username, create: false, enrollExisting: true, apply: true, reason: "Synthetic v1 upgrade owner-assisted initial enrollment", deliveryFile: join(scratch, "legacy-admin-enrollment") }); assert.equal(applied.mode, "applied");
    const retained = await prisma.user.findUniqueOrThrow({ where: { id: user.id } }); assert.equal(retained.id, user.id); assert.equal(retained.pinHash, user.pinHash); assert.equal(retained.passwordHash, null);
    assert.equal(await prisma.identityRecoveryToken.count({ where: { userId: user.id, consumedAt: null } }), 1);
  } finally { await prisma.$disconnect(); }
});
