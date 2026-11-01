CREATE TABLE "LabelWorkflow" (
 "purpose" TEXT NOT NULL, "name" TEXT NOT NULL, "draftZpl" TEXT NOT NULL, "requiredFields" TEXT[] NOT NULL, "rules" JSONB NOT NULL,
 "widthMm" DOUBLE PRECISION NOT NULL, "heightMm" DOUBLE PRECISION NOT NULL, "dpi" INTEGER NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "enabled" BOOLEAN NOT NULL DEFAULT true, "publishedVersionId" TEXT,
 "updatedByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "LabelWorkflow_pkey" PRIMARY KEY ("purpose")
);
CREATE TABLE "LabelWorkflowVersion" (
 "id" TEXT NOT NULL, "purpose" TEXT NOT NULL, "version" INTEGER NOT NULL, "name" TEXT NOT NULL, "zpl" TEXT NOT NULL,
 "requiredFields" TEXT[] NOT NULL, "rules" JSONB NOT NULL, "widthMm" DOUBLE PRECISION NOT NULL, "heightMm" DOUBLE PRECISION NOT NULL, "dpi" INTEGER NOT NULL,
 "contentHash" TEXT NOT NULL, "publishedByUserId" TEXT NOT NULL, "note" TEXT NOT NULL, "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LabelWorkflowVersion_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "LabelWorkflowVersion_purpose_fkey" FOREIGN KEY ("purpose") REFERENCES "LabelWorkflow"("purpose") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LabelWorkflow_publishedVersionId_key" ON "LabelWorkflow"("publishedVersionId");
CREATE UNIQUE INDEX "LabelWorkflowVersion_purpose_version_key" ON "LabelWorkflowVersion"("purpose", "version");
ALTER TABLE "LabelWorkflow" ADD CONSTRAINT "LabelWorkflow_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "LabelWorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "LabelWorkflowAudit" (
 "id" TEXT NOT NULL, "purpose" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, "action" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "versionId" TEXT, "note" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LabelWorkflowAudit_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "LabelWorkflowAudit_purpose_fkey" FOREIGN KEY ("purpose") REFERENCES "LabelWorkflow"("purpose") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LabelWorkflowAudit_purpose_createdAt_idx" ON "LabelWorkflowAudit"("purpose", "createdAt");
CREATE TABLE "PrintingDevice" (
 "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "authVersion" INTEGER NOT NULL, "tokenHash" TEXT NOT NULL,
 "name" TEXT NOT NULL, "mode" TEXT NOT NULL, "printerIds" TEXT[] NOT NULL, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseExpiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PrintingDevice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrintingDevice_mode_leaseExpiresAt_idx" ON "PrintingDevice"("mode", "leaseExpiresAt");
CREATE INDEX "PrintingDevice_userId_sessionId_idx" ON "PrintingDevice"("userId", "sessionId");
CREATE TABLE "LabelIssuance" (
 "id" TEXT NOT NULL, "operationId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, "actorSessionId" TEXT NOT NULL, "actorAuthVersion" INTEGER NOT NULL,
 "actorGrantId" TEXT, "actorAuthSource" TEXT NOT NULL, "actorCapabilities" TEXT[] NOT NULL, "unitId" TEXT, "purpose" TEXT NOT NULL,
 "printerId" TEXT NOT NULL, "workflowVersionId" TEXT, "contentFingerprint" TEXT NOT NULL, "inputFingerprint" TEXT NOT NULL,
 "renderedZpl" TEXT NOT NULL, "mode" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'queued',
 "automatic" BOOLEAN NOT NULL DEFAULT false, "reprintOf" TEXT, "reason" TEXT, "ruleId" TEXT, "claimTokenHash" TEXT,
 "reportFingerprint" TEXT, "dispatchedAt" TIMESTAMP(3), "reportedAt" TIMESTAMP(3), "physicallyConfirmedAt" TIMESTAMP(3),
 "appliedAt" TIMESTAMP(3), "reconciledAt" TIMESTAMP(3), "reconciliationNote" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LabelIssuance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LabelIssuance_actorUserId_operationId_key" ON "LabelIssuance"("actorUserId", "operationId");
CREATE INDEX "LabelIssuance_unitId_purpose_createdAt_idx" ON "LabelIssuance"("unitId", "purpose", "createdAt");
CREATE INDEX "LabelIssuance_deviceId_state_createdAt_idx" ON "LabelIssuance"("deviceId", "state", "createdAt");
CREATE INDEX "LabelIssuance_contentFingerprint_printerId_idx" ON "LabelIssuance"("contentFingerprint", "printerId");
CREATE TABLE "LabelIssuanceEvent" (
 "id" TEXT NOT NULL, "issuanceId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL, "deviceId" TEXT, "action" TEXT NOT NULL,
 "state" TEXT NOT NULL, "note" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "LabelIssuanceEvent_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "LabelIssuanceEvent_issuanceId_fkey" FOREIGN KEY ("issuanceId") REFERENCES "LabelIssuance"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LabelIssuanceEvent_issuanceId_createdAt_idx" ON "LabelIssuanceEvent"("issuanceId", "createdAt");
CREATE FUNCTION "prevent_label_workflow_version_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published label versions are immutable. Publish a new version instead.'; END;
$$;
CREATE TRIGGER "LabelWorkflowVersion_immutable" BEFORE UPDATE ON "LabelWorkflowVersion" FOR EACH ROW EXECUTE FUNCTION "prevent_label_workflow_version_update"();
