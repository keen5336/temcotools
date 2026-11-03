BEGIN;
-- Stable identity is shared only through explicit participation. Private origin,
-- identifier evidence and all existing operational history remain site scoped.
CREATE TABLE "WarehouseUnitOrigin" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),''), "unitId" text PRIMARY KEY,
 "createdByUserId" text, "creationEvidence" text, "creationFingerprint" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("siteId") REFERENCES "WarehouseSite"(id), FOREIGN KEY("unitId") REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE "WarehouseUnitSite" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),''), "unitId" text NOT NULL,
 phase text NOT NULL DEFAULT 'unestablished', "holdsCustody" boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 "transferId" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("siteId","unitId"), FOREIGN KEY("siteId") REFERENCES "WarehouseSite"(id), FOREIGN KEY("unitId") REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK(phase IN ('unestablished','expected','in_transit','checked_in','departed','cancelled_expected')), CHECK(revision>0), CHECK(NOT "holdsCustody" OR phase='checked_in')
);
CREATE UNIQUE INDEX "WarehouseUnitSite_one_custodian" ON "WarehouseUnitSite"("unitId") WHERE "holdsCustody";
CREATE TABLE "WarehouseUnitAlias" (
 id text PRIMARY KEY, "unitId" text NOT NULL REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT,
 kind text NOT NULL, namespace text NOT NULL, value text NOT NULL, "revokedAt" timestamp(3), revision integer NOT NULL DEFAULT 1, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(kind IN ('lpn','msn','serial','submission')), CHECK(revision>0)
);
CREATE INDEX "WarehouseUnitAlias_kind_namespace_value_revokedAt_idx" ON "WarehouseUnitAlias"(kind,namespace,value,"revokedAt");
CREATE TABLE "WarehouseUnitAliasVisibility" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),''), "aliasId" text NOT NULL REFERENCES "WarehouseUnitAlias"(id) ON DELETE RESTRICT,
 "transferId" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("siteId","aliasId"), FOREIGN KEY("siteId") REFERENCES "WarehouseSite"(id)
);
CREATE TABLE "WarehouseUnitTransfer" (
 id text PRIMARY KEY, "unitId" text NOT NULL REFERENCES "WarehouseUnit"(id) ON DELETE RESTRICT,
 "sourceSiteId" text NOT NULL REFERENCES "WarehouseSite"(id), "destinationSiteId" text NOT NULL REFERENCES "WarehouseSite"(id),
 state text NOT NULL DEFAULT 'proposed', revision integer NOT NULL DEFAULT 1, "aliasIds" jsonb NOT NULL, handoff jsonb NOT NULL,
 "proposedByUserId" text NOT NULL, "acceptedByUserId" text, "departedByUserId" text, "checkedInByUserId" text, "cancelledByUserId" text,
 "departureObservationId" text REFERENCES "WarehousePhysicalObservation"(id), "checkInObservationId" text REFERENCES "WarehousePhysicalObservation"(id),
 "acceptedAt" timestamp(3), "departedAt" timestamp(3), "checkedInAt" timestamp(3), "cancelledAt" timestamp(3),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK("sourceSiteId"<>"destinationSiteId"), CHECK(state IN ('proposed','accepted','departed','checked_in','cancelled')), CHECK(revision>0), CHECK(jsonb_typeof("aliasIds")='array' AND jsonb_array_length("aliasIds") BETWEEN 1 AND 50), CHECK(jsonb_typeof(handoff)='object')
);
CREATE UNIQUE INDEX "WarehouseUnitTransfer_one_open" ON "WarehouseUnitTransfer"("unitId") WHERE state IN ('proposed','accepted','departed');
CREATE INDEX "WarehouseUnitTransfer_sourceSiteId_state_createdAt_idx" ON "WarehouseUnitTransfer"("sourceSiteId",state,"createdAt");
CREATE INDEX "WarehouseUnitTransfer_destinationSiteId_state_createdAt_idx" ON "WarehouseUnitTransfer"("destinationSiteId",state,"createdAt");
CREATE TABLE "WarehouseUnitTransferEvent" (
 "siteId" text NOT NULL DEFAULT nullif(current_setting('temco.site_id',true),''), id text PRIMARY KEY,
 "transferId" text NOT NULL REFERENCES "WarehouseUnitTransfer"(id) ON DELETE RESTRICT,
 "actorUserId" text NOT NULL, "actorSessionId" text NOT NULL, "operationId" text NOT NULL, kind text NOT NULL, fingerprint text NOT NULL, detail jsonb NOT NULL, result jsonb NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("siteId","actorUserId","operationId"), FOREIGN KEY("siteId") REFERENCES "WarehouseSite"(id)
);
CREATE INDEX "WarehouseUnitTransferEvent_siteId_transferId_createdAt_idx" ON "WarehouseUnitTransferEvent"("siteId","transferId","createdAt");

