CREATE TABLE "DmpOperation" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorSessionId" TEXT NOT NULL,
  "actorGrantId" TEXT,
  "operationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "requestId" TEXT,
  "upstreamStatus" INTEGER,
  "responseHash" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DmpOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DmpOperation_actorUserId_operationId_key" ON "DmpOperation"("actorUserId", "operationId");
CREATE INDEX "DmpOperation_actorUserId_createdAt_idx" ON "DmpOperation"("actorUserId", "createdAt");
