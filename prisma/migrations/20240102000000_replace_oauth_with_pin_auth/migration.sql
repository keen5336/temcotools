-- DropIndex
DROP INDEX "User_email_key";

-- DropIndex
DROP INDEX "User_microsoftOid_key";

-- AlterTable: drop OAuth columns, add PIN-based columns
ALTER TABLE "User"
  DROP COLUMN "email",
  DROP COLUMN "microsoftOid",
  DROP COLUMN "name",
  ADD COLUMN "username" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "displayName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "pinHash" TEXT NOT NULL DEFAULT '';

-- Remove temporary defaults now that columns exist
ALTER TABLE "User"
  ALTER COLUMN "username" DROP DEFAULT,
  ALTER COLUMN "displayName" DROP DEFAULT,
  ALTER COLUMN "pinHash" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
