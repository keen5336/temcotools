BEGIN;
CREATE TABLE "IntegrationActionRecord" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "name" text NOT NULL,
 "draft" jsonb NOT NULL,
 "revision" integer NOT NULL DEFAULT 1,
 "enabled" boolean NOT NULL DEFAULT true,
 "publishedVersionId" text,
 "createdByUserId" text NOT NULL,
 "updatedByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL
);
CREATE INDEX "IntegrationActionRecord_siteId_idx" ON "IntegrationActionRecord"("siteId");
ALTER TABLE "IntegrationActionRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntegrationActionRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "IntegrationActionRecord" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "IntegrationActionRecord" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "IntegrationActionVersion" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "actionId" text NOT NULL,
 "version" integer NOT NULL,
 "definition" jsonb NOT NULL,
 "contentHash" text NOT NULL,
 "createdByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "contractApproval" jsonb,
 UNIQUE("actionId","version")
);
CREATE INDEX "IntegrationActionVersion_siteId_idx" ON "IntegrationActionVersion"("siteId");
ALTER TABLE "IntegrationActionVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntegrationActionVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "IntegrationActionVersion" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "IntegrationActionVersion" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "ProviderConnection" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "integrationId" text NOT NULL,
 "ownerUserId" text NOT NULL,
 "ownerSessionId" text NOT NULL,
 "deviceId" text NOT NULL,
 "tabId" text NOT NULL,
 "origin" text NOT NULL,
 "pathname" text NOT NULL,
 "transportState" text NOT NULL,
 "authenticationState" text NOT NULL,
 "upstreamIdentity" jsonb,
 "upstreamWarehouse" jsonb,
 "allowedActionVersionIds" text[] NOT NULL,
 "payloadVersionId" text,
 "heartbeatAt" timestamp(3) NOT NULL,
 "expiresAt" timestamp(3) NOT NULL,
 "revokedAt" timestamp(3),
 "lastError" text,
 "revision" integer NOT NULL DEFAULT 1,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL
);
CREATE INDEX "ProviderConnection_siteId_idx" ON "ProviderConnection"("siteId");
ALTER TABLE "ProviderConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "ProviderConnection" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "ProviderConnection" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "ProviderAccessGrant" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "providerId" text NOT NULL,
 "issuerUserId" text NOT NULL,
 "issuerSessionId" text NOT NULL,
 "grantee" jsonb NOT NULL,
 "actionVersionIds" text[] NOT NULL,
 "effects" text[] NOT NULL,
 "deviceLinkId" text,
 "expiresAt" timestamp(3) NOT NULL,
 "revokedAt" timestamp(3),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProviderAccessGrant_siteId_idx" ON "ProviderAccessGrant"("siteId");
ALTER TABLE "ProviderAccessGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderAccessGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "ProviderAccessGrant" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "ProviderAccessGrant" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "ConnectedDeviceLink" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "userId" text NOT NULL,
 "approvedByUserId" text NOT NULL,
 "deviceIds" text[] NOT NULL,
 "defaults" jsonb NOT NULL,
 "expiresAt" timestamp(3) NOT NULL,
 "revokedAt" timestamp(3),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ConnectedDeviceLink_siteId_idx" ON "ConnectedDeviceLink"("siteId");