INSERT INTO "WarehouseUnitOrigin"("siteId","unitId","createdByUserId","creationEvidence","creationFingerprint","createdAt") SELECT "siteId",id,"createdByUserId","creationEvidence","creationFingerprint","createdAt" FROM "WarehouseUnit";
INSERT INTO "WarehouseUnitSite"("siteId","unitId") SELECT "siteId",id FROM "WarehouseUnit";
INSERT INTO "WarehouseUnitAlias"(id,"unitId",kind,namespace,value,"revokedAt","createdAt") SELECT id,"unitId",kind,namespace,value,"revokedAt","createdAt" FROM "WarehouseIdentifier";
INSERT INTO "WarehouseUnitAliasVisibility"("siteId","aliasId") SELECT "siteId",id FROM "WarehouseIdentifier";
UPDATE "WarehouseUnit" SET "createdByUserId"=NULL,"creationEvidence"=NULL,"creationFingerprint"=NULL;
-- Drain backfill FK events before ALTER TABLE/ENABLE RLS on populated upgrades.
-- This changes only this migration transaction, not runtime FK defaults.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "WarehouseUnit" ADD CONSTRAINT "WarehouseUnit_private_origin_separate" CHECK("createdByUserId" IS NULL AND "creationEvidence" IS NULL AND "creationFingerprint" IS NULL);
DROP INDEX "InventoryAuditItem_lpn_key";
CREATE UNIQUE INDEX "InventoryAuditItem_siteId_lpn_key" ON "InventoryAuditItem"("siteId",lpn);
UPDATE "WarehouseRole" SET capabilities=array_append(capabilities,'inventory.custody') WHERE id='warehouse-manager' AND NOT ('inventory.custody'=ANY(capabilities));

CREATE FUNCTION public.temco_custody_authorized() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.temco_site_authorized(nullif(current_setting('temco.site_id',true),'')) AND EXISTS(
 SELECT 1 FROM public."User" u WHERE u.id=nullif(current_setting('temco.user_id',true),'') AND u."isActive" AND
 (u."isPlatformAdmin" OR EXISTS(SELECT 1 FROM public."WarehouseMembership" m JOIN public."WarehouseMembershipRole" mr ON mr."membershipId"=m.id JOIN public."WarehouseRole" r ON r.id=mr."roleId" WHERE m."userId"=u.id AND m."siteId"=nullif(current_setting('temco.site_id',true),'') AND m."isActive" AND r."isActive" AND (r."siteId" IS NULL OR r."siteId"=m."siteId") AND 'inventory.custody'=ANY(r.capabilities))))
