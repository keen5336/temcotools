CREATE TABLE "OfficeCase" (
 "id" TEXT NOT NULL PRIMARY KEY,"caseKey" TEXT NOT NULL UNIQUE,"unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "reason" TEXT NOT NULL,"episodeKey" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'open',"evidence" JSONB NOT NULL,"conditionSignature" TEXT NOT NULL,
 "responsibleUserId" TEXT,"nextAction" TEXT,"reviewAt" TIMESTAMP(3),"reviewTrigger" TEXT NOT NULL DEFAULT 'date_or_conflict',
 "resolution" TEXT,"resolvedAt" TIMESTAMP(3),"revision" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "OfficeCase_unitId_status_idx" ON "OfficeCase"("unitId","status");
CREATE INDEX "OfficeCase_status_reviewAt_idx" ON "OfficeCase"("status","reviewAt");
CREATE TABLE "OfficeCaseEvent" (
 "id" TEXT NOT NULL PRIMARY KEY,"caseId" TEXT NOT NULL REFERENCES "OfficeCase"("id") ON DELETE RESTRICT,
 "action" TEXT NOT NULL,"userId" TEXT NOT NULL,"reason" TEXT NOT NULL,"evidence" JSONB NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficeCaseEvent_caseId_createdAt_idx" ON "OfficeCaseEvent"("caseId","createdAt");
CREATE TABLE "OfficeScheduleFact" (
 "id" TEXT NOT NULL PRIMARY KEY,"unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "deliveryDate" TEXT,"nextDeliveryDate" TEXT,"complete" BOOLEAN NOT NULL,"source" TEXT NOT NULL DEFAULT 'manual_office',
 "sourceAsOf" TIMESTAMP(3) NOT NULL,"sourceRef" TEXT NOT NULL,"evidence" TEXT NOT NULL,"recordedByUserId" TEXT NOT NULL,"recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficeScheduleFact_unitId_sourceAsOf_idx" ON "OfficeScheduleFact"("unitId","sourceAsOf");
CREATE TABLE "OfficeDisposition" (
 "id" TEXT NOT NULL PRIMARY KEY,"unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "caseId" TEXT REFERENCES "OfficeCase"("id") ON DELETE RESTRICT,"kind" TEXT NOT NULL,"reason" TEXT NOT NULL,"instruction" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'active',
 "decidedByUserId" TEXT NOT NULL,"authorizedByUserId" TEXT,"authorizedAt" TIMESTAMP(3),"triggerAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3),
 "requireNoUpcomingDate" BOOLEAN NOT NULL DEFAULT false,"targetLocation" TEXT,"triggeredByObservationId" TEXT,"triggeredAt" TIMESTAMP(3),
 "revokedAt" TIMESTAMP(3),"revokedByUserId" TEXT,"revocationReason" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"revision" INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX "OfficeDisposition_unitId_status_idx" ON "OfficeDisposition"("unitId","status");
CREATE TABLE "OfficeDispositionExecution" (
 "id" TEXT NOT NULL PRIMARY KEY,"dispositionId" TEXT NOT NULL REFERENCES "OfficeDisposition"("id") ON DELETE RESTRICT,
 "action" TEXT NOT NULL,"observationId" TEXT NOT NULL,"evidence" TEXT NOT NULL,"executedByUserId" TEXT NOT NULL,"executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficeDispositionExecution_dispositionId_executedAt_idx" ON "OfficeDispositionExecution"("dispositionId","executedAt");
CREATE TABLE "OfficeExchange" (
 "id" TEXT NOT NULL PRIMARY KEY,"originalUnitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "replacementUnitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "orderReference" TEXT NOT NULL,"evidence" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'pending',"createdByUserId" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OfficeExchange_distinct_units" CHECK ("originalUnitId"<>"replacementUnitId")
);
CREATE INDEX "OfficeExchange_originalUnitId_replacementUnitId_idx" ON "OfficeExchange"("originalUnitId","replacementUnitId");
CREATE TABLE "OfficeExchangeAttempt" (
 "id" TEXT NOT NULL PRIMARY KEY,"exchangeId" TEXT NOT NULL REFERENCES "OfficeExchange"("id") ON DELETE RESTRICT,
 "outcome" TEXT NOT NULL,"occurredAt" TIMESTAMP(3) NOT NULL,"source" TEXT NOT NULL DEFAULT 'manual_office',"sourceAsOf" TIMESTAMP(3) NOT NULL,
 "evidence" TEXT NOT NULL,"recordedByUserId" TEXT NOT NULL,"recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficeExchangeAttempt_exchangeId_occurredAt_idx" ON "OfficeExchangeAttempt"("exchangeId","occurredAt");
CREATE TABLE "OfficeReturnExpectation" (
 "id" TEXT NOT NULL PRIMARY KEY,"unitId" TEXT NOT NULL REFERENCES "WarehouseUnit"("id") ON DELETE RESTRICT,
 "exchangeId" TEXT REFERENCES "OfficeExchange"("id") ON DELETE RESTRICT,"sourceAttemptId" TEXT REFERENCES "OfficeExchangeAttempt"("id") ON DELETE RESTRICT,
 "kind" TEXT NOT NULL,"status" TEXT NOT NULL,"condition" TEXT NOT NULL,"expectedAt" TIMESTAMP(3),"activatedAt" TIMESTAMP(3),
 "evidence" TEXT NOT NULL,"source" TEXT NOT NULL DEFAULT 'manual_office',"sourceAsOf" TIMESTAMP(3),"sourceRef" TEXT,
 "createdByUserId" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"supersededAt" TIMESTAMP(3),"supersededReason" TEXT
);
CREATE INDEX "OfficeReturnExpectation_unitId_status_idx" ON "OfficeReturnExpectation"("unitId","status");
CREATE UNIQUE INDEX "OfficeReturnExpectation_exchangeId_kind_sourceAttemptId_key" ON "OfficeReturnExpectation"("exchangeId","kind","sourceAttemptId");
CREATE UNIQUE INDEX "OfficeReturnExpectation_original_exchange_key" ON "OfficeReturnExpectation"("exchangeId") WHERE kind='original_exchange_return';
CREATE TABLE "OfficeCommandReceipt" (
 "id" TEXT NOT NULL PRIMARY KEY,"userId" TEXT NOT NULL,"operationId" TEXT NOT NULL,"fingerprint" TEXT NOT NULL,"result" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("userId","operationId")
);
-- These are new decision/authorization powers, deliberately not inherited by
-- ordinary operators or managers. Explicit assignment is an owner/admin action.
INSERT INTO "RoleBundle" (id,name,description,capabilities,"isSystem","updatedAt") VALUES
 ('office-decisions','Office decisions','Explicit office decisions and unit-specific RTV authorization',ARRAY['inventory.read','workflow.read','office.decide','office.authorize_rtv'],false,CURRENT_TIMESTAMP)
 ON CONFLICT (id) DO NOTHING;
UPDATE "RoleBundle" SET capabilities=ARRAY(SELECT DISTINCT unnest(capabilities || ARRAY['office.decide','office.authorize_rtv'])),"updatedAt"=CURRENT_TIMESTAMP WHERE id='legacy-admin';
