CREATE TABLE "ApiRelayDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "origins" TEXT[] NOT NULL,
    "pathPrefix" TEXT NOT NULL,
    "identityPath" TEXT NOT NULL,
    "subjectPath" TEXT NOT NULL,
    "operations" JSONB NOT NULL,
    "program" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ApiRelayRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relayId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "operationId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ApiRelayRevision_operationId_key" ON "ApiRelayRevision"("operationId");
CREATE UNIQUE INDEX "ApiRelayRevision_relayId_revision_key" ON "ApiRelayRevision"("relayId", "revision");
