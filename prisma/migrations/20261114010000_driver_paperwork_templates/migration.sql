CREATE TABLE "DriverPaperworkRevision" (
    "version" INTEGER NOT NULL,
    "template" JSONB NOT NULL,
    "program" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriverPaperworkRevision_pkey" PRIMARY KEY ("version")
);
CREATE UNIQUE INDEX "DriverPaperworkRevision_operationId_key" ON "DriverPaperworkRevision"("operationId");
ALTER TABLE "DriverPaperworkRevision" ADD CONSTRAINT "DriverPaperworkRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
