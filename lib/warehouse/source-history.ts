import { Prisma } from "@prisma/client";

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
  await tx.$executeRaw`
    INSERT INTO "WarehouseUnit" (id,"createdByUserId")
    SELECT 'wms-unit:' || id, ${actorUserId ?? null} FROM "InventoryAuditItem" WHERE lpn IN (${Prisma.join(lpns)}) AND "unitId" IS NULL
    ON CONFLICT (id) DO NOTHING`;
  await tx.$executeRaw`UPDATE "InventoryAuditItem" SET "unitId" = 'wms-unit:' || id WHERE lpn IN (${Prisma.join(lpns)}) AND "unitId" IS NULL`;
  // A revoked alias is an office correction. Reimport does not silently undo it.
  await tx.$executeRaw`
    INSERT INTO "WarehouseIdentifier" (id,"unitId",kind,namespace,value,"rawValue",evidence,"createdByUserId")
    SELECT 'wms-lpn:' || i.id, i."unitId", 'lpn','wms',i.lpn,i.lpn,'WMS LPN source row; not evidence of physical presence.',${actorUserId ?? null}
    FROM "InventoryAuditItem" i WHERE i.lpn IN (${Prisma.join(lpns)})
      AND NOT EXISTS (SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=i."unitId" AND a.kind='lpn' AND a.namespace='wms' AND a.value=i.lpn)
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
