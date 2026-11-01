CREATE TABLE "Payload" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetOrigins" TEXT[] NOT NULL,
  "draftSource" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 1,
  "operationNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "revision" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "publishedVersionId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payload_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PayloadVersion" (
  "id" TEXT NOT NULL,
  "payloadId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetOrigins" TEXT[] NOT NULL,
  "source" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL,
  "operationNames" TEXT[] NOT NULL,
  "contentHash" TEXT NOT NULL,
  "publishedByUserId" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT NOT NULL,
  CONSTRAINT "PayloadVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayloadVersion_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "Payload"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "PayloadAudit" (
  "id" TEXT NOT NULL,
  "payloadId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "versionId" TEXT,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayloadAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayloadAudit_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "Payload"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Payload_publishedVersionId_key" ON "Payload"("publishedVersionId");
CREATE UNIQUE INDEX "PayloadVersion_payloadId_version_key" ON "PayloadVersion"("payloadId", "version");
CREATE INDEX "PayloadVersion_payloadId_publishedAt_idx" ON "PayloadVersion"("payloadId", "publishedAt");
CREATE INDEX "PayloadAudit_payloadId_createdAt_idx" ON "PayloadAudit"("payloadId", "createdAt");
ALTER TABLE "Payload" ADD CONSTRAINT "Payload_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "PayloadVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION "prevent_payload_version_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published payload versions are immutable. Publish a new version instead.';
END;
$$;
CREATE TRIGGER "PayloadVersion_immutable" BEFORE UPDATE ON "PayloadVersion"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payload_version_update"();
