ALTER TABLE "User"
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "passwordEnrolledAt" TIMESTAMP(3),
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
  ADD COLUMN "legacyDisabledAt" TIMESTAMP(3),
  ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "AuthSession" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "authVersion" INTEGER NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('password', 'enrollment')),
  "deviceName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "reauthenticatedAt" TIMESTAMP(3)
);
CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_idx" ON "AuthSession"("userId", "revokedAt", "expiresAt");

CREATE TABLE "AccountCode" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('enroll', 'reset')),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "authVersion" INTEGER NOT NULL,
  "operationId" TEXT NOT NULL UNIQUE,
  "issuedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3)
);
CREATE INDEX "AccountCode_userId_consumedAt_idx" ON "AccountCode"("userId", "consumedAt");
CREATE TABLE "AuthRateLimit" ("key" TEXT PRIMARY KEY, "windowStart" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL);
CREATE TABLE "AuthAudit" (
  "id" TEXT PRIMARY KEY,
  "action" TEXT NOT NULL,
  "actorUserId" TEXT,
  "targetUserId" TEXT,
  "sessionId" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuthAudit_targetUserId_createdAt_idx" ON "AuthAudit"("targetUserId", "createdAt");
CREATE TABLE "AuthPolicy" ("id" TEXT PRIMARY KEY, "legacyLoginEnabled" BOOLEAN NOT NULL DEFAULT true);
INSERT INTO "AuthPolicy" ("id", "legacyLoginEnabled") VALUES ('global', true);

-- Existing user IDs, PIN hashes, role/access settings and operational records
-- are preserved. Old cookies grant setup access only in the new application.
