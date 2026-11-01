import { parseArgs } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import { retainCurrentSourceRevisions } from "../lib/warehouse/source-history";
import { inventoryRepairCounts, maintenanceClient, maintenanceFailure, maintenanceReason, maintenanceTarget, printMaintenance, MaintenanceError } from "./v2-preflight-support";

export async function backfillV2Inventory(prisma: PrismaClient, options: { apply: boolean; reason?: string; limit?: number; after?: string }) {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new MaintenanceError("--limit must be 1 to 5000 rows.");
  if (options.apply) maintenanceReason(options.reason);
  return prisma.$transaction(async (tx) => {
    if (!options.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(8100801)`;
    const before = await inventoryRepairCounts(tx);
    if (before.conflictingCurrentRevisions) throw new MaintenanceError("Current source history conflicts with retained immutable revisions. No repair was attempted; investigate without replacing history.");
    const rows = await tx.inventoryAuditItem.findMany({ where: options.after ? { id: { gt: options.after } } : undefined, select: { id: true, lpn: true }, orderBy: { id: "asc" }, take: limit + 1 });
    const batch = rows.slice(0, limit), lpns = batch.map((row) => row.lpn);
    if (options.apply && lpns.length) {
      const collisions = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM "InventoryAuditItem" i JOIN "WarehouseUnit" u ON u.id='wms-unit:'||i.id
        WHERE i.lpn IN (${Prisma.join(lpns)}) AND i."unitId" IS NULL
          AND EXISTS(SELECT 1 FROM "InventoryAuditItem" other WHERE other."unitId"=u.id AND other.id<>i.id)`;
      if (collisions[0].count > BigInt(0)) throw new MaintenanceError("A deterministic unit identity is attached to another source row. Resolve the identity conflict before repair.");
      await tx.$executeRaw`
        INSERT INTO "WarehouseUnit" (id,"creationEvidence") SELECT 'wms-unit:'||id,'Retained WMS identity baseline; not physical presence.' FROM "InventoryAuditItem"
        WHERE lpn IN (${Prisma.join(lpns)}) AND "unitId" IS NULL ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`UPDATE "InventoryAuditItem" SET "unitId"='wms-unit:'||id WHERE lpn IN (${Prisma.join(lpns)}) AND "unitId" IS NULL`;
      await retainCurrentSourceRevisions(tx, lpns);
      await tx.$executeRaw`
        INSERT INTO "WarehouseIdentifier" (id,"unitId",kind,namespace,value,"rawValue",evidence)
        SELECT 'wms-lpn:'||i.id,i."unitId",'lpn','wms',i.lpn,i.lpn,'Retained WMS LPN baseline repair; not physical presence.'
        FROM "InventoryAuditItem" i WHERE i.lpn IN (${Prisma.join(lpns)}) AND i.lpn<>'' AND i.lpn=upper(btrim(i.lpn))
          AND NOT EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn)
          AND NOT EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a.kind='lpn' AND a.namespace='wms' AND upper(btrim(a.value))=i.lpn AND a."unitId"<>i."unitId" AND a."revokedAt" IS NULL)
          AND NOT EXISTS(SELECT 1 FROM "InventoryAuditItem" other WHERE upper(btrim(other.lpn))=i.lpn AND other.id<>i.id)
        ON CONFLICT DO NOTHING`;
      await tx.identityAudit.create({ data: { action: "v2_inventory_baseline_repaired", reason: `Offline maintenance: ${options.reason}; examined ${batch.length} rows. Existing links, revoked aliases and evidence preserved.` } });
    }
    return { mode: options.apply ? "applied" : "dry-run", examinedRows: batch.length, hasMore: rows.length > limit, nextCursor: rows.length > limit ? batch.at(-1)!.id : null, before, after: options.apply ? await inventoryRepairCounts(tx) : before, limits: ["Only missing WMS unit baselines, current-row snapshots and safe LPN aliases are repaired.", "Revoked/conflicting aliases, existing unit links, overwritten source history, historical import membership and physical observations are never reconstructed.", "Re-running a completed page is safe; nextCursor is an internal source-row ID, not an LPN."] };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
}

/** Restored snapshots must not make old sessions, client tokens or setup codes valid again. */
export async function invalidateRestoredAccess(prisma: PrismaClient, options: { apply: boolean; reason?: string }) {
  if (options.apply) maintenanceReason(options.reason);
  return prisma.$transaction(async (tx) => {
    if (!options.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110103)`;
    const pending = {
      users: await tx.user.count(), sessions: await tx.userSession.count({ where: { revokedAt: null } }),
      clientGrants: await tx.appAccessGrant.count({ where: { revokedAt: null } }), oauthGrants: await tx.oAuthGrant.count({ where: { revokedAt: null } }),
      printingDevices: await tx.printingDevice.count({ where: { revokedAt: null } }), recoveryCodes: await tx.identityRecoveryToken.count({ where: { consumedAt: null } }), mfaRecoveryCodes: await tx.mfaRecoveryCode.count({ where: { consumedAt: null } }),
    };
    if (options.apply) {
      const at = new Date();
      await tx.user.updateMany({ data: { authVersion: { increment: 1 } } });
      await tx.userSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: at } });
      await tx.appAccessGrant.updateMany({ where: { revokedAt: null }, data: { revokedAt: at } });
      await tx.oAuthGrant.updateMany({ where: { revokedAt: null }, data: { revokedAt: at, revokedReason: "Restored database recovery invalidation." } });
      await tx.printingDevice.updateMany({ where: { revokedAt: null }, data: { revokedAt: at } });
      await tx.identityRecoveryToken.updateMany({ where: { consumedAt: null }, data: { consumedAt: at } });
      await tx.mfaRecoveryCode.updateMany({ where: { consumedAt: null }, data: { consumedAt: at } });
      await tx.identityAudit.create({ data: { action: "restored_access_invalidated", reason: `Offline maintenance: ${options.reason}` } });
    }
    return { mode: options.apply ? "applied" : "dry-run", affected: pending, limits: ["Password hashes and encrypted authenticators remain intact. People must sign in again and reconnect clients/devices.", "Restored MFA recovery codes are consumed to prevent post-snapshot replay. Regenerate through Account security using the working authenticator; lost factors require explicit owner-assisted administrator recovery.", "No label, MARS, scan or warehouse evidence is replayed, deleted or changed. Reconcile post-snapshot real-world effects separately."] };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
}

export async function runBackfillCli() {
  const { values } = parseArgs({ options: { "expect-database": { type: "string" }, "allow-operational-target": { type: "boolean", default: false }, apply: { type: "boolean", default: false }, reason: { type: "string" }, limit: { type: "string", default: "500" }, after: { type: "string" }, "invalidate-restored-access": { type: "boolean", default: false } }, strict: true });
  const target = maintenanceTarget(values["expect-database"], values["allow-operational-target"]);
  const prisma = maintenanceClient(target);
  try {
    const report = values["invalidate-restored-access"] ? await invalidateRestoredAccess(prisma, { apply: values.apply, reason: values.reason }) : await backfillV2Inventory(prisma, { apply: values.apply, reason: values.reason, limit: Number(values.limit), after: values.after });
    printMaintenance({ database: target.database, operationalTarget: target.operational, ...report });
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1]?.endsWith("v2-backfill.ts")) runBackfillCli().catch(maintenanceFailure);
