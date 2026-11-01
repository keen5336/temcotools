CREATE TABLE "MarsImportRow" (
 id TEXT PRIMARY KEY,"batchId" TEXT NOT NULL REFERENCES "MarsImportBatch"(id) ON DELETE RESTRICT,"rowNumber" INTEGER NOT NULL,"requestNumber" TEXT,fields JSONB NOT NULL,"sourceData" JSONB NOT NULL,"contentHash" TEXT NOT NULL,"recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MarsImportRow_batchId_rowNumber_key" ON "MarsImportRow"("batchId","rowNumber");
CREATE INDEX "MarsImportRow_batchId_requestNumber_idx" ON "MarsImportRow"("batchId","requestNumber");
CREATE FUNCTION "MarsImportRow_reject_rewrite"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'MARS source rows are immutable; retain a new batch'; END $$;
CREATE TRIGGER "MarsImportRow_immutable" BEFORE UPDATE OR DELETE ON "MarsImportRow" FOR EACH ROW EXECUTE FUNCTION "MarsImportRow_reject_rewrite"();
ALTER TABLE "MarsAuditSession" ADD COLUMN "sourceDraftId" TEXT, ADD COLUMN "sourceDraftFingerprint" TEXT;
CREATE UNIQUE INDEX "MarsAuditSession_sourceDraftId_key" ON "MarsAuditSession"("sourceDraftId");
ALTER TABLE "MarsAuditScan" ADD COLUMN "capturedAt" TIMESTAMP(3),ADD COLUMN "captureMethod" TEXT,ADD COLUMN "captureSessionId" TEXT,ADD COLUMN "captureProvenance" TEXT NOT NULL DEFAULT 'legacy_unknown',ADD COLUMN "warehouseObservationId" TEXT;
