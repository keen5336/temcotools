import { Prisma } from "@prisma/client";
import { z } from "zod";
import { readSnapshot } from "@/lib/read-snapshot";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { deriveCustody, type PhysicalFact } from "@/lib/office/domain";
import { WarehouseCommandError } from "./units";

export const physicalStockInput = z.object({
  view: z.enum(["present", "departed", "conflicts", "unobserved", "all"]).default("present"),
  search: z.string().trim().max(200).default(""), location: z.string().trim().max(200).default(""),
  cursor: z.string().min(1).max(200).optional(), asOf: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  scanLimit: z.coerce.number().int().min(1).max(2000).default(500),
}).strict();
export const physicalStockExportInput = physicalStockInput.extend({ limit: z.coerce.number().int().min(1).max(1000).default(500) });
type Filters = z.output<typeof physicalStockExportInput>;
type Fact = PhysicalFact & { userId: string; captureMethod: string; originalUnitId: string | null; correctionRevision: number; rawIdentifier: string };
type FactJson = Omit<Fact, "capturedAt" | "receivedAt"> & { capturedAt: number; receivedAt: number };
type Summary = { unitId: string; facts: FactJson[]; observationCount: bigint; latestTieCount: bigint; latestLocationMatch: boolean; correctedCount: bigint; withdrawnAssociationCount: bigint };
type Alias = { identifierId: string; kind: string; namespace: string; value: string; revokedAt: string | null; textTruncated: boolean };
type SourceRow = { lpn: string; status: string; orderNumber: string; description: string; vendor: string; archivedAt: string | null; legacyPickWaveVerifiedAt: string | null; sourceChangedAt: string; lastReportedAt: string | null; sourceAsOf: string | null; scope: string | null; coverage: string | null; textTruncated: boolean };
type Context = { unitId: string; aliases: Alias[]; aliasCount: bigint; historicalAliasCount: bigint; historicalAliasMatch: boolean; sourceRows: SourceRow[]; sourceRowCount: bigint; identityEvidence: string | null };
export type PhysicalStockRow = {
  unitId: string; state: "present" | "departed" | "conflicts" | "unobserved";
  latestObservation: (Omit<Fact, "capturedAt" | "receivedAt"> & { capturedAt: string; receivedAt: string }) | null;
  latestTieCount: number; observationCount: number; correctedObservationCount: number; withdrawnAssociationCount: number;
  lastDepartureAt: string | null; currentStayCheckInAt: string | null; observationAgeSeconds: number | null; captureClockAhead: boolean;
  matchedLocationFilter: string | null;
  aliases: Alias[]; aliasCount: number; historicalAliasCount: number; aliasesMayBeTruncated: boolean; historicalAliasMatch: boolean;
  sourceRows: SourceRow[]; sourceRowCount: number; sourceRowsMayBeTruncated: boolean; identityEvidence: string | null;
};
export type PhysicalStockPage = { view: Filters["view"]; items: PhysicalStockRow[]; asOf: string; queriedAt: string; examinedUnits: number; nextCursor: string | null; hasMore: boolean; searchWindowComplete: boolean; bookmarkUrl: string; limitations: string[] };
const limitations = [
  "Physical state means as last observed, not proof of instant stock. WMS status, report presence, order context and legacy Pick Wave verification do not establish physical custody.",
  "Physical receipts/corrections accepted through asOf are evaluated per page in a repeatable-read transaction. Later commits with earlier recorded timestamps and current reported-row changes can affect subsequent pages; this is not a signed warehouse snapshot.",
  "Aliases and source-row summaries are bounded; unit history links retain their full evidence. Alias revocation alone never retracts an observation; only explicit observation corrections change its effective unit.",
];
function stamp(value: Date) { return value.toISOString(); }
function decodeFact(value: FactJson): Fact { return { ...value, capturedAt: new Date(value.capturedAt), receivedAt: new Date(value.receivedAt) }; }
function factJson(alias: string) {
  // Alias is a constant internal SQL identifier, never an input value.
  return Prisma.raw(`jsonb_build_object('id',${alias}.id,'type',${alias}.type,'location',${alias}.location,'capturedAt',extract(epoch from ${alias}."capturedAt")*1000,'receivedAt',extract(epoch from ${alias}."receivedAt")*1000,'userId',${alias}."userId",'captureMethod',${alias}."captureMethod",'originalUnitId',${alias}."unitId",'correctionRevision',${alias}."correctionRevision",'rawIdentifier',left(${alias}."rawIdentifier",500))`);
}

