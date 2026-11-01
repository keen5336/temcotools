import { assertCapability, type Principal } from "@/lib/auth/principal";
import { normalizeLpn } from "@/lib/lpn-report";
import { z } from "zod";

export const warehouseLookupInput = z.object({ kind: z.enum(["lpn", "order"]), value: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() });

export type WarehouseLookupInput = { kind: "lpn" | "order"; value: string; limit?: number };

export class WarehouseLookupError extends Error {
  readonly status = 400;
}

// These are existing Inventory Audit records, not a new physical-unit identity.
export interface WarehouseInventoryRow {
  id: string;
  lpn: string;
  status: string;
  orderNumber: string;
  vendor: string;
  receivedDate: string;
  description: string;
  customerName: string;
  sourceData: unknown;
  revision: number;
  firstSeenAt: Date;
  sourceChangedAt: Date;
  verifiedAt: Date | null;
  lastScannedAt: Date | null;
  archivedAt: Date | null;
  unitId?: string | null;
}

export interface WarehouseScanRow {
  id: string;
  sourceScanId: string;
  lpn: string | null;
  scannedValue: string;
  pickWaveId: string;
  pickWaveName: string;
  scannedByName: string | null;
  matchedPickWave: boolean;
  duplicateInWave: boolean;
  scannedAt: Date;
  exportedAt: Date;
}

export interface WarehouseImportRow {
  id: string;
  filename: string;
  createdAt: Date;
  rowCount: number;
  scope?: string;
  coverage?: string;
  sourceAsOf?: Date | null;
}

export interface WarehouseLookupSnapshot {
  rows: WarehouseInventoryRow[];
  scans: WarehouseScanRow[];
  scanCount: number;
  latestImport: WarehouseImportRow | null;
  membership?: "included" | "not_in_complete_report" | "unknown";
  rowSourceReport?: WarehouseImportRow | null;
  identifierResolution?: "resolved" | "ambiguous" | "unresolved";
  resolvedUnitId?: string | null;
}

export interface WarehouseLookupRepository {
  read(input: Required<WarehouseLookupInput>): Promise<WarehouseLookupSnapshot>;
}

const OBSERVATION_LIMIT = 20;
const SOURCE_LIMITATION = "Import time and source-as-of time are separate. Membership describes the selected source scope/report; absence from a partial report is unknown and is never proof of physical departure.";
const PHYSICAL_LIMITATION = "A WMS row, archive flag or prior scan does not establish current physical presence. Review the original observation and any later movement evidence.";

export interface WarehouseObservation {
  observationId: string;
  sourceScanId: string;
  scannedValue: string;
  lpn: string | null;
  scannedByName: string | null;
  capturedAt: string;
  exportedAt: string;
  pickWaveId: string;
  pickWaveName: string;
  duplicateInWave: boolean;
  matchedPickWave: boolean;
  identityBasis: "exact_lpn_scan" | "legacy_pick_match";
}

