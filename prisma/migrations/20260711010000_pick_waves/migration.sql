CREATE TABLE "PickWave" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "PickWave_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickWaveItem" (
    "id" TEXT NOT NULL,
    "pickWaveId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "routeNumber" TEXT,
    "contact" TEXT,
    "orderNumber" TEXT,
    "lpn" TEXT,
    "serialNumber" TEXT,
    "trackingNumber" TEXT,
    "partNumber" TEXT,
    "description" TEXT,
    "scannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PickWaveItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickWaveRouteMapping" (
    "id" TEXT NOT NULL,
    "pickWaveId" TEXT NOT NULL,
    "routeNumber" TEXT NOT NULL,
    "stagingLocation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PickWaveRouteMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PickWaveScan" (
    "id" TEXT NOT NULL,
    "pickWaveId" TEXT NOT NULL,
    "itemId" TEXT,
    "scannedValue" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "alreadyScanned" BOOLEAN NOT NULL DEFAULT false,
    "scannedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PickWaveScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PickWave_archivedAt_createdAt_idx" ON "PickWave"("archivedAt", "createdAt");
CREATE UNIQUE INDEX "PickWaveItem_pickWaveId_rowNumber_key" ON "PickWaveItem"("pickWaveId", "rowNumber");
CREATE INDEX "PickWaveItem_pickWaveId_scannedAt_idx" ON "PickWaveItem"("pickWaveId", "scannedAt");
CREATE INDEX "PickWaveItem_pickWaveId_lpn_idx" ON "PickWaveItem"("pickWaveId", "lpn");
CREATE INDEX "PickWaveItem_pickWaveId_serialNumber_idx" ON "PickWaveItem"("pickWaveId", "serialNumber");
CREATE INDEX "PickWaveItem_pickWaveId_trackingNumber_idx" ON "PickWaveItem"("pickWaveId", "trackingNumber");
CREATE INDEX "PickWaveItem_pickWaveId_orderNumber_idx" ON "PickWaveItem"("pickWaveId", "orderNumber");
CREATE UNIQUE INDEX "PickWaveRouteMapping_pickWaveId_routeNumber_key" ON "PickWaveRouteMapping"("pickWaveId", "routeNumber");
CREATE INDEX "PickWaveRouteMapping_pickWaveId_idx" ON "PickWaveRouteMapping"("pickWaveId");
CREATE INDEX "PickWaveScan_pickWaveId_createdAt_idx" ON "PickWaveScan"("pickWaveId", "createdAt");
CREATE INDEX "PickWaveScan_itemId_idx" ON "PickWaveScan"("itemId");

ALTER TABLE "PickWave" ADD CONSTRAINT "PickWave_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PickWaveItem" ADD CONSTRAINT "PickWaveItem_pickWaveId_fkey" FOREIGN KEY ("pickWaveId") REFERENCES "PickWave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PickWaveRouteMapping" ADD CONSTRAINT "PickWaveRouteMapping_pickWaveId_fkey" FOREIGN KEY ("pickWaveId") REFERENCES "PickWave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PickWaveScan" ADD CONSTRAINT "PickWaveScan_pickWaveId_fkey" FOREIGN KEY ("pickWaveId") REFERENCES "PickWave"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PickWaveScan" ADD CONSTRAINT "PickWaveScan_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PickWaveItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PickWaveScan" ADD CONSTRAINT "PickWaveScan_scannedByUserId_fkey" FOREIGN KEY ("scannedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
