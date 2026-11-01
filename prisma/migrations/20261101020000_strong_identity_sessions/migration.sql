-- Additive identity upgrade. Existing user IDs and legacy PIN hashes remain;
-- passwordHash NULL requires assisted enrollment instead of public PIN login.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT, ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
CREATE TABLE "UserSession" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "authVersion" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastStrongAuthenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "lockedAt" TIMESTAMP(3), "deviceLabel" TEXT NOT NULL
);
CREATE INDEX "UserSession_userId_expiresAt_idx" ON "UserSession"("userId", "expiresAt");
CREATE TABLE "IdentityRecoveryToken" (
  "id" TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL UNIQUE, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "authVersion" INTEGER NOT NULL, "purpose" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "issuedById" TEXT
);
CREATE INDEX "IdentityRecoveryToken_userId_expiresAt_idx" ON "IdentityRecoveryToken"("userId", "expiresAt");
CREATE TABLE "IdentityAudit" (
  "id" TEXT PRIMARY KEY, "action" TEXT NOT NULL, "actorUserId" TEXT, "targetUserId" TEXT, "sessionId" TEXT,
  "sourceHash" TEXT, "reason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IdentityAudit_targetUserId_createdAt_idx" ON "IdentityAudit"("targetUserId", "createdAt");
CREATE INDEX "IdentityAudit_actorUserId_createdAt_idx" ON "IdentityAudit"("actorUserId", "createdAt");
CREATE TABLE "AuthRateLimit" ("key" TEXT PRIMARY KEY, "windowStart" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 1);
CREATE TABLE "RoleBundle" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "description" TEXT NOT NULL DEFAULT '',
  "capabilities" TEXT[] NOT NULL, "isSystem" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "UserRoleBundle" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "bundleId" TEXT NOT NULL REFERENCES "RoleBundle"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("userId", "bundleId")
);
INSERT INTO "RoleBundle" ("id", "name", "description", "capabilities", "isSystem") VALUES
 ('legacy-admin', 'System administrator', 'Initial reviewed-equivalent legacy admin access', ARRAY['inventory.read','inventory.write','inventory.identify','workflow.read','workflow.execute','labels.read','labels.print','labels.manage','users.manage','files.manage','payloads.manage','diagnostics.use'], true),
 ('legacy-manager', 'Operations manager', 'Initial legacy manager access plus authorized inventory identity review', ARRAY['inventory.read','inventory.write','inventory.identify','workflow.read','workflow.execute','labels.read','labels.print','labels.manage'], true),
 ('legacy-user', 'Warehouse operator', 'Initial legacy ordinary-user access; no new approval authority', ARRAY['inventory.read','inventory.write','workflow.read','workflow.execute','labels.read','labels.print'], true);
INSERT INTO "UserRoleBundle" ("userId", "bundleId") SELECT "id", 'legacy-' || "role"::text FROM "User";
