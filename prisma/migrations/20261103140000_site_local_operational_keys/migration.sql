BEGIN;
-- Same named lane/day, printer and label purpose may exist at different sites.
-- IF EXISTS permits exact catalog reconciliation of an interrupted DDL-only
-- rehearsal; the complete reviewed migration is transactional on deployment.
DROP INDEX IF EXISTS "LabelPrinter_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "LabelPrinter_siteId_name_key" ON "LabelPrinter"("siteId","name");
DROP INDEX IF EXISTS "LabelTemplate_kind_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "LabelTemplate_siteId_kind_name_key" ON "LabelTemplate"("siteId","kind","name");
DROP INDEX IF EXISTS "LabelTemplate_one_default_per_kind";
CREATE UNIQUE INDEX "LabelTemplate_one_default_per_kind" ON "LabelTemplate"("siteId",kind) WHERE "isDefault"=true AND "isActive"=true;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='LabelWorkflowVersion_purpose_fkey') THEN
  ALTER TABLE "LabelWorkflowVersion" DROP CONSTRAINT "LabelWorkflowVersion_purpose_fkey";
  ALTER TABLE "LabelWorkflowAudit" DROP CONSTRAINT "LabelWorkflowAudit_purpose_fkey";
  ALTER TABLE "LabelWorkflow" DROP CONSTRAINT "LabelWorkflow_pkey";
  ALTER TABLE "LabelWorkflow" ADD CONSTRAINT "LabelWorkflow_pkey" PRIMARY KEY("siteId","purpose");
  ALTER TABLE "LabelWorkflowVersion" ADD CONSTRAINT "LabelWorkflowVersion_siteId_purpose_fkey" FOREIGN KEY("siteId","purpose") REFERENCES "LabelWorkflow"("siteId","purpose") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LabelWorkflowAudit" ADD CONSTRAINT "LabelWorkflowAudit_siteId_purpose_fkey" FOREIGN KEY("siteId","purpose") REFERENCES "LabelWorkflow"("siteId","purpose") ON DELETE RESTRICT ON UPDATE CASCADE;
 END IF;
END $$;
DROP INDEX IF EXISTS "LabelWorkflowVersion_purpose_version_key";
CREATE UNIQUE INDEX IF NOT EXISTS "LabelWorkflowVersion_siteId_purpose_version_key" ON "LabelWorkflowVersion"("siteId","purpose",version);
ALTER TABLE "DispatchBoard" DROP CONSTRAINT IF EXISTS "DispatchBoard_day_scope_key";
CREATE UNIQUE INDEX IF NOT EXISTS "DispatchBoard_siteId_day_scope_key" ON "DispatchBoard"("siteId",day,scope);
COMMIT;