function candidate(row: WarehouseInventoryRow) {
  return {
    inventoryRecordId: row.id,
    unitId: row.unitId ?? null,
    lpn: row.lpn,
    reportedStatus: row.status,
    orderNumber: row.orderNumber,
    vendor: row.vendor,
    description: row.description,
    customerName: row.customerName,
    receivedDate: row.receivedDate,
    revision: row.revision,
    sourceChangedAt: row.sourceChangedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export type WarehouseCandidate = ReturnType<typeof candidate>;

function observation(scan: WarehouseScanRow): WarehouseObservation {
  return {
    observationId: scan.id,
    sourceScanId: scan.sourceScanId,
    scannedValue: scan.scannedValue,
    lpn: scan.lpn,
    scannedByName: scan.scannedByName,
    capturedAt: scan.scannedAt.toISOString(),
    exportedAt: scan.exportedAt.toISOString(),
    pickWaveId: scan.pickWaveId,
    pickWaveName: scan.pickWaveName,
    duplicateInWave: scan.duplicateInWave,
    matchedPickWave: scan.matchedPickWave,
    identityBasis: scan.lpn && normalizeLpn(scan.scannedValue) === normalizeLpn(scan.lpn) ? "exact_lpn_scan" : "legacy_pick_match",
  };
}

function parseInput(input: unknown): Required<WarehouseLookupInput> {
  const validated = warehouseLookupInput.safeParse(input);
  if (!validated.success) throw new WarehouseLookupError("Choose LPN or order lookup, a value of 1–500 characters and a candidate limit of 1–50.");
  const body = validated.data;
  return { kind: body.kind, value: body.kind === "lpn" ? normalizeLpn(body.value) : body.value.trim(), limit: Number(body.limit ?? 20) };
}

async function databaseRepository(): Promise<WarehouseLookupRepository> {
  // Lazy import keeps the query testable without opening a database connection.
  const { prisma } = await import("@/lib/db");
  return {
    read: (input) => prisma.$transaction(async (tx) => {
      // Compare order values literally. Case-insensitive LIKE matching would
      // give identifiers containing percent/underscore wildcard semantics.
      const rows = input.kind === "lpn"
        ? await tx.inventoryAuditItem.findMany({ where: { lpn: input.value }, orderBy: [{ lpn: "asc" }, { id: "asc" }], take: 1 })
        : await tx.$queryRaw<WarehouseInventoryRow[]>`SELECT * FROM "InventoryAuditItem" WHERE lower("orderNumber") = lower(${input.value}) ORDER BY lpn ASC, id ASC LIMIT ${input.limit + 1}`;
      const [scans, scanCount, latestImport] = await Promise.all([
        input.kind === "lpn" ? tx.inventoryAuditScan.findMany({ where: { lpn: input.value }, orderBy: [{ scannedAt: "desc" }, { id: "desc" }], take: OBSERVATION_LIMIT }) : [],
        input.kind === "lpn" ? tx.inventoryAuditScan.count({ where: { lpn: input.value } }) : 0,
        tx.inventoryAuditImport.findFirst({ where: { scope: "warehouse" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, filename: true, createdAt: true, rowCount: true, scope: true, coverage: true, sourceAsOf: true } }),
      ]);
      let membership: WarehouseLookupSnapshot["membership"] = "unknown";
      let rowSourceReport: WarehouseImportRow | null = null;
      let identifierResolution: WarehouseLookupSnapshot["identifierResolution"];
      let resolvedUnitId: string | null = null;
      if (input.kind === "lpn") {
        const aliases = await tx.warehouseIdentifier.findMany({ where: { kind: "lpn", namespace: "wms", value: input.value, revokedAt: null }, select: { unitId: true }, take: 101 });
        const unitIds = [...new Set(aliases.map((alias) => alias.unitId))];
        identifierResolution = unitIds.length === 0 ? "unresolved" : unitIds.length > 1 || aliases.length > 100 ? "ambiguous" : "resolved";
        resolvedUnitId = identifierResolution === "resolved" ? unitIds[0] : null;
        const latestMember = latestImport ? await tx.inventoryImportMembership.findUnique({ where: { importId_lpn: { importId: latestImport.id, lpn: input.value } } }) : null;
        const rowMember = await tx.inventoryImportMembership.findFirst({ where: { lpn: input.value }, include: { importBatch: true }, orderBy: [{ importBatch: { createdAt: "desc" } }, { id: "desc" }] });
        rowSourceReport = rowMember?.importBatch ?? null;
        if (latestMember) membership = "included";
        else if (latestImport?.coverage === "complete" && await tx.inventoryImportMembership.count({ where: { importId: latestImport.id } }) > 0) membership = "not_in_complete_report";
      }
      return { rows, scans, scanCount, latestImport, membership, rowSourceReport, identifierResolution, resolvedUnitId };
    }, { isolationLevel: "RepeatableRead" }),
  };
}

/** Shared authorized query used by UI and MCP. An order returns candidates only. */
export async function lookupWarehouseInventory(principal: Principal, input: unknown, repository?: WarehouseLookupRepository) {
  assertCapability(principal, "inventory.read");
  const query = parseInput(input);
  const snapshot = await (repository ?? await databaseRepository()).read(query);
  const common = {
    normalizedValue: query.value,
    source: "WMS Inventory Audit" as const,
    sourceAsOf: snapshot.rowSourceReport?.sourceAsOf?.toISOString() ?? null,
    latestImport: snapshot.latestImport ? { importId: snapshot.latestImport.id, filename: snapshot.latestImport.filename, importedAt: snapshot.latestImport.createdAt.toISOString(), rowCount: snapshot.latestImport.rowCount, scope: snapshot.latestImport.scope ?? "warehouse", coverage: snapshot.latestImport.coverage ?? "unknown", sourceAsOf: snapshot.latestImport.sourceAsOf?.toISOString() ?? null } : null,
    latestReportMembership: snapshot.membership ?? "unknown" as const,
    physicalPresence: "not_determined" as const,
    limitations: [SOURCE_LIMITATION, PHYSICAL_LIMITATION],
  };
  if (query.kind === "order") {
    return { ...common, kind: "order" as const, candidates: snapshot.rows.slice(0, query.limit).map(candidate), hasMore: snapshot.rows.length > query.limit, identityResolved: false as const };
  }
  const row = snapshot.rows[0] ?? null;
  const observations = snapshot.scans.map(observation);
  return {
    ...common,
    kind: "lpn" as const,
    identifierResolution: snapshot.identifierResolution ?? "unresolved",
    record: row ? { ...candidate(row), reportedUnitId: row.unitId ?? null, unitId: snapshot.identifierResolution ? snapshot.resolvedUnitId ?? null : row.unitId ?? null, sourceData: row.sourceData, firstImportedAt: row.firstSeenAt.toISOString(), legacyVerifiedAt: row.verifiedAt?.toISOString() ?? null, rowSummaryLastScannedAt: row.lastScannedAt?.toISOString() ?? null } : null,
    observations,
    observationCount: snapshot.scanCount,
    observationsTruncated: snapshot.scanCount > observations.length,
    lastObservation: observations[0] ?? null,
  };
}

export type WarehouseLookupResult = Awaited<ReturnType<typeof lookupWarehouseInventory>>;
