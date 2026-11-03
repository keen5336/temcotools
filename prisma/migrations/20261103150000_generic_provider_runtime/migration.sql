BEGIN;
ALTER TABLE "SiteProfile" DROP CONSTRAINT "SiteProfile_known_purpose";
ALTER TABLE "SiteProfile" ADD CONSTRAINT "SiteProfile_known_purpose" CHECK (purpose IN ('dmp_relay','mars_label_helper','route_planner_relay','integration_relay'));
CREATE TABLE "ProviderRuntimeConfiguration" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 id text PRIMARY KEY,"providerId" text NOT NULL REFERENCES "ProviderConnection"(id),"integrationId" text NOT NULL,audience text NOT NULL,
 configuration jsonb NOT NULL,"contentHash" text NOT NULL,"reviewedByUserId" text NOT NULL REFERENCES "User"(id),"createdAt" timestamp(3) NOT NULL DEFAULT now(),UNIQUE(id,"providerId")
);
CREATE TABLE "ProviderActivation" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 id text PRIMARY KEY,"providerId" text NOT NULL REFERENCES "ProviderConnection"(id),"configurationId" text NOT NULL,"ownerUserId" text NOT NULL REFERENCES "User"(id),"ownerSessionId" text NOT NULL REFERENCES "UserSession"(id),"ownerAuthVersion" integer NOT NULL,"deviceId" text NOT NULL,"tabId" text NOT NULL,audience text NOT NULL,"expiresAt" timestamp(3) NOT NULL,"revokedAt" timestamp(3),"createdAt" timestamp(3) NOT NULL DEFAULT now(),UNIQUE(id,"providerId"),FOREIGN KEY("configurationId","providerId") REFERENCES "ProviderRuntimeConfiguration"(id,"providerId")
);
ALTER TABLE "ProviderConnection" ADD COLUMN "runtimeConfigurationId" text REFERENCES "ProviderRuntimeConfiguration"(id),ADD COLUMN "runtimeActivationId" text REFERENCES "ProviderActivation"(id);
CREATE TABLE "IntegrationOperation" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 id text PRIMARY KEY,"operationId" text NOT NULL,"providerId" text NOT NULL REFERENCES "ProviderConnection"(id),"activationId" text NOT NULL,"actorUserId" text NOT NULL REFERENCES "User"(id),"actorSessionId" text NOT NULL REFERENCES "UserSession"(id),"actorGrantId" text,"actionVersionId" text NOT NULL REFERENCES "IntegrationActionVersion"(id),fingerprint text NOT NULL,snapshot jsonb NOT NULL,"reportTokenHash" text NOT NULL CHECK("reportTokenHash" ~ '^[a-f0-9]{64}$'),state text NOT NULL CHECK(state IN ('queued','dispatching','reported','not_sent','cancelled','unknown')),revision integer NOT NULL DEFAULT 1,"requestId" text,result jsonb,"settledAt" timestamp(3),"createdAt" timestamp(3) NOT NULL DEFAULT now(),"updatedAt" timestamp(3) NOT NULL,UNIQUE("siteId","operationId"),FOREIGN KEY("activationId","providerId") REFERENCES "ProviderActivation"(id,"providerId")
);
CREATE TABLE "IntegrationOperationEvidence" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),'') REFERENCES "WarehouseSite"(id),
 id text PRIMARY KEY,"operationRecordId" text NOT NULL REFERENCES "IntegrationOperation"(id),"dedupeKey" text NOT NULL,evidence jsonb NOT NULL,"createdAt" timestamp(3) NOT NULL DEFAULT now(),UNIQUE("operationRecordId","dedupeKey")
);
CREATE INDEX "ProviderRuntimeConfiguration_siteId_providerId_idx" ON "ProviderRuntimeConfiguration"("siteId","providerId");
CREATE INDEX "ProviderActivation_siteId_providerId_idx" ON "ProviderActivation"("siteId","providerId");
CREATE UNIQUE INDEX "IntegrationOperation_one_dispatching_provider_idx" ON "IntegrationOperation"("siteId","providerId") WHERE state='dispatching';
CREATE INDEX "IntegrationOperation_siteId_providerId_state_idx" ON "IntegrationOperation"("siteId","providerId",state);
CREATE INDEX "IntegrationOperationEvidence_siteId_operationRecordId_idx" ON "IntegrationOperationEvidence"("siteId","operationRecordId");
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['ProviderRuntimeConfiguration','ProviderActivation','IntegrationOperation','IntegrationOperationEvidence'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY warehouse_isolation ON %I USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"))',tab);
 EXECUTE format('CREATE TRIGGER warehouse_links BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.temco_same_site_links()',tab);
 END LOOP; END $$;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "ProviderRuntimeConfiguration" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "IntegrationOperationEvidence" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();
CREATE FUNCTION public.temco_activation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revokedAt') IS DISTINCT FROM (to_jsonb(OLD)-'revokedAt') OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN RAISE EXCEPTION 'Activation identity/configuration pins are immutable.' USING ERRCODE='23514';END IF;RETURN NEW; END $$;
CREATE TRIGGER activation_immutable BEFORE UPDATE OR DELETE ON "ProviderActivation" FOR EACH ROW EXECUTE FUNCTION public.temco_activation_immutable();
CREATE FUNCTION public.temco_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','revision','requestId','result','settledAt','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','requestId','result','settledAt','updatedAt']) THEN RAISE EXCEPTION 'Operation identity/request pins are immutable.' USING ERRCODE='23514';END IF;
 IF NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='queued' AND NEW.state IN ('dispatching','cancelled','not_sent')) OR (OLD.state='dispatching' AND NEW.state IN ('reported','not_sent','unknown'))) OR (OLD."requestId" IS NOT NULL AND NEW."requestId" IS DISTINCT FROM OLD."requestId") OR (NEW.state='dispatching' AND NEW."requestId" IS NULL) THEN RAISE EXCEPTION 'Operation transition/revision is not permitted.' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER operation_immutable BEFORE UPDATE OR DELETE ON "IntegrationOperation" FOR EACH ROW EXECUTE FUNCTION public.temco_operation_immutable();
