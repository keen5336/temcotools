ALTER TABLE "InventoryAuditItem" ADD COLUMN "unitId" TEXT;
ALTER TABLE "InventoryAuditImport" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'warehouse',
  ADD COLUMN "coverage" TEXT NOT NULL DEFAULT 'partial',
  ADD COLUMN "sourceAsOf" TIMESTAMP(3), ADD COLUMN "uploadedByUserId" TEXT;

CREATE TABLE "WarehouseUnit" (
  "id" TEXT NOT NULL PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT, "creationEvidence" TEXT, "creationFingerprint" TEXT
);
CREATE TABLE "WarehouseIdentifier" (
  "id" TEXT NOT NULL PRIMARY KEY, "unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('lpn','msn','serial','submission')),
  "namespace" TEXT NOT NULL, "value" TEXT NOT NULL, "rawValue" TEXT NOT NULL,
  "evidence" TEXT NOT NULL, "createdByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3), "revokedByUserId" TEXT, "revocationReason" TEXT
);
CREATE INDEX "WarehouseIdentifier_kind_namespace_value_revokedAt_idx" ON "WarehouseIdentifier"("kind","namespace","value","revokedAt");
CREATE INDEX "WarehouseIdentifier_unitId_createdAt_idx" ON "WarehouseIdentifier"("unitId","createdAt");
-- Multiple units may share a disputed identifier. Only repeated identical active links collapse.
CREATE UNIQUE INDEX "WarehouseIdentifier_active_unit_alias_key" ON "WarehouseIdentifier"("unitId","kind","namespace","value") WHERE "revokedAt" IS NULL;
CREATE TABLE "InventorySourceRevision" (
  "id" TEXT NOT NULL PRIMARY KEY, "inventoryItemId" TEXT NOT NULL REFERENCES "InventoryAuditItem"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL, "contentHash" TEXT NOT NULL, "sourceData" JSONB NOT NULL,
  "lpn" TEXT NOT NULL,"status" TEXT NOT NULL,"receivedDate" TEXT NOT NULL,"orderNumber" TEXT NOT NULL,
  "vendor" TEXT NOT NULL,"description" TEXT NOT NULL,"customerName" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "migrationSnapshot" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "InventorySourceRevision_inventoryItemId_revision_key" ON "InventorySourceRevision"("inventoryItemId","revision");
CREATE TABLE "InventoryImportMembership" (
  "id" TEXT NOT NULL PRIMARY KEY, "importId" TEXT NOT NULL REFERENCES "InventoryAuditImport"("id") ON DELETE RESTRICT,
  "sourceRevisionId" TEXT NOT NULL REFERENCES "InventorySourceRevision"("id") ON DELETE RESTRICT, "lpn" TEXT NOT NULL
);
CREATE UNIQUE INDEX "InventoryImportMembership_importId_lpn_key" ON "InventoryImportMembership"("importId","lpn");
CREATE INDEX "InventoryImportMembership_lpn_importId_idx" ON "InventoryImportMembership"("lpn","importId");
CREATE TABLE "WarehousePhysicalObservation" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "eventId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL, "rawIdentifier" TEXT NOT NULL, "identifierType" TEXT NOT NULL,
  "identifierNamespace" TEXT, "type" TEXT NOT NULL CHECK ("type" IN ('presence','check_in','placement','departure')),
  "location" TEXT, "deviceId" TEXT, "pickWaveId" TEXT, "captureMethod" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unitId" TEXT REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
  "resolution" TEXT NOT NULL CHECK ("resolution" IN ('resolved','ambiguous','unresolved')),
  "candidateUnitIds" JSONB NOT NULL
);
CREATE UNIQUE INDEX "WarehousePhysicalObservation_userId_eventId_key" ON "WarehousePhysicalObservation"("userId","eventId");
CREATE INDEX "WarehousePhysicalObservation_unitId_capturedAt_idx" ON "WarehousePhysicalObservation"("unitId","capturedAt");
CREATE INDEX "WarehousePhysicalObservation_resolution_receivedAt_idx" ON "WarehousePhysicalObservation"("resolution","receivedAt");
CREATE TABLE "WarehouseObservationCorrection" (
  "id" TEXT NOT NULL PRIMARY KEY, "observationId" TEXT NOT NULL REFERENCES "WarehousePhysicalObservation"("id") ON DELETE RESTRICT,
  "unitId" TEXT REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT, "reason" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revision" INTEGER NOT NULL
);
CREATE INDEX "WarehouseObservationCorrection_observationId_createdAt_idx" ON "WarehouseObservationCorrection"("observationId","createdAt");
CREATE UNIQUE INDEX "WarehouseObservationCorrection_observationId_revision_key" ON "WarehouseObservationCorrection"("observationId","revision");

-- Seed current retained rows only. Earlier overwritten source revisions and
-- past batch membership cannot be reconstructed and are deliberately not invented.
INSERT INTO "WarehouseUnit" ("id", "createdAt") SELECT 'wms-unit:' || "id", CURRENT_TIMESTAMP FROM "InventoryAuditItem";
UPDATE "InventoryAuditItem" SET "unitId" = 'wms-unit:' || "id";
ALTER TABLE "InventoryAuditItem" ADD CONSTRAINT "InventoryAuditItem_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT;
INSERT INTO "WarehouseIdentifier" ("id","unitId","kind","namespace","value","rawValue","evidence")
SELECT 'wms-lpn:' || "id", "unitId", 'lpn', 'wms', "lpn", "lpn", 'Retained WMS LPN row at migration; not proof of physical stock.' FROM "InventoryAuditItem";
INSERT INTO "InventorySourceRevision" ("id","inventoryItemId","revision","contentHash","sourceData","lpn","status","receivedDate","orderNumber","vendor","description","customerName","migrationSnapshot")
SELECT 'wms-revision:' || "id" || ':' || "revision", "id", "revision", "contentHash", "sourceData", "lpn","status","receivedDate","orderNumber","vendor","description","customerName",true FROM "InventoryAuditItem";
