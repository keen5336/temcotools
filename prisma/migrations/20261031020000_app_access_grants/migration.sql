CREATE TABLE "AppAccessGrant" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authVersion" INTEGER NOT NULL,
  "clientName" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'temcotools-mcp',
  "scopes" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AppAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AppAccessGrant_tokenHash_key" ON "AppAccessGrant"("tokenHash");
CREATE INDEX "AppAccessGrant_userId_expiresAt_idx" ON "AppAccessGrant"("userId", "expiresAt");
