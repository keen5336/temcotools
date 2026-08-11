ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'manager';

CREATE TYPE "LabelTemplateKind" AS ENUM ('mars_return', 'pick_wave');

CREATE TABLE "LabelPrinter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'text/plain',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LabelPrinter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabelTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LabelTemplateKind" NOT NULL,
    "zpl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LabelPrinter_name_key" ON "LabelPrinter"("name");
CREATE INDEX "LabelPrinter_isActive_name_idx" ON "LabelPrinter"("isActive", "name");
CREATE UNIQUE INDEX "LabelTemplate_kind_name_key" ON "LabelTemplate"("kind", "name");
CREATE INDEX "LabelTemplate_kind_isActive_name_idx" ON "LabelTemplate"("kind", "isActive", "name");
CREATE UNIQUE INDEX "LabelTemplate_one_default_per_kind" ON "LabelTemplate"("kind") WHERE "isDefault" = true;

ALTER TABLE "LabelPrinter" ADD CONSTRAINT "LabelPrinter_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabelPrinter" ADD CONSTRAINT "LabelPrinter_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