async function summaries(tx: Prisma.TransactionClient, ids: string[], asOf: Date, location: string) {
  return tx.$queryRaw<Summary[]>`
    WITH candidates AS (
      SELECT o.* FROM "WarehousePhysicalObservation" o WHERE o."unitId" IN (${Prisma.join(ids)}) AND o."receivedAt"<=${asOf}
      UNION
      SELECT o.* FROM "WarehousePhysicalObservation" o WHERE o.id IN (
        SELECT c."observationId" FROM "WarehouseObservationCorrection" c WHERE c."unitId" IN (${Prisma.join(ids)}) AND c."createdAt"<=${asOf}
      ) AND o."receivedAt"<=${asOf}
    ), effective AS (
      SELECT o.*,CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END AS "effectiveUnitId",coalesce(c.revision,0) AS "correctionRevision"
      FROM candidates o LEFT JOIN LATERAL (
        SELECT c.id,c."unitId",c.revision FROM "WarehouseObservationCorrection" c WHERE c."observationId"=o.id AND c."createdAt"<=${asOf} ORDER BY c.revision DESC LIMIT 1
      ) c ON true
    ), facts AS (SELECT * FROM effective WHERE "effectiveUnitId" IN (${Prisma.join(ids)})),
    totals AS (SELECT "effectiveUnitId",count(*) AS "observationCount",count(*) FILTER(WHERE "correctionRevision">0) AS "correctedCount" FROM facts GROUP BY "effectiveUnitId")
    SELECT u.id AS "unitId",coalesce(t."observationCount",0)::bigint AS "observationCount",coalesce(t."correctedCount",0)::bigint AS "correctedCount",
      (SELECT count(*) FROM effective f WHERE f."effectiveUnitId" IS DISTINCT FROM u.id AND (f."unitId"=u.id OR EXISTS(SELECT 1 FROM "WarehouseObservationCorrection" c WHERE c."observationId"=f.id AND c."unitId"=u.id AND c."createdAt"<=${asOf})))::bigint AS "withdrawnAssociationCount",
      (SELECT count(*) FROM facts f WHERE f."effectiveUnitId"=u.id AND f."capturedAt"=last."capturedAt")::bigint AS "latestTieCount",
      EXISTS(SELECT 1 FROM facts f WHERE f."effectiveUnitId"=u.id AND f."capturedAt"=last."capturedAt" AND f.location=${location}) AS "latestLocationMatch",
      coalesce((SELECT jsonb_agg(DISTINCT v.fact) FROM (VALUES
        (CASE WHEN last.id IS NOT NULL THEN ${factJson("last")} END),
        (CASE WHEN witness.id IS NOT NULL THEN ${factJson("witness")} END),
        (CASE WHEN departure.id IS NOT NULL THEN ${factJson("departure")} END),
        (CASE WHEN checkin.id IS NOT NULL THEN ${factJson("checkin")} END)
      )v(fact) WHERE v.fact IS NOT NULL),'[]'::jsonb) AS facts
    FROM "WarehouseUnit" u LEFT JOIN totals t ON t."effectiveUnitId"=u.id
    LEFT JOIN LATERAL (SELECT f.* FROM facts f WHERE f."effectiveUnitId"=u.id ORDER BY f."capturedAt" DESC,f.id COLLATE "C" DESC LIMIT 1) last ON true
    LEFT JOIN LATERAL (SELECT f.* FROM facts f WHERE f."effectiveUnitId"=u.id AND f."capturedAt"=last."capturedAt" AND (f.type,f.location) IS DISTINCT FROM (last.type,last.location) ORDER BY f.id COLLATE "C" DESC LIMIT 1) witness ON true
    LEFT JOIN LATERAL (SELECT f.* FROM facts f WHERE f."effectiveUnitId"=u.id AND f.type='departure' ORDER BY f."capturedAt" DESC,f.id COLLATE "C" DESC LIMIT 1) departure ON true
    LEFT JOIN LATERAL (SELECT f.* FROM facts f WHERE f."effectiveUnitId"=u.id AND f.type='check_in' AND (departure.id IS NULL OR f."capturedAt">departure."capturedAt") ORDER BY f."capturedAt",f.id COLLATE "C" LIMIT 1) checkin ON true
    WHERE u.id IN (${Prisma.join(ids)}) ORDER BY u.id`;
}