-- This is a per-operation read/terminal-report capability, never dispatch authority.
-- The server derives an unguessable token from its private purpose-separated key;
-- only its digest is stored. No user/role/site impersonation is performed here.
CREATE FUNCTION public.temco_integration_report(p_site text,p_operation text,p_token text,p_mode text,p_revision integer DEFAULT NULL,p_provider text DEFAULT NULL,p_nonce text DEFAULT NULL,p_request text DEFAULT NULL,p_state text DEFAULT NULL,p_result jsonb DEFAULT NULL,p_dedupe text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op public."IntegrationOperation"%ROWTYPE; result_row jsonb; evidence_count integer;
BEGIN
 IF p_token IS NULL OR length(p_token)<>43 OR p_mode NOT IN ('get','settle','evidence') THEN RETURN NULL;END IF;
 SELECT * INTO op FROM public."IntegrationOperation" WHERE "siteId"=p_site AND "operationId"=p_operation AND "reportTokenHash"=encode(sha256(convert_to(p_token,'UTF8')),'hex') FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF p_mode='get' THEN RETURN (to_jsonb(op)-'reportTokenHash');END IF;
 IF p_provider IS DISTINCT FROM op."providerId" OR p_nonce IS DISTINCT FROM (op.snapshot->>'connectionNonce') OR p_request IS DISTINCT FROM op."requestId" OR p_result IS NULL OR octet_length(p_result::text)>26214400 THEN RETURN NULL;END IF;
 IF p_mode='settle' THEN
  IF op.revision=p_revision AND ((op.state='queued' AND p_state IN ('cancelled','not_sent')) OR (op.state='dispatching' AND p_state IN ('reported','not_sent','unknown'))) THEN
   UPDATE public."IntegrationOperation" SET state=p_state,result=p_result,revision=revision+1,"settledAt"=now(),"updatedAt"=now() WHERE id=op.id RETURNING * INTO op;
  END IF;
  RETURN to_jsonb(op)-'reportTokenHash';
 END IF;
 IF p_dedupe IS NULL OR p_dedupe !~ '^[a-f0-9]{64}$' OR op.state IN ('queued','dispatching') THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM public."IntegrationOperationEvidence" WHERE "operationRecordId"=op.id AND "dedupeKey"=p_dedupe) THEN RETURN jsonb_build_object('retained',true);END IF;
 SELECT count(*) INTO evidence_count FROM public."IntegrationOperationEvidence" WHERE "operationRecordId"=op.id;
 IF evidence_count>=4 THEN RETURN jsonb_build_object('retained',false);END IF;
 INSERT INTO public."IntegrationOperationEvidence"(id,"siteId","operationRecordId","dedupeKey",evidence) VALUES(md5(random()::text||clock_timestamp()::text),op."siteId",op.id,p_dedupe,p_result);
 RETURN jsonb_build_object('retained',true);
END $$;
REVOKE ALL ON FUNCTION public.temco_integration_report(text,text,text,text,integer,text,text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.temco_integration_report(text,text,text,text,integer,text,text,text,text,jsonb,text) TO temco_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON "ProviderRuntimeConfiguration","ProviderActivation","IntegrationOperation","IntegrationOperationEvidence" TO temco_runtime;
COMMIT;