$$;
CREATE FUNCTION public.temco_unit_visible(unit_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.temco_site_authorized(nullif(current_setting('temco.site_id',true),'')) AND EXISTS(SELECT 1 FROM public."WarehouseUnitSite" p WHERE p."unitId"=unit_id AND p."siteId"=nullif(current_setting('temco.site_id',true),''))
$$;
CREATE FUNCTION public.temco_alias_visible(alias_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.temco_site_authorized(nullif(current_setting('temco.site_id',true),'')) AND EXISTS(SELECT 1 FROM public."WarehouseUnitAliasVisibility" v WHERE v."aliasId"=alias_id AND v."siteId"=nullif(current_setting('temco.site_id',true),''))
$$;
-- A known destination may be validated without exposing memberships or another
-- site's data. The ordinary selector lists only the person's own memberships.
CREATE FUNCTION public.temco_custody_destination(destination_id text) RETURNS TABLE(id text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT w.id,w.name FROM public."WarehouseSite" w WHERE w.id=destination_id AND w."isActive" AND public.temco_custody_authorized()
$$;
-- Importers get only an already-visible exact identity or a non-identifying
-- conflict flag. A foreign matching LPN never grants identity visibility.
CREATE FUNCTION public.temco_custody_import_identity(lpn_value text) RETURNS TABLE("unitId" text,conflict boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH matches AS (SELECT a."unitId",EXISTS(SELECT 1 FROM public."WarehouseUnitAliasVisibility" v WHERE v."aliasId"=a.id AND v."siteId"=nullif(current_setting('temco.site_id',true),'')) AS allowed FROM public."WarehouseUnitAlias" a WHERE a.kind='lpn' AND a.namespace='wms' AND a.value=upper(trim(lpn_value)) AND a."revokedAt" IS NULL AND public.temco_site_authorized(nullif(current_setting('temco.site_id',true),''))), totals AS (SELECT count(DISTINCT "unitId") AS n,count(DISTINCT "unitId") FILTER(WHERE allowed) AS permitted,min("unitId") FILTER(WHERE allowed) AS selected FROM matches)
 SELECT CASE WHEN n=1 AND permitted=1 THEN selected ELSE NULL END, n>0 AND (n<>1 OR permitted<>1) FROM totals
$$;
DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY ARRAY['temco_custody_authorized()','temco_unit_visible(text)','temco_alias_visible(text)','temco_custody_destination(text)','temco_custody_import_identity(text)'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC'; EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||f||' TO temco_runtime'; END LOOP; END $$;

DROP POLICY warehouse_isolation ON "WarehouseUnit";
CREATE POLICY unit_identity_read ON "WarehouseUnit" FOR SELECT USING(public.temco_site_authorized("siteId") OR public.temco_unit_visible(id));
CREATE POLICY unit_identity_insert ON "WarehouseUnit" FOR INSERT WITH CHECK(public.temco_site_authorized("siteId"));
CREATE POLICY unit_identity_update ON "WarehouseUnit" FOR UPDATE USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['WarehouseUnitOrigin','WarehouseUnitSite','WarehouseUnitAliasVisibility','WarehouseUnitTransferEvent'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY warehouse_isolation ON %I USING(public.temco_site_authorized("siteId")) WITH CHECK(public.temco_site_authorized("siteId"))',t);
 END LOOP; END $$;
ALTER TABLE "WarehouseUnitAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarehouseUnitAlias" FORCE ROW LEVEL SECURITY;
CREATE POLICY alias_identity_read ON "WarehouseUnitAlias" FOR SELECT USING(public.temco_alias_visible(id));
ALTER TABLE "WarehouseUnitTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarehouseUnitTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY custody_transfer ON "WarehouseUnitTransfer" USING(public.temco_site_authorized("sourceSiteId") OR public.temco_site_authorized("destinationSiteId")) WITH CHECK(public.temco_custody_authorized() AND (public.temco_site_authorized("sourceSiteId") OR public.temco_site_authorized("destinationSiteId")));
-- Only narrow triggers own identity visibility/participation. Runtime services
-- can read private origin, never insert/update/delete those projections directly.
REVOKE INSERT,UPDATE,DELETE ON "WarehouseUnitOrigin","WarehouseUnitSite","WarehouseUnitAlias","WarehouseUnitAliasVisibility" FROM temco_runtime;
REVOKE DELETE ON "WarehouseUnitTransfer","WarehouseIdentifier" FROM temco_runtime;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "WarehouseUnitTransferEvent" FOR EACH ROW EXECUTE FUNCTION public.temco_immutable_record();

CREATE FUNCTION public.temco_unit_origin_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF current_setting('role',true)='temco_runtime' AND NOT public.temco_site_authorized(NEW."siteId") THEN RAISE EXCEPTION 'Current warehouse authority is required.' USING ERRCODE='42501'; END IF;
  INSERT INTO public."WarehouseUnitOrigin"("siteId","unitId","createdByUserId","creationEvidence","creationFingerprint","createdAt") VALUES(NEW."siteId",NEW.id,NEW."createdByUserId",NEW."creationEvidence",NEW."creationFingerprint",NEW."createdAt") ON CONFLICT("unitId") DO NOTHING;
 ELSE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW."siteId" IS DISTINCT FROM OLD."siteId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."createdByUserId" IS NOT NULL OR NEW."creationEvidence" IS NOT NULL OR NEW."creationFingerprint" IS NOT NULL THEN RAISE EXCEPTION 'Physical identity and private origin are immutable.' USING ERRCODE='23514'; END IF;
 END IF;
 NEW."createdByUserId":=NULL; NEW."creationEvidence":=NULL; NEW."creationFingerprint":=NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_origin_before BEFORE INSERT OR UPDATE ON "WarehouseUnit" FOR EACH ROW EXECUTE FUNCTION public.temco_unit_origin_before();
CREATE FUNCTION public.temco_unit_participation_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN INSERT INTO public."WarehouseUnitSite"("siteId","unitId") VALUES(NEW."siteId",NEW.id); RETURN NEW; END $$;
CREATE TRIGGER custody_participation_after AFTER INSERT ON "WarehouseUnit" FOR EACH ROW EXECUTE FUNCTION public.temco_unit_participation_after();
CREATE FUNCTION public.temco_unit_alias_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(8100801);
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW."unitId" IS DISTINCT FROM OLD."unitId" OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.value IS DISTINCT FROM OLD.value THEN RAISE EXCEPTION 'Revoke and explicitly link an alias instead of rewriting its identity.' USING ERRCODE='23514'; END IF;
  UPDATE public."WarehouseUnitAlias" SET "revokedAt"=NEW."revokedAt",revision=revision+1 WHERE id=NEW.id;
 ELSE
  INSERT INTO public."WarehouseUnitAlias"(id,"unitId",kind,namespace,value,"revokedAt","createdAt") VALUES(NEW.id,NEW."unitId",NEW.kind,NEW.namespace,NEW.value,NEW."revokedAt",NEW."createdAt");
  INSERT INTO public."WarehouseUnitAliasVisibility"("siteId","aliasId") VALUES(NEW."siteId",NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_alias_after AFTER INSERT OR UPDATE ON "WarehouseIdentifier" FOR EACH ROW EXECUTE FUNCTION public.temco_unit_alias_after();
-- Preserve normal same-site FKs, replacing only the identity parent check with
-- explicit current-site participation. Old operational children never move.
CREATE OR REPLACE FUNCTION public.temco_same_site_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link record; parent_site text; value_text text;
BEGIN
 IF TG_OP='UPDATE' AND NEW."siteId" IS DISTINCT FROM OLD."siteId" THEN RAISE EXCEPTION 'Warehouse scope is immutable; use an explicit custody transfer.' USING ERRCODE='23514'; END IF;
 FOR link IN SELECT c.confrelid::regclass AS parent,a.attname AS child_column,b.attname AS parent_column FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[1] WHERE c.conrelid=TG_RELID AND c.contype='f' AND array_length(c.conkey,1)=1 AND EXISTS(SELECT 1 FROM pg_attribute x WHERE x.attrelid=c.confrelid AND x.attname='siteId' AND NOT x.attisdropped) LOOP
  value_text:=to_jsonb(NEW)->>link.child_column;
  IF value_text IS NOT NULL THEN
   IF link.parent='public."WarehouseUnit"'::regclass THEN
    IF NOT EXISTS(SELECT 1 FROM public."WarehouseUnitSite" p WHERE p."unitId"=value_text AND p."siteId"=NEW."siteId") THEN RAISE EXCEPTION 'Physical identity is not associated with this warehouse.' USING ERRCODE='23514'; END IF;
   ELSE
    EXECUTE format('SELECT "siteId" FROM %s WHERE %I::text=$1',link.parent,link.parent_column) INTO parent_site USING value_text;
    IF parent_site IS DISTINCT FROM NEW."siteId" THEN RAISE EXCEPTION 'Related records must belong to the same warehouse.' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;

CREATE FUNCTION public.temco_custody_transfer_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE here text:=nullif(current_setting('temco.site_id',true),''); person text:=nullif(current_setting('temco.user_id',true),''); invalid_alias boolean; observation_ok boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(8100801);
 PERFORM pg_advisory_xact_lock(hashtextextended('custody-unit:'||NEW."unitId",817));
 IF current_setting('role',true)='temco_runtime' AND NOT public.temco_custody_authorized() THEN RAISE EXCEPTION 'Current custody permission is required.' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'proposed' OR NEW.revision<>1 OR NEW."sourceSiteId" IS DISTINCT FROM here OR NEW."proposedByUserId" IS DISTINCT FROM person THEN RAISE EXCEPTION 'Propose from the authorized source warehouse.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public."WarehouseUnitSite" p WHERE p."unitId"=NEW."unitId" AND p."siteId"=here AND p.phase IN ('unestablished','checked_in')) OR EXISTS(SELECT 1 FROM public."WarehouseUnitSite" p WHERE p."unitId"=NEW."unitId" AND p."holdsCustody" AND p."siteId"<>here) THEN RAISE EXCEPTION 'This warehouse cannot propose custody for this unit.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public."WarehouseSite" WHERE id=NEW."destinationSiteId" AND "isActive") THEN RAISE EXCEPTION 'Destination warehouse is unavailable.' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW."unitId"<>OLD."unitId" OR NEW."sourceSiteId"<>OLD."sourceSiteId" OR NEW."destinationSiteId"<>OLD."destinationSiteId" OR NEW."aliasIds"<>OLD."aliasIds" OR NEW.handoff<>OLD.handoff OR NEW."proposedByUserId"<>OLD."proposedByUserId" OR NEW."createdAt"<>OLD."createdAt" OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Transfer identity, handoff and revision are pinned.' USING ERRCODE='23514'; END IF;
  IF OLD.state<>'proposed' AND (NEW."acceptedByUserId" IS DISTINCT FROM OLD."acceptedByUserId" OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt") THEN RAISE EXCEPTION 'Accepted custody decision is immutable.' USING ERRCODE='23514'; END IF;
  IF OLD.state='departed' AND (NEW."departureObservationId" IS DISTINCT FROM OLD."departureObservationId" OR NEW."departedAt" IS DISTINCT FROM OLD."departedAt" OR NEW."departedByUserId" IS DISTINCT FROM OLD."departedByUserId") THEN RAISE EXCEPTION 'Departure evidence is immutable.' USING ERRCODE='23514'; END IF;
  IF NEW.state='accepted' AND OLD.state='proposed' THEN
   IF here<>NEW."destinationSiteId" OR NEW."acceptedByUserId" IS DISTINCT FROM person OR NEW."acceptedAt" IS NULL THEN RAISE EXCEPTION 'Current destination acceptance is required.' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='departed' AND OLD.state='accepted' THEN
   IF here<>NEW."sourceSiteId" OR NEW."departedByUserId" IS DISTINCT FROM person OR NEW."departureObservationId" IS NULL OR NEW."departedAt" IS NULL THEN RAISE EXCEPTION 'Source departure evidence is required.' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM public."DispatchReservation" WHERE "unitId"=NEW."unitId") THEN RAISE EXCEPTION 'Release active dispatch reservation before departure.' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM public."LabelIssuance" WHERE "siteId"=here AND "unitId"=NEW."unitId" AND state NOT IN ('not_sent','verified_not_printed','print_confirmed','applied','cancelled')) THEN RAISE EXCEPTION 'Reconcile or cancel unresolved label work before departure.' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM public."MarsSubmissionIntent" WHERE "siteId"=here AND "unitId"=NEW."unitId" AND state IN ('prepared','in_progress','unknown')) THEN RAISE EXCEPTION 'Reconcile unfinished MARS work before departure.' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='checked_in' AND OLD.state='departed' THEN
   IF here<>NEW."destinationSiteId" OR NEW."checkedInByUserId" IS DISTINCT FROM person OR NEW."checkInObservationId" IS NULL OR NEW."checkedInAt" IS NULL THEN RAISE EXCEPTION 'Current destination check-in evidence is required.' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT 1 FROM public."WarehouseUnitSite" WHERE "unitId"=NEW."unitId" AND "holdsCustody" AND "siteId"<>here) THEN RAISE EXCEPTION 'Conflicting custody must be reconciled.' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='cancelled' AND OLD.state IN ('proposed','accepted') THEN
   IF here NOT IN (NEW."sourceSiteId",NEW."destinationSiteId") OR NEW."cancelledByUserId" IS DISTINCT FROM person OR NEW."cancelledAt" IS NULL THEN RAISE EXCEPTION 'Current participating warehouse authority is required to cancel.' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Invalid custody transition; departed work cannot be cancelled or replayed.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.state<>'cancelled' THEN
  IF NOT EXISTS(SELECT 1 FROM public."WarehouseSite" WHERE id=NEW."destinationSiteId" AND "isActive") THEN RAISE EXCEPTION 'Destination warehouse is unavailable.' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset(NEW."aliasIds") AS pin(id text,revision integer) LEFT JOIN public."WarehouseUnitAlias" a ON a.id=pin.id LEFT JOIN public."WarehouseUnitAliasVisibility" v ON v."aliasId"=a.id AND v."siteId"=NEW."sourceSiteId" WHERE a.id IS NULL OR a."unitId"<>NEW."unitId" OR a.revision<>pin.revision OR a."revokedAt" IS NOT NULL OR v."aliasId" IS NULL) INTO invalid_alias;
  IF invalid_alias THEN RAISE EXCEPTION 'Pinned transfer aliases changed; review identity before proceeding.' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.state IN ('departed','checked_in') THEN
  SELECT EXISTS(SELECT 1 FROM public."WarehousePhysicalObservation" o LEFT JOIN LATERAL(SELECT c.id,c."unitId" FROM public."WarehouseObservationCorrection" c WHERE c."observationId"=o.id ORDER BY c.revision DESC LIMIT 1) c ON true WHERE o.id=CASE WHEN NEW.state='departed' THEN NEW."departureObservationId" ELSE NEW."checkInObservationId" END AND o."siteId"=here AND CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=NEW."unitId" AND o.resolution='resolved' AND o.type=CASE WHEN NEW.state='departed' THEN 'departure' ELSE 'check_in' END AND o."capturedAt">=CASE WHEN NEW.state='departed' THEN NEW."acceptedAt" ELSE NEW."departedAt" END AND o."capturedAt"<=now()+interval '5 minutes' AND EXISTS(SELECT 1 FROM jsonb_to_recordset(NEW."aliasIds") AS pin(id text,revision integer) JOIN public."WarehouseUnitAlias" a ON a.id=pin.id WHERE a.value=upper(trim(o."rawIdentifier")) AND (o."identifierType"='auto' OR o."identifierType"=a.kind) AND (o."identifierNamespace" IS NULL OR o."identifierNamespace"=a.namespace))) INTO observation_ok;
  IF NOT observation_ok THEN RAISE EXCEPTION 'Independent exact-unit physical observation is required.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_transition_before BEFORE INSERT OR UPDATE ON "WarehouseUnitTransfer" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_transfer_before();
CREATE FUNCTION public.temco_custody_transfer_after() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.state='accepted' THEN
   INSERT INTO public."WarehouseUnitSite"("siteId","unitId",phase,"transferId") VALUES(NEW."destinationSiteId",NEW."unitId",'expected',NEW.id) ON CONFLICT("siteId","unitId") DO UPDATE SET phase='expected',"transferId"=EXCLUDED."transferId",revision="WarehouseUnitSite".revision+1,"updatedAt"=now();
   INSERT INTO public."WarehouseUnitAliasVisibility"("siteId","aliasId","transferId") SELECT NEW."destinationSiteId",pin.id,NEW.id FROM jsonb_to_recordset(NEW."aliasIds") AS pin(id text,revision integer) ON CONFLICT DO NOTHING;
  ELSIF NEW.state='departed' THEN
   UPDATE public."WarehouseUnitSite" SET phase='departed',"holdsCustody"=false,"transferId"=NEW.id,revision=revision+1,"updatedAt"=now() WHERE "siteId"=NEW."sourceSiteId" AND "unitId"=NEW."unitId";
   UPDATE public."WarehouseUnitSite" SET phase='in_transit',revision=revision+1,"updatedAt"=now() WHERE "siteId"=NEW."destinationSiteId" AND "unitId"=NEW."unitId";
  ELSIF NEW.state='checked_in' THEN
   UPDATE public."WarehouseUnitSite" SET phase='checked_in',"holdsCustody"=true,"transferId"=NEW.id,revision=revision+1,"updatedAt"=now() WHERE "siteId"=NEW."destinationSiteId" AND "unitId"=NEW."unitId";
  ELSIF NEW.state='cancelled' THEN
   UPDATE public."WarehouseUnitSite" SET phase='cancelled_expected',revision=revision+1,"updatedAt"=now() WHERE "siteId"=NEW."destinationSiteId" AND "unitId"=NEW."unitId" AND "transferId"=NEW.id AND phase='expected';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_transition_after AFTER INSERT OR UPDATE ON "WarehouseUnitTransfer" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_transfer_after();
-- Coordinate native future effects with the same unit lock; reconciliation of
-- existing effects remains possible after movement, but new work cannot follow.
CREATE FUNCTION public.temco_custody_effect_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE is_new_work boolean:=false;
BEGIN
 IF NEW."unitId" IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='LabelIssuance' THEN is_new_work:=NEW.state IN ('queued','dispatching');
 ELSIF TG_TABLE_NAME='MarsSubmissionIntent' THEN is_new_work:=NEW.state IN ('prepared','in_progress');
 ELSIF TG_TABLE_NAME='DispatchReservation' THEN is_new_work:=true;
 END IF;
 IF is_new_work THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('custody-unit:'||NEW."unitId",817));
  IF NOT EXISTS(SELECT 1 FROM public."WarehouseUnitSite" p WHERE p."siteId"=NEW."siteId" AND p."unitId"=NEW."unitId" AND p.phase IN ('unestablished','checked_in')) THEN RAISE EXCEPTION 'Unit custody does not permit new operational work at this warehouse.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_effect_before BEFORE INSERT OR UPDATE ON "LabelIssuance" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_effect_before();
CREATE TRIGGER custody_effect_before BEFORE INSERT OR UPDATE ON "MarsSubmissionIntent" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_effect_before();
CREATE TRIGGER custody_effect_before BEFORE INSERT OR UPDATE ON "DispatchReservation" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_effect_before();
CREATE FUNCTION public.temco_custody_observation_correction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public."WarehouseUnitTransfer" t WHERE (t."departureObservationId"=NEW."observationId" OR t."checkInObservationId"=NEW."observationId") AND NEW."unitId" IS DISTINCT FROM t."unitId") THEN RAISE EXCEPTION 'Custody-bound evidence requires explicit custody reconciliation, not an identity rewrite.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_evidence_before BEFORE INSERT ON "WarehouseObservationCorrection" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_observation_correction();
DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY ARRAY['temco_unit_origin_before()','temco_unit_participation_after()','temco_unit_alias_after()','temco_custody_transfer_before()','temco_custody_transfer_after()','temco_custody_effect_before()','temco_custody_observation_correction()'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC'; END LOOP; END $$;
CREATE FUNCTION public.temco_custody_event_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public."WarehouseUnitTransfer" t WHERE t.id=NEW."transferId" AND NEW."siteId" IN(t."sourceSiteId",t."destinationSiteId") AND t.state=NEW.kind) THEN RAISE EXCEPTION 'Custody event must belong to this warehouse and actual transition.' USING ERRCODE='23514'; END IF;
 IF current_setting('role',true)='temco_runtime' AND (NOT public.temco_custody_authorized() OR NEW."actorUserId" IS DISTINCT FROM nullif(current_setting('temco.user_id',true),'') OR NEW."actorSessionId" IS DISTINCT FROM nullif(current_setting('temco.session_id',true),'')) THEN RAISE EXCEPTION 'Custody event attribution must match current individual authority.' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_event_before BEFORE INSERT ON "WarehouseUnitTransferEvent" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_event_before();
