ALTER TABLE "MarsImportBatch" ADD COLUMN scope TEXT NOT NULL DEFAULT 'legacy_unknown', ADD COLUMN coverage TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN "sourceAsOf" TIMESTAMP(3), ADD COLUMN "coverageEvidence" TEXT;
ALTER TABLE "MarsAuditScan" ADD COLUMN "voidedAt" TIMESTAMP(3), ADD COLUMN "voidedByUserId" TEXT, ADD COLUMN "voidReason" TEXT;
CREATE INDEX "MarsAuditScan_auditSessionId_voidedAt_createdAt_idx" ON "MarsAuditScan"("auditSessionId","voidedAt","createdAt");
CREATE TABLE "MarsSubmissionIntent" (
 id TEXT PRIMARY KEY,"unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','in_progress','unknown','linked','verified_not_submitted','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,"authorizationId" TEXT,"authorizedByUserId" TEXT NOT NULL,"authorizationExpiresAt" TIMESTAMP(3) NOT NULL,
 "preparedByUserId" TEXT NOT NULL,"requestNumber" TEXT,evidence TEXT NOT NULL,"startedAt" TIMESTAMP(3),"linkedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "MarsSubmissionIntent_unitId_createdAt_idx" ON "MarsSubmissionIntent"("unitId","createdAt");
CREATE INDEX "MarsSubmissionIntent_state_updatedAt_idx" ON "MarsSubmissionIntent"(state,"updatedAt");
CREATE UNIQUE INDEX "MarsSubmissionIntent_active_unit_key" ON "MarsSubmissionIntent"("unitId") WHERE state IN ('prepared','in_progress','unknown');
CREATE TABLE "MarsSubmissionIntentEvent" (
 id TEXT PRIMARY KEY,"intentId" TEXT NOT NULL REFERENCES "MarsSubmissionIntent"(id) ON DELETE RESTRICT,"userId" TEXT NOT NULL,action TEXT NOT NULL,evidence TEXT NOT NULL,payload JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MarsSubmissionIntentEvent_intentId_createdAt_idx" ON "MarsSubmissionIntentEvent"("intentId","createdAt");
CREATE TABLE "MarsCommandReceipt" (id TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"operationId" TEXT NOT NULL,action TEXT NOT NULL,fingerprint TEXT NOT NULL,result JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "MarsCommandReceipt_userId_operationId_key" ON "MarsCommandReceipt"("userId","operationId");
