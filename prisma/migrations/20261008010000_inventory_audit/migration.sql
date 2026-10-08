CREATE TABLE "InventoryAuditItem" (
  "id" TEXT NOT NULL,
  "lpn" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "vendor" TEXT NOT NULL,
  "receivedDate" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "sourceData" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "lastScannedAt" TIMESTAMP(3),
  "lastScanWaveName" TEXT,
  "archivedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryAuditItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryAuditItem_lpn_key" ON "InventoryAuditItem"("lpn");
CREATE INDEX "InventoryAuditItem_archivedAt_sourceChangedAt_lpn_idx" ON "InventoryAuditItem"("archivedAt", "sourceChangedAt", "lpn");
CREATE INDEX "InventoryAuditItem_verifiedAt_idx" ON "InventoryAuditItem"("verifiedAt");
CREATE TABLE "InventoryAuditImport" (
  "id" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "uploadedByName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rowCount" INTEGER NOT NULL,
  "insertedCount" INTEGER NOT NULL,
  "changedCount" INTEGER NOT NULL,
  "unchangedCount" INTEGER NOT NULL,
  "duplicateCount" INTEGER NOT NULL,
  "blankCount" INTEGER NOT NULL,
  CONSTRAINT "InventoryAuditImport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InventoryAuditImport_createdAt_idx" ON "InventoryAuditImport"("createdAt");
CREATE TABLE "InventoryAuditScan" (
  "id" TEXT NOT NULL,
  "sourceScanId" TEXT NOT NULL,
  "pickWaveId" TEXT NOT NULL,
  "pickWaveName" TEXT NOT NULL,
  "scannedValue" TEXT NOT NULL,
  "lpn" TEXT,
  "scannedByName" TEXT,
  "matchedPickWave" BOOLEAN NOT NULL,
  "duplicateInWave" BOOLEAN NOT NULL,
  "scannedAt" TIMESTAMP(3) NOT NULL,
  "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryAuditScan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryAuditScan_sourceScanId_key" ON "InventoryAuditScan"("sourceScanId");
CREATE INDEX "InventoryAuditScan_lpn_scannedAt_idx" ON "InventoryAuditScan"("lpn", "scannedAt");
CREATE INDEX "InventoryAuditScan_pickWaveId_idx" ON "InventoryAuditScan"("pickWaveId");
