BEGIN;
ALTER TABLE "AuthSession" DROP CONSTRAINT "AuthSession_kind_check";
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_kind_check" CHECK (kind IN ('password','enrollment','mcp'));
-- AlterTable
ALTER TABLE "AuthSession" ADD COLUMN     "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "McpClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "authMethod" TEXT NOT NULL DEFAULT 'none',
    "secretHash" TEXT,
    "metadataUrl" TEXT,
    "metadataUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuthorization" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "state" TEXT,
    "scopes" TEXT[],
    "challenge" TEXT NOT NULL,
    "browserSessionId" TEXT,
    "userId" TEXT,
    "authVersion" INTEGER,
    "codeHash" TEXT,
    "decidedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpGrant" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "approvedBySessionId" TEXT NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOperation" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpArtifact" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpAuthorization_codeHash_key" ON "McpAuthorization"("codeHash");

-- CreateIndex
CREATE INDEX "McpAuthorization_expiresAt_idx" ON "McpAuthorization"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpGrant_sessionId_key" ON "McpGrant"("sessionId");

-- CreateIndex
CREATE INDEX "McpGrant_userId_revokedAt_idx" ON "McpGrant"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpToken_grantId_idx" ON "McpToken"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "McpOperation_grantId_operationId_key" ON "McpOperation"("grantId", "operationId");

-- CreateIndex
CREATE INDEX "McpArtifact_expiresAt_idx" ON "McpArtifact"("expiresAt");

-- AddForeignKey
ALTER TABLE "McpAuthorization" ADD CONSTRAINT "McpAuthorization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOperation" ADD CONSTRAINT "McpOperation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpArtifact" ADD CONSTRAINT "McpArtifact_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


UPDATE "AuthSession" SET "lastUsedAt"=GREATEST("createdAt", COALESCE("reauthenticatedAt", "createdAt"));
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_kind_check" CHECK (kind IN ('access','refresh'));
ALTER TABLE "McpOperation" ADD CONSTRAINT "McpOperation_state_check" CHECK (state IN ('pending','completed','unknown'));
COMMIT;
