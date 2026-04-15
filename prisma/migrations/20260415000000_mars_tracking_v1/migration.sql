-- CreateTable
CREATE TABLE "MarsImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "MarsImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarsUnit" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "orderNumber" TEXT,
    "vendor" TEXT,
    "serialNumber" TEXT,
    "modelNumber" TEXT,
    "vendorRaNumber" TEXT,
    "dateRequested" TIMESTAMP(3),
    "requestStatus" TEXT,
    "returnStatus" TEXT,
    "replacementNeeded" TEXT,
    "staged" BOOLEAN NOT NULL DEFAULT false,
    "lastImportedAt" TIMESTAMP(3),
    "lastScannedAt" TIMESTAMP(3),
    "lastAuditSeenAt" TIMESTAMP(3),
    "lastKnownImportBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarsUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarsEvent" (
    "id" TEXT NOT NULL,
    "marsUnitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarsAuditSession" (
    "id" TEXT NOT NULL,
    "startedByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "MarsAuditSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarsAuditScan" (
    "id" TEXT NOT NULL,
    "auditSessionId" TEXT NOT NULL,
    "scannedValue" TEXT NOT NULL,
    "marsUnitId" TEXT,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "duplicateInSession" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarsAuditScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarsUnit_requestNumber_key" ON "MarsUnit"("requestNumber");

-- AddForeignKey
ALTER TABLE "MarsImportBatch"
ADD CONSTRAINT "MarsImportBatch_uploadedByUserId_fkey"
FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsUnit"
ADD CONSTRAINT "MarsUnit_lastKnownImportBatchId_fkey"
FOREIGN KEY ("lastKnownImportBatchId") REFERENCES "MarsImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsEvent"
ADD CONSTRAINT "MarsEvent_marsUnitId_fkey"
FOREIGN KEY ("marsUnitId") REFERENCES "MarsUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsEvent"
ADD CONSTRAINT "MarsEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditSession"
ADD CONSTRAINT "MarsAuditSession_startedByUserId_fkey"
FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditScan"
ADD CONSTRAINT "MarsAuditScan_auditSessionId_fkey"
FOREIGN KEY ("auditSessionId") REFERENCES "MarsAuditSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditScan"
ADD CONSTRAINT "MarsAuditScan_marsUnitId_fkey"
FOREIGN KEY ("marsUnitId") REFERENCES "MarsUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditScan"
ADD CONSTRAINT "MarsAuditScan_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
