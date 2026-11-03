-- A correction and custody confirmation serialize on the same native key.
-- Function replacement preserves the reviewed NOLOGIN owner, ACL and triggers.
BEGIN;
CREATE OR REPLACE FUNCTION public.temco_custody_transfer_before() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  PERFORM pg_advisory_xact_lock(hashtextextended('observation-correction:'||CASE WHEN NEW.state='departed' THEN NEW."departureObservationId" ELSE NEW."checkInObservationId" END,0));
  SELECT EXISTS(SELECT 1 FROM public."WarehousePhysicalObservation" o LEFT JOIN LATERAL(SELECT c.id,c."unitId" FROM public."WarehouseObservationCorrection" c WHERE c."observationId"=o.id ORDER BY c.revision DESC LIMIT 1) c ON true WHERE o.id=CASE WHEN NEW.state='departed' THEN NEW."departureObservationId" ELSE NEW."checkInObservationId" END AND o."siteId"=here AND CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=NEW."unitId" AND o.resolution='resolved' AND o.type=CASE WHEN NEW.state='departed' THEN 'departure' ELSE 'check_in' END AND o."capturedAt">=CASE WHEN NEW.state='departed' THEN NEW."acceptedAt" ELSE NEW."departedAt" END AND o."capturedAt"<=now()+interval '5 minutes' AND EXISTS(SELECT 1 FROM jsonb_to_recordset(NEW."aliasIds") AS pin(id text,revision integer) JOIN public."WarehouseUnitAlias" a ON a.id=pin.id WHERE a.value=upper(trim(o."rawIdentifier")) AND (o."identifierType"='auto' OR o."identifierType"=a.kind) AND (o."identifierNamespace" IS NULL OR o."identifierNamespace"=a.namespace))) INTO observation_ok;
  IF NOT observation_ok THEN RAISE EXCEPTION 'Independent exact-unit physical observation is required.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.temco_custody_observation_correction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('observation-correction:'||NEW."observationId",0));
 IF EXISTS(SELECT 1 FROM public."WarehouseUnitTransfer" t WHERE (t."departureObservationId"=NEW."observationId" OR t."checkInObservationId"=NEW."observationId") AND NEW."unitId" IS DISTINCT FROM t."unitId") THEN RAISE EXCEPTION 'Custody-bound evidence requires explicit custody reconciliation, not an identity rewrite.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
COMMIT;
