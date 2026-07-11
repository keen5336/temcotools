-- CreateTable
CREATE TABLE "ScanListSession" (
    "id" TEXT NOT NULL,
    "localDraftId" TEXT,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ScanListSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanListItem" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "scannedValue" TEXT NOT NULL,
    "scannedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanListItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanListSession_archivedAt_updatedAt_idx" ON "ScanListSession"("archivedAt", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScanListSession_localDraftId_key" ON "ScanListSession"("localDraftId");

-- CreateIndex
CREATE INDEX "ScanListItem_sessionId_createdAt_idx" ON "ScanListItem"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScanListSession" ADD CONSTRAINT "ScanListSession_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanListItem" ADD CONSTRAINT "ScanListItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ScanListSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanListItem" ADD CONSTRAINT "ScanListItem_scannedByUserId_fkey" FOREIGN KEY ("scannedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
