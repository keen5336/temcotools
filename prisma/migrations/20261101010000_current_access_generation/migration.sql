-- Additive authorization generation. Existing cookies lack this generation and
-- require a fresh login; no existing user, credential or evidence is removed.
ALTER TABLE "User" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 1;
