BEGIN;
CREATE TABLE "PlatformTemplateRecord" (
 "id" text PRIMARY KEY,"kind" text NOT NULL,"name" text NOT NULL,"draft" jsonb NOT NULL,
 "revision" integer NOT NULL DEFAULT 1,"enabled" boolean NOT NULL DEFAULT true,"publishedVersionId" text,
 "createdByUserId" text NOT NULL,"updatedByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamp(3) NOT NULL
);
CREATE TABLE "PlatformTemplateVersion" (
 "id" text PRIMARY KEY,"templateId" text NOT NULL REFERENCES "PlatformTemplateRecord"("id"),
 "version" integer NOT NULL,"payload" jsonb NOT NULL,"contentHash" text NOT NULL,"createdByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE("templateId","version")
);
ALTER TABLE "PlatformTemplateRecord" ADD CONSTRAINT "PlatformTemplateRecord_publishedVersionId_fkey" FOREIGN KEY("publishedVersionId") REFERENCES "PlatformTemplateVersion"("id");
CREATE TABLE "SiteTemplateBinding" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"("id"),
 "id" text PRIMARY KEY,"templateId" text NOT NULL REFERENCES "PlatformTemplateRecord"("id"),
 "versionId" text NOT NULL REFERENCES "PlatformTemplateVersion"("id"),"overrides" jsonb NOT NULL DEFAULT '{}',"materialized" jsonb NOT NULL,
 "revision" integer NOT NULL DEFAULT 1,"enabled" boolean NOT NULL DEFAULT true,
 "createdByUserId" text NOT NULL,"updatedByUserId" text NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" timestamp(3) NOT NULL,
 UNIQUE("siteId","templateId")
);
CREATE INDEX "SiteTemplateBinding_siteId_idx" ON "SiteTemplateBinding"("siteId");
CREATE FUNCTION public.temco_platform_template_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public."User" u JOIN public."UserSession" s ON s."userId"=u.id
 WHERE u.id=nullif(current_setting('temco.user_id',true),'') AND s.id=nullif(current_setting('temco.session_id',true),'')
 AND u."isActive" AND u."isPlatformAdmin" AND u."authVersion"=s."authVersion"
 AND s."authVersion"=nullif(current_setting('temco.auth_version',true),'')::integer
 AND s."revokedAt" IS NULL AND s."lockedAt" IS NULL AND s."expiresAt">now()
 AND s."lastActivityAt">now()-interval '30 minutes'
 AND s."lastStrongAuthenticatedAt">now()-interval '10 minutes' AND s."mfaVerifiedAt">now()-interval '10 minutes')
$$;
REVOKE ALL ON FUNCTION public.temco_platform_template_writer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.temco_platform_template_writer() TO temco_runtime;
ALTER TABLE "PlatformTemplateRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformTemplateRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY template_read ON "PlatformTemplateRecord" FOR SELECT USING(public.temco_site_authorized(nullif(current_setting('temco.site_id',true),'')));
CREATE POLICY template_insert ON "PlatformTemplateRecord" FOR INSERT WITH CHECK(public.temco_platform_template_writer());
CREATE POLICY template_update ON "PlatformTemplateRecord" FOR UPDATE USING(public.temco_platform_template_writer()) WITH CHECK(public.temco_platform_template_writer());
ALTER TABLE "PlatformTemplateVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformTemplateVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY template_read ON "PlatformTemplateVersion" FOR SELECT USING(public.temco_site_authorized(nullif(current_setting('temco.site_id',true),'')));
CREATE POLICY template_insert ON "PlatformTemplateVersion" FOR INSERT WITH CHECK(public.temco_platform_template_writer());
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "PlatformTemplateVersion" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
ALTER TABLE "SiteTemplateBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteTemplateBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON "SiteTemplateBinding" USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON "SiteTemplateBinding" FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links();
CREATE FUNCTION public.temco_template_source_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='PlatformTemplateRecord' AND NEW."publishedVersionId" IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public."PlatformTemplateVersion" WHERE id=NEW."publishedVersionId" AND "templateId"=NEW.id) THEN RAISE EXCEPTION 'Published template version belongs to another source.' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='SiteTemplateBinding' THEN
  IF NOT EXISTS(SELECT 1 FROM public."PlatformTemplateVersion" WHERE id=NEW."versionId" AND "templateId"=NEW."templateId") THEN RAISE EXCEPTION 'Template binding version belongs to another source.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER template_source_links BEFORE INSERT OR UPDATE ON "PlatformTemplateRecord" FOR EACH ROW EXECUTE FUNCTION public.temco_template_source_links();
CREATE TRIGGER template_source_links BEFORE INSERT OR UPDATE ON "SiteTemplateBinding" FOR EACH ROW EXECUTE FUNCTION public.temco_template_source_links();
GRANT SELECT,INSERT,UPDATE,DELETE ON "PlatformTemplateRecord","PlatformTemplateVersion","SiteTemplateBinding" TO temco_runtime;
COMMIT;
