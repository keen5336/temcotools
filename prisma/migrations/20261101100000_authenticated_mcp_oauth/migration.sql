CREATE TABLE "OAuthClient" (
 "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "metadata" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "disabledAt" TIMESTAMP(3)
);
CREATE TABLE "OAuthAuthorizationRequest" (
 "id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL REFERENCES "OAuthClient"("id") ON DELETE CASCADE,
 "redirectUri" TEXT NOT NULL, "state" TEXT, "codeChallenge" TEXT NOT NULL, "resource" TEXT NOT NULL,
 "scopes" TEXT[] NOT NULL, "boundUserId" TEXT, "boundSessionId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
 "resolvedAt" TIMESTAMP(3), "deniedAt" TIMESTAMP(3)
);
CREATE INDEX "OAuthAuthorizationRequest_expiresAt_idx" ON "OAuthAuthorizationRequest"("expiresAt");
CREATE TABLE "OAuthGrant" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL UNIQUE, "clientId" TEXT NOT NULL REFERENCES "OAuthClient"("id") ON DELETE RESTRICT,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "sessionId" TEXT NOT NULL REFERENCES "UserSession"("id") ON DELETE CASCADE,
 "authVersion" INTEGER NOT NULL, "issuer" TEXT NOT NULL, "resource" TEXT NOT NULL, "scopes" TEXT[] NOT NULL,
 "refreshGeneration" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "revokedReason" TEXT
);
CREATE INDEX "OAuthGrant_userId_createdAt_idx" ON "OAuthGrant"("userId", "createdAt");
CREATE TABLE "OAuthAuthorizationCode" (
 "id" TEXT PRIMARY KEY, "codeHash" TEXT NOT NULL UNIQUE, "grantId" TEXT NOT NULL REFERENCES "OAuthGrant"("id") ON DELETE CASCADE,
 "clientId" TEXT NOT NULL, "redirectUri" TEXT NOT NULL, "codeChallenge" TEXT NOT NULL, "resource" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE TABLE "OAuthToken" (
 "id" TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL UNIQUE, "grantId" TEXT NOT NULL REFERENCES "OAuthGrant"("id") ON DELETE CASCADE,
 "kind" TEXT NOT NULL, "generation" INTEGER NOT NULL, "scopes" TEXT[] NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE INDEX "OAuthToken_grantId_kind_idx" ON "OAuthToken"("grantId", "kind");
