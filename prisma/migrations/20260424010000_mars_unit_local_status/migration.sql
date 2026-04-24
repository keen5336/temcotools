-- AlterTable
ALTER TABLE "MarsUnit"
ADD COLUMN     "localStatus" TEXT NOT NULL DEFAULT 'active';

-- Backfill rows that were previously marked as missing from the latest import.
UPDATE "MarsUnit"
SET "localStatus" = 'deleted',
    "archivedAt" = COALESCE("archivedAt", "missingFromLatestImportAt", CURRENT_TIMESTAMP),
    "archivedReason" = COALESCE("archivedReason", 'Deleted from MARS.')
WHERE "presentInLatestImport" = false;
