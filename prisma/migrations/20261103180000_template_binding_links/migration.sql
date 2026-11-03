BEGIN;
-- The shared trigger receives two different row types. Resolve table-specific
-- NEW fields only inside the matching PL/pgSQL branch (SQL AND cannot guard
-- resolution of a field absent from the other record type).
CREATE OR REPLACE FUNCTION public.temco_template_source_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='PlatformTemplateRecord' THEN
  IF NEW."publishedVersionId" IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public."PlatformTemplateVersion" WHERE id=NEW."publishedVersionId" AND "templateId"=NEW.id) THEN RAISE EXCEPTION 'Published template version belongs to another source.' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='SiteTemplateBinding' THEN
  IF NOT EXISTS(SELECT 1 FROM public."PlatformTemplateVersion" WHERE id=NEW."versionId" AND "templateId"=NEW."templateId") THEN RAISE EXCEPTION 'Template binding version belongs to another source.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
