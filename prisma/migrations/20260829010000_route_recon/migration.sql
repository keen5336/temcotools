CREATE TABLE "RouteRecon" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "routeCount" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "RouteRecon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteReconItem" (
    "id" TEXT NOT NULL,
    "routeReconId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "routeNumber" TEXT,
    "contact" TEXT,
    "orderNumber" TEXT,
    "lpn" TEXT,
    "serialNumber" TEXT,
    "trackingNumber" TEXT,
    "partNumber" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RouteReconItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RouteRecon_archivedAt_createdAt_idx" ON "RouteRecon"("archivedAt", "createdAt");
CREATE UNIQUE INDEX "RouteReconItem_routeReconId_rowNumber_key" ON "RouteReconItem"("routeReconId", "rowNumber");
CREATE INDEX "RouteReconItem_routeReconId_routeNumber_idx" ON "RouteReconItem"("routeReconId", "routeNumber");

ALTER TABLE "RouteRecon" ADD CONSTRAINT "RouteRecon_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RouteReconItem" ADD CONSTRAINT "RouteReconItem_routeReconId_fkey" FOREIGN KEY ("routeReconId") REFERENCES "RouteRecon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
