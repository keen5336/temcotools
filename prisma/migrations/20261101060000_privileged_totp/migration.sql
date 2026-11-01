ALTER TABLE "UserSession" ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3);
CREATE TABLE "UserMfa" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "encryptedSecret" TEXT NOT NULL, "enrollmentSessionId" TEXT NOT NULL,
  "pendingExpiresAt" TIMESTAMP(3), "enabledAt" TIMESTAMP(3), "lastUsedStep" INTEGER NOT NULL DEFAULT -1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "MfaRecoveryCode" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "UserMfa"("userId") ON DELETE CASCADE,
  "codeHash" TEXT NOT NULL, "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "codeHash")
);