async function contexts(tx: Prisma.TransactionClient, ids: string[], asOf: Date, needle: string) {
  return tx.$queryRaw<Context[]>`
    SELECT u.id AS "unitId",left(u."creationEvidence",500) AS "identityEvidence",
      (SELECT count(*) FROM "WarehouseIdentifier" a WHERE a."unitId"=u.id AND a."createdAt"<=${asOf})::bigint AS "aliasCount",
      (SELECT count(*) FROM "WarehouseIdentifier" a WHERE a."unitId"=u.id AND a."createdAt"<=${asOf} AND a."revokedAt"<=${asOf})::bigint AS "historicalAliasCount",
      EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=u.id AND a."createdAt"<=${asOf} AND a."revokedAt"<=${asOf} AND a.value ILIKE ${needle}) AS "historicalAliasMatch",
      coalesce((SELECT jsonb_agg(a.row) FROM (
        SELECT jsonb_build_object('identifierId',a.id,'kind',a.kind,'namespace',a.namespace,'value',left(a.value,500),'revokedAt',CASE WHEN a."revokedAt"<=${asOf} THEN to_char(a."revokedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'textTruncated',length(a.value)>500) AS row
        FROM "WarehouseIdentifier" a WHERE a."unitId"=u.id AND a."createdAt"<=${asOf}
        ORDER BY (a."revokedAt" IS NULL OR a."revokedAt">${asOf}) DESC,a."createdAt" DESC,a.id DESC LIMIT 5
      )a),'[]'::jsonb) AS aliases,
      (SELECT count(*) FROM "InventoryAuditItem" i WHERE i."unitId"=u.id)::bigint AS "sourceRowCount",
      coalesce((SELECT jsonb_agg(r.row) FROM (
        SELECT jsonb_build_object('lpn',left(i.lpn,500),'status',left(i.status,200),'orderNumber',left(i."orderNumber",200),'description',left(i.description,200),'vendor',left(i.vendor,200),'archivedAt',to_char(i."archivedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'legacyPickWaveVerifiedAt',to_char(i."verifiedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceChangedAt',to_char(i."sourceChangedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'lastReportedAt',to_char(b."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceAsOf',to_char(b."sourceAsOf",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'scope',b.scope,'coverage',b.coverage,'textTruncated',length(i.lpn)>500 OR length(i.status)>200 OR length(i."orderNumber")>200 OR length(i.description)>200 OR length(i.vendor)>200) AS row
        FROM "InventoryAuditItem" i LEFT JOIN LATERAL (
          SELECT b.* FROM "InventoryImportMembership" m JOIN "InventorySourceRevision" r ON r.id=m."sourceRevisionId" JOIN "InventoryAuditImport" b ON b.id=m."importId"
          WHERE r."inventoryItemId"=i.id ORDER BY b."createdAt" DESC,b.id DESC LIMIT 1
        ) b ON true WHERE i."unitId"=u.id ORDER BY i."sourceChangedAt" DESC,i.id LIMIT 3
      )r),'[]'::jsonb) AS "sourceRows"
    FROM "WarehouseUnit" u WHERE u.id IN (${Prisma.join(ids)})`;
}