REVOKE ALL ON FUNCTION public.temco_custody_event_before() FROM PUBLIC;
CREATE FUNCTION public.temco_custody_observation_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public."WarehouseUnitTransfer" t WHERE t."departureObservationId"=OLD.id OR t."checkInObservationId"=OLD.id) THEN RAISE EXCEPTION 'Custody-bound physical evidence is immutable; use explicit reconciliation.' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custody_observation_immutable BEFORE UPDATE OR DELETE ON "WarehousePhysicalObservation" FOR EACH ROW EXECUTE FUNCTION public.temco_custody_observation_immutable();
REVOKE ALL ON FUNCTION public.temco_custody_observation_immutable() FROM PUBLIC;
-- Bounded NOLOGIN owners have only the tables required by these predicates or
-- projection triggers. They are never granted to the ordinary runtime role.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_custody_reader') THEN CREATE ROLE temco_custody_reader; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='temco_custody_writer') THEN CREATE ROLE temco_custody_writer; END IF;
END $$;
ALTER ROLE temco_custody_reader NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT;
ALTER ROLE temco_custody_writer NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT;
REVOKE temco_custody_reader,temco_custody_writer FROM temco_runtime;
GRANT USAGE ON SCHEMA public TO temco_custody_reader,temco_custody_writer;
GRANT SELECT ON "User","WarehouseSite","WarehouseMembership","WarehouseMembershipRole","WarehouseRole","WarehouseUnitSite","WarehouseUnitAlias","WarehouseUnitAliasVisibility" TO temco_custody_reader;
GRANT SELECT ON "WarehouseSite","WarehouseUnit","WarehouseUnitSite","WarehouseUnitAlias","WarehouseUnitAliasVisibility","WarehouseUnitTransfer","WarehousePhysicalObservation","WarehouseObservationCorrection","LabelIssuance","MarsSubmissionIntent","DispatchReservation" TO temco_custody_writer;
GRANT SELECT("unitId") ON "WarehouseUnitOrigin" TO temco_custody_writer;
GRANT INSERT ON "WarehouseUnitOrigin","WarehouseUnitSite","WarehouseUnitAlias","WarehouseUnitAliasVisibility" TO temco_custody_writer;
GRANT UPDATE ON "WarehouseUnitSite","WarehouseUnitAlias" TO temco_custody_writer;
GRANT EXECUTE ON FUNCTION public.temco_site_authorized(text) TO temco_custody_reader,temco_custody_writer;
GRANT EXECUTE ON FUNCTION public.temco_custody_authorized() TO temco_custody_writer;
DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['temco_custody_authorized()','temco_unit_visible(text)','temco_alias_visible(text)','temco_custody_destination(text)','temco_custody_import_identity(text)'] LOOP EXECUTE 'ALTER FUNCTION public.'||f||' OWNER TO temco_custody_reader'; END LOOP;
 FOREACH f IN ARRAY ARRAY['temco_unit_origin_before()','temco_unit_participation_after()','temco_unit_alias_after()','temco_custody_transfer_before()','temco_custody_transfer_after()','temco_custody_effect_before()','temco_custody_observation_correction()','temco_custody_event_before()','temco_custody_observation_immutable()'] LOOP EXECUTE 'ALTER FUNCTION public.'||f||' OWNER TO temco_custody_writer'; END LOOP;
END $$;
-- Preserve any existing bounded owner of the generic link trigger, adding only
-- its new participation lookup, rather than moving it back to a migration user.
DO $$ DECLARE owner_name text; BEGIN
 SELECT r.rolname INTO owner_name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.temco_same_site_links()'::regprocedure;
 EXECUTE format('GRANT SELECT ON public."WarehouseUnitSite" TO %I',owner_name);
END $$;
COMMIT;
