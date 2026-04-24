-- AlterTable
ALTER TABLE "MarsUnit"
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedReason" TEXT,
ADD COLUMN     "presentInLatestImport" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "missingFromLatestImportAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarsAuditSession"
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastAmendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarsAuditScan"
ADD COLUMN     "manualEntry" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MarsAuditReport" (
    "id" TEXT NOT NULL,
    "auditSessionId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "generatedByUserId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "MarsAuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarsAuditReport_auditSessionId_createdAt_idx" ON "MarsAuditReport"("auditSessionId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "MarsAuditReport" ADD CONSTRAINT "MarsAuditReport_auditSessionId_fkey" FOREIGN KEY ("auditSessionId") REFERENCES "MarsAuditSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditReport" ADD CONSTRAINT "MarsAuditReport_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "MarsImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarsAuditReport" ADD CONSTRAINT "MarsAuditReport_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
