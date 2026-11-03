BEGIN;
-- Only a boolean is returned, never another warehouse's printer/job/actor data.
-- The caller holds the global destination advisory lock and its own issuance
-- lock; server code supplies the hash of its managed, normalized destination.
CREATE FUNCTION public.temco_printer_destination_busy(p_issuance text,p_destination text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target public."LabelIssuance"%ROWTYPE;
BEGIN
 IF p_destination IS NULL OR p_destination !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid printer destination scope.' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM public."LabelIssuance" WHERE id=p_issuance;
 IF NOT FOUND OR NOT public.temco_site_authorized(target."siteId") THEN RAISE EXCEPTION 'Printer issuance unavailable.' USING ERRCODE='42501'; END IF;
 RETURN EXISTS(SELECT 1 FROM public."LabelIssuance" i JOIN public."LabelIssuanceEvent" e ON e."issuanceId"=i.id
   WHERE i.id<>target.id AND i.state NOT IN ('queued','sent_unconfirmed','not_sent','cancelled','verified_not_printed','print_confirmed','applied')
   AND e.action='physical_printer_queue_reserved'
   AND e.note LIKE '%"destinationKey":"'||p_destination||'"%');
END $$;
REVOKE ALL ON FUNCTION public.temco_printer_destination_busy(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.temco_printer_destination_busy(text,text) TO temco_runtime;
COMMIT;