async function readPage(principal: Principal, input: Filters): Promise<PhysicalStockPage> {
  assertCapability(principal, "inventory.read");
  const asOf = input.asOf ? new Date(input.asOf) : new Date();
  if (asOf.getTime()>Date.now()+5000) throw new WarehouseCommandError("Physical-stock asOf must not be in the future.");
  const needle = `%${input.search.replace(/[\\%_]/g,"\\$&")}%`;
  // Keep this page's accepted-evidence boundary stable across fresh read attempts.
  return readSnapshot(async tx => {
    await assertCurrentPrincipal(tx, principal, "inventory.read");
    const candidates = await tx.$queryRaw<{ id: string }[]>`SELECT u.id FROM "WarehouseUnit" u WHERE u."createdAt"<=${asOf} AND (${input.cursor ?? null}::text IS NULL OR u.id>${input.cursor ?? null})
      AND (${input.search}='' OR u.id ILIKE ${needle} OR u."creationEvidence" ILIKE ${needle}
        OR EXISTS(SELECT 1 FROM "WarehouseIdentifier" a WHERE a."unitId"=u.id AND a."createdAt"<=${asOf} AND a.value ILIKE ${needle})
        OR EXISTS(SELECT 1 FROM "InventoryAuditItem" i WHERE i."unitId"=u.id AND (i.lpn ILIKE ${needle} OR i."orderNumber" ILIKE ${needle} OR i.description ILIKE ${needle})))
      ORDER BY u.id LIMIT ${input.scanLimit+1}`;
    const window = candidates.slice(0,input.scanLimit), ids = window.map(unit => unit.id);
    const items: PhysicalStockRow[] = []; let examined = 0; let cursor = input.cursor ?? null;
    if (ids.length) {
      const summary = new Map((await summaries(tx,ids,asOf,input.location)).map(row => [row.unitId,row]));
      const matching: Array<{ unitId: string; row: Summary; facts: Fact[]; custody: ReturnType<typeof deriveCustody>; state: PhysicalStockRow["state"] }> = [];
      for (const unit of window) {
        examined++; cursor=unit.id; const row=summary.get(unit.id)!; const facts=row.facts.map(decodeFact); const custody=deriveCustody(facts);
        const state = custody.conflict ? "conflicts" : custody.warehouseEvidence ? "present" : custody.last?.type === "departure" ? "departed" : "unobserved";
        // A unit with simultaneous conflicting lane evidence remains visible
        // under every evidenced latest location, including a tie not selected
        // as one of the bounded representative facts.
        if ((input.view === "all" || state === input.view) && (!input.location || row.latestLocationMatch)) matching.push({unitId:unit.id,row,facts,custody,state});
        if (matching.length>=input.limit) break;
      }
      if (matching.length) {
        const context = new Map((await contexts(tx,matching.map(item=>item.unitId),asOf,input.search ? needle : "")).map(row => [row.unitId,row]));
        for (const entry of matching) { const info=context.get(entry.unitId)!; const last=entry.custody.last as Fact | null;
          items.push({ unitId:entry.unitId,state:entry.state,matchedLocationFilter:input.location||null,latestObservation:last?{...last,capturedAt:stamp(last.capturedAt),receivedAt:stamp(last.receivedAt)}:null,latestTieCount:Number(entry.row.latestTieCount),observationCount:Number(entry.row.observationCount),correctedObservationCount:Number(entry.row.correctedCount),withdrawnAssociationCount:Number(entry.row.withdrawnAssociationCount),lastDepartureAt:entry.custody.departure?stamp(entry.custody.departure.capturedAt):null,currentStayCheckInAt:entry.custody.currentCheckIn?stamp(entry.custody.currentCheckIn.capturedAt):null,observationAgeSeconds:last?Math.max(0,Math.floor((Date.now()-last.capturedAt.getTime())/1000)):null,captureClockAhead:Boolean(last&&last.capturedAt>new Date()),aliases:info.aliases,aliasCount:Number(info.aliasCount),historicalAliasCount:Number(info.historicalAliasCount),aliasesMayBeTruncated:Number(info.aliasCount)>info.aliases.length,historicalAliasMatch:info.historicalAliasMatch,sourceRows:info.sourceRows,sourceRowCount:Number(info.sourceRowCount),sourceRowsMayBeTruncated:Number(info.sourceRowCount)>info.sourceRows.length,identityEvidence:info.identityEvidence });
        }
      }
    }
    const hasMore=candidates.length>examined;
    const bookmark=new URLSearchParams({workspace:"physical",stockView:input.view,...(input.search?{stockSearch:input.search}:{}),...(input.location?{stockLocation:input.location}:{})});
    return {view:input.view,items,asOf:stamp(asOf),queriedAt:stamp(new Date()),examinedUnits:examined,nextCursor:hasMore?cursor:null,hasMore,searchWindowComplete:!hasMore,bookmarkUrl:`/tools/inventory-audit?${bookmark}`,limitations};
  },{isolationLevel:"RepeatableRead",timeout:30000});
}
export async function getPhysicalStock(principal: Principal, raw: unknown = {}) { return readPage(principal,physicalStockInput.parse(raw)); }
function cell(value: unknown) { const text=String(value??""); return `"${(/^[\s]*[=+\-@]|^[\t\r]/.test(text)?"'":"")+text.replace(/"/g,'""')}"`; }
export async function exportPhysicalStock(principal: Principal, raw: unknown = {}) {
  const input=physicalStockExportInput.parse(raw), page=await readPage(principal,input);
  const unitHeader=["Physical Unit ID","Observed State (not WMS)","Last Observed","Observation Received","Observed Location","Observed Type","Recorded By User ID","Capture Method","Equal-Time Evidence Count","Observation Conflict","Current-Stay Check-In","Last Departure","Active Identifiers (bounded)","Reported LPNs (bounded)","Reported WMS Statuses","Reported Orders (context only)","WMS Source As Of","WMS Last Reported","Source Row Count","Source Rows Truncated","Alias Count","Alias Summary Truncated","Summary Text Truncated","Historical Alias Count","Corrected Observation Count","Corrected-Away Associations"];
  const header=["Record Type",...unitHeader,"Accepted Evidence Through","Page Queried At","View","Search","Exact Location Filter","Started After Unit ID","Candidates Examined","Has More Candidates","Continue After Unit ID","Evidence Limits"];
  const metadata=[page.asOf,page.queriedAt,input.view,input.search,input.location,input.cursor??"",page.examinedUnits,page.hasMore,page.nextCursor??"",page.limitations.join(" | ")];
  // Even an empty sparse page carries its own continuation and evidence limits.
  // Unit records remain individually identified; the metadata record is not stock.
  const rows: unknown[][]=[["page_metadata",...unitHeader.map(()=>""),...metadata],...page.items.map(row=>["unit",row.unitId,row.state,row.latestObservation?.capturedAt,row.latestObservation?.receivedAt,row.latestObservation?.location,row.latestObservation?.type,row.latestObservation?.userId,row.latestObservation?.captureMethod,row.latestTieCount,row.state==="conflicts",row.currentStayCheckInAt,row.lastDepartureAt,row.aliases.filter(alias=>!alias.revokedAt).map(alias=>`${alias.kind}:${alias.namespace}:${alias.value}`).join(" | "),row.sourceRows.map(source=>source.lpn).join(" | "),row.sourceRows.map(source=>source.status).join(" | "),row.sourceRows.map(source=>source.orderNumber).join(" | "),row.sourceRows.map(source=>source.sourceAsOf??"Unknown").join(" | "),row.sourceRows.map(source=>source.lastReportedAt??"Unknown").join(" | "),row.sourceRowCount,row.sourceRowsMayBeTruncated,row.aliasCount,row.aliasesMayBeTruncated,row.aliases.some(alias=>alias.textTruncated)||row.sourceRows.some(source=>source.textTruncated),row.historicalAliasCount,row.correctedObservationCount,row.withdrawnAssociationCount,...metadata])];
  const csv="\uFEFF"+[header,...rows].map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n";
  return {filename:`physical-stock-${input.view}-part.csv`,csv,rowCount:page.items.length,nextCursor:page.nextCursor,hasMore:page.hasMore,asOf:page.asOf,examinedUnits:page.examinedUnits,limitations:page.limitations};
}
