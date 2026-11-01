import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export class MaintenanceError extends Error {}
export type Target = { url: string; database: string; operational: boolean };

/** No dotenv import: selecting a maintenance target is always explicit. */
export function maintenanceTarget(expected: string | undefined, allowOperational = false, url = process.env.DATABASE_URL): Target {
  if (!expected || !/^[A-Za-z0-9_]{1,63}$/.test(expected)) throw new MaintenanceError("Supply --expect-database with the exact database name.");
  let parsed: URL;
  try { parsed = new URL(url ?? ""); } catch { throw new MaintenanceError("Set an explicit PostgreSQL DATABASE_URL through the protected process environment."); }
  if (!["postgresql:", "postgres:"].includes(parsed.protocol) || decodeURIComponent(parsed.pathname.slice(1)) !== expected) throw new MaintenanceError("DATABASE_URL does not match the explicit expected PostgreSQL database.");
  const synthetic = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && /_test$/.test(expected) && !parsed.search;
  if (!synthetic && !allowOperational) throw new MaintenanceError("The default guard permits only a loopback database ending in _test. An authorized operational run additionally requires --allow-operational-target.");
  return { url: parsed.toString(), database: expected, operational: !synthetic };
}

export function maintenanceClient(target: Target) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: target.url }) });
}

export function maintenanceReason(reason?: string) {
  const value = reason?.trim() ?? "";
  if (value.length < 10 || value.length > 300 || /[\r\n\x00-\x1f]/.test(value)) throw new MaintenanceError("Supply --reason with 10 to 300 characters of nonsecret maintenance context.");
  return value;
}

export async function tableExists(tx: Prisma.TransactionClient, name: string) {
  const rows = await tx.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.' || quote_ident(${name})) IS NOT NULL AS present`;
  return rows[0].present;
}

export async function hasColumn(tx: Prisma.TransactionClient, table: string, column: string) {
  const rows = await tx.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${column}) AS present`;
  return rows[0].present;
}

export async function migrationState(tx: Prisma.TransactionClient, root = process.cwd()) {
  const directories = (await readdir(resolve(root, "prisma/migrations"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const files = await Promise.all(directories.map(async (name) => ({ name, hash: createHash("sha256").update(await readFile(resolve(root, "prisma/migrations", name, "migration.sql"))).digest("hex") })));
  const applied = await tableExists(tx, "_prisma_migrations") ? await tx.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations"` : [];
  const completed = applied.filter((row) => row.finished_at && !row.rolled_back_at);
  return {
    localCount: files.length, appliedCount: completed.length,
    pending: files.filter((file) => !completed.some((row) => row.migration_name === file.name)).map((file) => file.name),
    failed: applied.filter((row) => !row.finished_at && !row.rolled_back_at).map((row) => row.migration_name),
    checksumMismatch: completed.filter((row) => files.find((file) => file.name === row.migration_name)?.hash !== row.checksum).map((row) => row.migration_name),
    unknownApplied: completed.filter((row) => !files.some((file) => file.name === row.migration_name)).map((row) => row.migration_name),
  };
}

/** Counts only. No raw source rows, identifiers, credential material or customer fields leave the database. */
export async function inventoryRepairCounts(tx: Prisma.TransactionClient) {
  const [rows] = await tx.$queryRaw<Record<string, bigint>[]>`
    SELECT count(*) AS rows,
      count(*) FILTER (WHERE i."unitId" IS NULL) AS "missingUnits",
      count(*) FILTER (WHERE r.id IS NULL) AS "missingCurrentRevisions",
      count(*) FILTER (WHERE r.id IS NOT NULL AND (r."contentHash",r."sourceData",r.lpn,r.status,r."receivedDate",r."orderNumber",r.vendor,r.description,r."customerName") IS DISTINCT FROM (i."contentHash",i."sourceData",i.lpn,i.status,i."receivedDate",i."orderNumber",i.vendor,i.description,i."customerName")) AS "conflictingCurrentRevisions",
      count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn)) AS "missingAliases",
      count(*) FILTER (WHERE EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn AND a."revokedAt" IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn AND a."revokedAt" IS NULL)) AS "revokedAliasesPreserved",
      count(*) FILTER (WHERE EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a.kind='lpn' AND a.namespace='wms' AND upper(btrim(a.value))=upper(btrim(i.lpn)) AND a."unitId" IS DISTINCT FROM coalesce(i."unitId",'wms-unit:'||i.id) AND a."revokedAt" IS NULL)) AS "conflictingAliases",
      count(*) FILTER (WHERE i.lpn='' OR i.lpn IS DISTINCT FROM upper(btrim(i.lpn))) AS "noncanonicalLpns"
    FROM "InventoryAuditItem" i LEFT JOIN "InventorySourceRevision" r ON r."inventoryItemId"=i.id AND r.revision=i.revision`;
  const [duplicates] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM (SELECT upper(btrim(lpn)) FROM "InventoryAuditItem" GROUP BY upper(btrim(lpn)) HAVING count(*)>1) d`;
  return { ...Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, Number(value)])), duplicateNormalizedLpns: Number(duplicates.count) } as {
    rows: number; missingUnits: number; missingCurrentRevisions: number; conflictingCurrentRevisions: number; missingAliases: number; revokedAliasesPreserved: number; conflictingAliases: number; noncanonicalLpns: number; duplicateNormalizedLpns: number;
  };
}

export function printMaintenance(value: unknown) { console.log(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2)); }
export function maintenanceFailure(error: unknown) {
  // Prisma/driver errors may contain statements or connection details. Never dump them.
  console.error(error instanceof MaintenanceError ? error.message : "Maintenance failed. Check the selected database, schema and protected diagnostics; no database or credential details are printed.");
  process.exitCode = 1;
}
