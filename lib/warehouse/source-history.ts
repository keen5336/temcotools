import { Prisma } from "@prisma/client";

// Reuse the existing import writer gate for manual identifier corrections too.
// One transaction may contain100k report rows; per-row advisory locks would
// exhaust PostgreSQL shared lock capacity. Scans do not acquire this gate.
export const WAREHOUSE_IDENTITY_IMPORT_LOCK = 8100801;

/** Keep old content before the legacy current-row upsert replaces it. */
export async function retainCurrentSourceRevisions(tx: Prisma.TransactionClient, lpns: string[]) {
  if (!lpns.length) return;
  await tx.$executeRaw`
    INSERT INTO "InventorySourceRevision" ("id","inventoryItemId",revision,"contentHash","sourceData",lpn,status,"receivedDate","orderNumber",vendor,description,"customerName","recordedAt","migrationSnapshot")
    SELECT 'wms-revision:' || id || ':' || revision, id, revision, "contentHash", "sourceData",lpn,status,"receivedDate","orderNumber",vendor,description,"customerName",CURRENT_TIMESTAMP, true
    FROM "InventoryAuditItem" WHERE lpn IN (${Prisma.join(lpns)})
    ON CONFLICT ("inventoryItemId",revision) DO NOTHING`;
}

/** Add batch membership without resetting unchanged legacy verification/archive state. */
export async function retainImportedInventory(tx: Prisma.TransactionClient, lpns: string[], importId: string, actorUserId?: string) {
  if (!lpns.length) return;
  // A destination may reuse only its explicitly visible accepted identity.
  // Foreign/ambiguous matches stay as reported rows awaiting identity review;
  // neither the other unit ID nor its private evidence is returned to this site.
  const candidates = await tx.$queryRaw<{ id: string; unitId: string | null; conflict: boolean }[]>`
    SELECT i.id,c."unitId",c.conflict FROM "InventoryAuditItem" i
    CROSS JOIN LATERAL public.temco_custody_import_identity(i.lpn) c
    WHERE i.lpn IN (${Prisma.join(lpns)}) AND i."unitId" IS NULL`;
  const accepted = candidates.filter(row => row.unitId);
  if (accepted.length) await tx.$executeRaw`
    UPDATE "InventoryAuditItem" i SET "unitId"=r."unitId"
    FROM jsonb_to_recordset(${JSON.stringify(accepted)}::jsonb) AS r(id text,"unitId" text)
    WHERE i.id=r.id AND i."unitId" IS NULL`;
  const freshIds = candidates.filter(row => !row.unitId && !row.conflict).map(row => row.id);
  if (freshIds.length) {
  await tx.$executeRaw`
    INSERT INTO "WarehouseUnit" (id,"createdByUserId")
    SELECT 'wms-unit:' || id, ${actorUserId ?? null} FROM "InventoryAuditItem" WHERE id IN (${Prisma.join(freshIds)}) AND "unitId" IS NULL
    ON CONFLICT (id) DO NOTHING`;
  await tx.$executeRaw`UPDATE "InventoryAuditItem" SET "unitId" = 'wms-unit:' || id WHERE id IN (${Prisma.join(freshIds)}) AND "unitId" IS NULL`;
  }
  // A revoked alias is an office correction. Reimport does not silently undo it.
  await tx.$executeRaw`
    INSERT INTO "WarehouseIdentifier" (id,"unitId",kind,namespace,value,"rawValue",evidence,"createdByUserId")
    SELECT 'wms-lpn:' || i.id, i."unitId", 'lpn','wms',i.lpn,i.lpn,'WMS LPN source row; not evidence of physical presence.',${actorUserId ?? null}
    FROM "InventoryAuditItem" i WHERE i.lpn IN (${Prisma.join(lpns)}) AND i."unitId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "WarehouseUnitAlias" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn)
    ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`
    INSERT INTO "InventorySourceRevision" (id,"inventoryItemId",revision,"contentHash","sourceData",lpn,status,"receivedDate","orderNumber",vendor,description,"customerName","recordedAt","migrationSnapshot")
    SELECT 'wms-revision:' || id || ':' || revision,id,revision,"contentHash","sourceData",lpn,status,"receivedDate","orderNumber",vendor,description,"customerName",CURRENT_TIMESTAMP,false
    FROM "InventoryAuditItem" WHERE lpn IN (${Prisma.join(lpns)})
    ON CONFLICT ("inventoryItemId",revision) DO NOTHING`;
  await tx.$executeRaw`
    INSERT INTO "InventoryImportMembership" (id,"importId","sourceRevisionId",lpn)
    SELECT ${importId} || ':' || i.id,${importId},r.id,i.lpn
    FROM "InventoryAuditItem" i JOIN "InventorySourceRevision" r ON r."inventoryItemId"=i.id AND r.revision=i.revision
    WHERE i.lpn IN (${Prisma.join(lpns)}) ON CONFLICT ("importId",lpn) DO NOTHING`;
}