ALTER TABLE "ConnectedDeviceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectedDeviceLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "ConnectedDeviceLink" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "ConnectedDeviceLink" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "WorkflowDefinitionRecord" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "name" text NOT NULL,
 "draft" jsonb NOT NULL,
 "revision" integer NOT NULL DEFAULT 1,
 "enabled" boolean NOT NULL DEFAULT true,
 "publishedVersionId" text,
 "createdByUserId" text NOT NULL,
 "updatedByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL
);
CREATE INDEX "WorkflowDefinitionRecord_siteId_idx" ON "WorkflowDefinitionRecord"("siteId");
ALTER TABLE "WorkflowDefinitionRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowDefinitionRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "WorkflowDefinitionRecord" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "WorkflowDefinitionRecord" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "WorkflowDefinitionVersion" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "definitionId" text NOT NULL,
 "version" integer NOT NULL,
 "definition" jsonb NOT NULL,
 "contentHash" text NOT NULL,
 "createdByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("definitionId","version")
);
CREATE INDEX "WorkflowDefinitionVersion_siteId_idx" ON "WorkflowDefinitionVersion"("siteId");
ALTER TABLE "WorkflowDefinitionVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowDefinitionVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "WorkflowDefinitionVersion" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "WorkflowDefinitionVersion" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "WorkflowRunRecord" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "definitionVersionId" text NOT NULL,
 "createdByUserId" text NOT NULL,
 "revision" integer NOT NULL,
 "status" text NOT NULL,
 "currentStepId" text,
 "snapshot" jsonb NOT NULL,
 "receivingState" jsonb,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL
);
CREATE INDEX "WorkflowRunRecord_siteId_idx" ON "WorkflowRunRecord"("siteId");
ALTER TABLE "WorkflowRunRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowRunRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "WorkflowRunRecord" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "WorkflowRunRecord" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "WorkflowRunEvent" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "runId" text NOT NULL,
 "actorUserId" text NOT NULL,
 "actorSessionId" text NOT NULL,
 "commandId" text NOT NULL,
 "kind" text NOT NULL,
 "detail" jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("runId","commandId")
);
CREATE INDEX "WorkflowRunEvent_siteId_idx" ON "WorkflowRunEvent"("siteId");
ALTER TABLE "WorkflowRunEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowRunEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "WorkflowRunEvent" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "WorkflowRunEvent" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE TABLE "WorkflowIntentRecord" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 "id" text NOT NULL PRIMARY KEY,
 "runId" text NOT NULL,
 "stepId" text NOT NULL,
 "attempt" integer NOT NULL,
 "state" text NOT NULL,
 "intent" jsonb NOT NULL,
 "result" jsonb,
 "revision" integer NOT NULL DEFAULT 1,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL,
 UNIQUE("runId","stepId","attempt")
);
CREATE INDEX "WorkflowIntentRecord_siteId_idx" ON "WorkflowIntentRecord"("siteId");
ALTER TABLE "WorkflowIntentRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowIntentRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "WorkflowIntentRecord" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "WorkflowIntentRecord" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
ALTER TABLE "IntegrationActionVersion" ADD CONSTRAINT "IntegrationActionVersion_actionId_fkey" FOREIGN KEY("actionId") REFERENCES "IntegrationActionRecord"("id");
ALTER TABLE "IntegrationActionRecord" ADD CONSTRAINT "IntegrationActionRecord_publishedVersionId_fkey" FOREIGN KEY("publishedVersionId") REFERENCES "IntegrationActionVersion"("id");
ALTER TABLE "ProviderAccessGrant" ADD CONSTRAINT "ProviderAccessGrant_providerId_fkey" FOREIGN KEY("providerId") REFERENCES "ProviderConnection"("id");
ALTER TABLE "ProviderAccessGrant" ADD CONSTRAINT "ProviderAccessGrant_deviceLinkId_fkey" FOREIGN KEY("deviceLinkId") REFERENCES "ConnectedDeviceLink"("id");
ALTER TABLE "WorkflowDefinitionVersion" ADD CONSTRAINT "WorkflowDefinitionVersion_definitionId_fkey" FOREIGN KEY("definitionId") REFERENCES "WorkflowDefinitionRecord"("id");
ALTER TABLE "WorkflowDefinitionRecord" ADD CONSTRAINT "WorkflowDefinitionRecord_publishedVersionId_fkey" FOREIGN KEY("publishedVersionId") REFERENCES "WorkflowDefinitionVersion"("id");
ALTER TABLE "WorkflowRunRecord" ADD CONSTRAINT "WorkflowRunRecord_definitionVersionId_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "WorkflowDefinitionVersion"("id");
ALTER TABLE "WorkflowRunEvent" ADD CONSTRAINT "WorkflowRunEvent_runId_fkey" FOREIGN KEY("runId") REFERENCES "WorkflowRunRecord"("id");
ALTER TABLE "WorkflowIntentRecord" ADD CONSTRAINT "WorkflowIntentRecord_runId_fkey" FOREIGN KEY("runId") REFERENCES "WorkflowRunRecord"("id");
CREATE FUNCTION public.temco_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'This published version or run event is immutable.' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "IntegrationActionVersion" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "WorkflowDefinitionVersion" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "WorkflowRunEvent" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO temco_runtime;
COMMIT;
