import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const MARS_UNIT_LIST_SELECT = {
  id: true,
  requestNumber: true,
  orderNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  vendorRaNumber: true,
  dateRequested: true,
  requestStatus: true,
  returnStatus: true,
  replacementNeeded: true,
  staged: true,
  archivedAt: true,
  archivedReason: true,
  presentInLatestImport: true,
  missingFromLatestImportAt: true,
  lastImportedAt: true,
  lastAuditSeenAt: true,
  lastScannedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MarsUnitSelect;

const MARS_IMPORT_BATCH_SUMMARY_SELECT = {
  id: true,
  filename: true,
  uploadedAt: true,
  rowCount: true,
  insertedCount: true,
  updatedCount: true,
  skippedCount: true,
  notes: true,
} as const satisfies Prisma.MarsImportBatchSelect;

export type MarsUnitListItem = Prisma.MarsUnitGetPayload<{
  select: typeof MARS_UNIT_LIST_SELECT;
}>;

export type MarsImportBatchSummary = Prisma.MarsImportBatchGetPayload<{
  select: typeof MARS_IMPORT_BATCH_SUMMARY_SELECT;
}>;

export interface ListMarsUnitsOptions {
  q?: string | null;
  requestNumber?: string | null;
  orderNumber?: string | null;
  vendor?: string | null;
  serialNumber?: string | null;
  modelNumber?: string | null;
  vendorRaNumber?: string | null;
  requestStatus?: string | null;
  returnStatus?: string | null;
  replacementNeeded?: string | null;
  staged?: boolean | null;
  archived?: boolean | null;
  needsAttentionOnly?: boolean | null;
  returnStatusMode?: MarsReturnStatusMode | null;
  dateRequestedOn?: string | null;
  lastImportedOn?: string | null;
  lastAuditSeenOn?: string | null;
  sortBy?: MarsUnitSortField | null;
  sortDirection?: SortDirection | null;
  page?: number | null;
  limit?: number | null;
}

export interface MarsUnitFilterOptions {
  requestStatuses: string[];
  returnStatuses: string[];
  replacementNeededOptions: string[];
}

export interface ListMarsUnitsResult {
  items: MarsUnitListItem[];
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  filterOptions: MarsUnitFilterOptions;
}

export type MarsReturnStatusMode = "exclude_received" | "all" | "received_only";
export type SortDirection = "asc" | "desc";
export type MarsUnitSortField =
  | "requestNumber"
  | "orderNumber"
  | "vendor"
  | "serialNumber"
  | "modelNumber"
  | "vendorRaNumber"
  | "dateRequested"
  | "requestStatus"
  | "returnStatus"
  | "replacementNeeded"
  | "staged"
  | "lastImportedAt"
  | "lastAuditSeenAt"
  | "updatedAt";

const DEFAULT_RETURN_STATUS_MODE: MarsReturnStatusMode = "exclude_received";
const DEFAULT_SORT_BY: MarsUnitSortField = "requestNumber";
const DEFAULT_SORT_DIRECTION: SortDirection = "asc";

export function parseStagedFilter(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function parseArchivedFilter(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function parseReturnStatusMode(value: string | null): MarsReturnStatusMode {
  if (value === "all" || value === "received_only" || value === "exclude_received") {
    return value;
  }
  return DEFAULT_RETURN_STATUS_MODE;
}

export function parseSortDirection(value: string | null): SortDirection {
  if (value === "desc") return "desc";
  return DEFAULT_SORT_DIRECTION;
}

export function parseMarsUnitSortField(value: string | null): MarsUnitSortField {
  const validFields = new Set<MarsUnitSortField>([
    "requestNumber",
    "orderNumber",
    "vendor",
    "serialNumber",
    "modelNumber",
    "vendorRaNumber",
    "dateRequested",
    "requestStatus",
    "returnStatus",
    "replacementNeeded",
    "staged",
    "lastImportedAt",
    "lastAuditSeenAt",
    "updatedAt",
  ]);

  return value && validFields.has(value as MarsUnitSortField)
    ? (value as MarsUnitSortField)
    : DEFAULT_SORT_BY;
}

export async function listMarsUnits(options: ListMarsUnitsOptions): Promise<ListMarsUnitsResult> {
  const page = normalizePositiveInt(options.page, 1);
  const limit = Math.min(normalizePositiveInt(options.limit, 25), 100);
  const where = buildMarsUnitsWhere(options);
  const orderBy = buildMarsUnitsOrderBy(options);

  const [items, totalCount, filterOptions] = await Promise.all([
    prisma.marsUnit.findMany({
      where,
      select: MARS_UNIT_LIST_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.marsUnit.count({ where }),
    getMarsUnitFilterOptions(),
  ]);

  return {
    items,
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    filterOptions,
  };
}

export async function getLatestMarsImportBatch(): Promise<MarsImportBatchSummary | null> {
  return prisma.marsImportBatch.findFirst({
    select: MARS_IMPORT_BATCH_SUMMARY_SELECT,
    orderBy: { uploadedAt: "desc" },
  });
}

export async function getRecentMarsImportBatches(limit = 5): Promise<MarsImportBatchSummary[]> {
  return prisma.marsImportBatch.findMany({
    select: MARS_IMPORT_BATCH_SUMMARY_SELECT,
    orderBy: { uploadedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 20),
  });
}

export async function setMarsUnitStaged(options: {
  requestNumber: string;
  staged: boolean;
  userId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const unit = await tx.marsUnit.findUnique({
      where: { requestNumber: options.requestNumber },
      select: {
        id: true,
        requestNumber: true,
        staged: true,
      },
    });

    if (!unit) {
      return null;
    }

    const updated = await tx.marsUnit.update({
      where: { requestNumber: options.requestNumber },
      data: { staged: options.staged },
      select: MARS_UNIT_LIST_SELECT,
    });

    await tx.marsEvent.create({
      data: {
        marsUnitId: unit.id,
        type: options.staged ? "marked_staged" : "unmarked_staged",
        userId: options.userId ?? null,
        payload: {
          requestNumber: unit.requestNumber,
          previousStaged: unit.staged,
          staged: options.staged,
        },
      },
    });

    return updated;
  });
}

export async function setMarsUnitArchived(options: {
  requestNumber: string;
  archived: boolean;
  reason?: string | null;
  userId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const unit = await tx.marsUnit.findUnique({
      where: { requestNumber: options.requestNumber },
      select: {
        id: true,
        requestNumber: true,
        archivedAt: true,
        archivedReason: true,
      },
    });

    if (!unit) {
      return null;
    }

    const archivedAt = options.archived ? new Date() : null;
    const archivedReason = options.archived ? options.reason?.trim() || "Archived from the working inventory." : null;

    const updated = await tx.marsUnit.update({
      where: { requestNumber: options.requestNumber },
      data: {
        archivedAt,
        archivedReason,
      },
      select: MARS_UNIT_LIST_SELECT,
    });

    await tx.marsEvent.create({
      data: {
        marsUnitId: unit.id,
        type: options.archived ? "archived" : "unarchived",
        userId: options.userId ?? null,
        payload: {
          requestNumber: unit.requestNumber,
          previousArchivedAt: unit.archivedAt?.toISOString() ?? null,
          previousArchivedReason: unit.archivedReason,
          archivedAt: archivedAt?.toISOString() ?? null,
          archivedReason,
        },
      },
    });

    return updated;
  });
}

const MARS_UNIT_DETAIL_SELECT = {
  id: true,
  requestNumber: true,
  orderNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  vendorRaNumber: true,
  dateRequested: true,
  requestStatus: true,
  returnStatus: true,
  replacementNeeded: true,
  staged: true,
  archivedAt: true,
  archivedReason: true,
  presentInLatestImport: true,
  missingFromLatestImportAt: true,
  lastImportedAt: true,
  lastScannedAt: true,
  lastAuditSeenAt: true,
  createdAt: true,
  updatedAt: true,
  lastKnownImportBatch: {
    select: {
      id: true,
      filename: true,
      uploadedAt: true,
      rowCount: true,
      insertedCount: true,
      updatedCount: true,
      skippedCount: true,
      notes: true,
    },
  },
  marsEvents: {
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      type: true,
      payload: true,
      createdAt: true,
      user: {
        select: {
          displayName: true,
          username: true,
        },
      },
    },
  },
  marsAuditScans: {
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      scannedValue: true,
      matched: true,
      duplicateInSession: true,
      createdAt: true,
      user: {
        select: {
          displayName: true,
          username: true,
        },
      },
      auditSession: {
        select: {
          id: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  },
} as const satisfies Prisma.MarsUnitSelect;

export type MarsUnitDetail = Prisma.MarsUnitGetPayload<{
  select: typeof MARS_UNIT_DETAIL_SELECT;
}>;

export async function getMarsUnitDetail(requestNumber: string): Promise<MarsUnitDetail | null> {
  return prisma.marsUnit.findUnique({
    where: { requestNumber },
    select: MARS_UNIT_DETAIL_SELECT,
  });
}

function buildMarsUnitsWhere(options: ListMarsUnitsOptions): Prisma.MarsUnitWhereInput {
  const q = options.q?.trim();
  const staged = options.staged ?? null;
  const archived = options.archived ?? false;
  const returnStatusMode = options.returnStatusMode ?? DEFAULT_RETURN_STATUS_MODE;
  const and: Prisma.MarsUnitWhereInput[] = [];

  if (typeof staged === "boolean") {
    and.push({ staged });
  }

  if (typeof archived === "boolean") {
    and.push(archived ? { archivedAt: { not: null } } : { archivedAt: null });
  }

  if (q) {
    and.push({
      OR: [
        { requestNumber: { contains: q, mode: "insensitive" } },
        { orderNumber: { contains: q, mode: "insensitive" } },
        { serialNumber: { contains: q, mode: "insensitive" } },
        { vendor: { contains: q, mode: "insensitive" } },
        { modelNumber: { contains: q, mode: "insensitive" } },
        { vendorRaNumber: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  pushContains(and, "requestNumber", options.requestNumber);
  pushContains(and, "orderNumber", options.orderNumber);
  pushContains(and, "vendor", options.vendor);
  pushContains(and, "serialNumber", options.serialNumber);
  pushContains(and, "modelNumber", options.modelNumber);
  pushContains(and, "vendorRaNumber", options.vendorRaNumber);
  pushEqualsInsensitive(and, "requestStatus", options.requestStatus);
  pushEqualsInsensitive(and, "returnStatus", options.returnStatus);
  pushEqualsInsensitive(and, "replacementNeeded", options.replacementNeeded);
  pushDateMatch(and, "dateRequested", options.dateRequestedOn);
  pushDateMatch(and, "lastImportedAt", options.lastImportedOn);
  pushDateMatch(and, "lastAuditSeenAt", options.lastAuditSeenOn);

  if (returnStatusMode === "exclude_received") {
    and.push({
      OR: [
        { returnStatus: null },
        { NOT: { returnStatus: { equals: "received", mode: "insensitive" } } },
      ],
    });
  } else if (returnStatusMode === "received_only") {
    and.push({ returnStatus: { equals: "received", mode: "insensitive" } });
  }

  if (options.needsAttentionOnly) {
    and.push({
      OR: [
        { presentInLatestImport: false },
        { missingFromLatestImportAt: { not: null } },
        { staged: true },
        { lastAuditSeenAt: null },
        { returnStatus: { equals: "received", mode: "insensitive" } },
        { returnStatus: { equals: "shipped", mode: "insensitive" } },
      ],
    });
  }

  return and.length ? { AND: and } : {};
}

export async function getMarsOperationalOverview() {
  const latestImportBatch = await getLatestMarsImportBatch();

  const [activeUnits, archivedUnits, stagedUnits, missingFromLatestImport, notSeenInAudit, shippedOrReceived, recentProblems] =
    await Promise.all([
      prisma.marsUnit.count({ where: { archivedAt: null, presentInLatestImport: true } }),
      prisma.marsUnit.count({ where: { archivedAt: { not: null } } }),
      prisma.marsUnit.count({ where: { archivedAt: null, staged: true } }),
      prisma.marsUnit.count({ where: { archivedAt: null, presentInLatestImport: false } }),
      prisma.marsUnit.count({
        where: {
          archivedAt: null,
          presentInLatestImport: true,
          lastAuditSeenAt: null,
        },
      }),
      prisma.marsUnit.count({
        where: {
          archivedAt: null,
          presentInLatestImport: true,
          OR: [
            { returnStatus: { equals: "shipped", mode: "insensitive" } },
            { returnStatus: { equals: "received", mode: "insensitive" } },
          ],
        },
      }),
      prisma.marsUnit.findMany({
        where: {
          archivedAt: null,
          OR: [
            { presentInLatestImport: false },
            { lastAuditSeenAt: null },
            { staged: true },
            { returnStatus: { equals: "shipped", mode: "insensitive" } },
            { returnStatus: { equals: "received", mode: "insensitive" } },
          ],
        },
        select: {
          requestNumber: true,
          orderNumber: true,
          vendor: true,
          modelNumber: true,
          returnStatus: true,
          staged: true,
          presentInLatestImport: true,
          missingFromLatestImportAt: true,
          lastAuditSeenAt: true,
        },
        orderBy: [{ lastImportedAt: "desc" }, { requestNumber: "asc" }],
        take: 12,
      }),
    ]);

  return {
    latestImportBatch,
    summary: {
      activeUnits,
      archivedUnits,
      stagedUnits,
      missingFromLatestImport,
      notSeenInAudit,
      shippedOrReceived,
    },
    recentProblems: recentProblems.map((unit) => ({
      ...unit,
      reason: deriveProblemReason(unit),
    })),
  };
}

function deriveProblemReason(unit: {
  staged: boolean;
  presentInLatestImport: boolean;
  missingFromLatestImportAt: Date | null;
  lastAuditSeenAt: Date | null;
  returnStatus: string | null;
}) {
  if (!unit.presentInLatestImport || unit.missingFromLatestImportAt) {
    return "Missing from the latest MARS import and needs review.";
  }
  if (unit.returnStatus?.toLowerCase() === "received" || unit.returnStatus?.toLowerCase() === "shipped") {
    return "MARS says this item has already moved out of the warehouse.";
  }
  if (unit.staged) {
    return "Still marked as staged locally.";
  }
  if (!unit.lastAuditSeenAt) {
    return "Has not been confirmed by an audit yet.";
  }
  return "Needs review.";
}

function buildMarsUnitsOrderBy(options: ListMarsUnitsOptions): Prisma.MarsUnitOrderByWithRelationInput[] {
  const sortBy = options.sortBy ?? DEFAULT_SORT_BY;
  const sortDirection = options.sortDirection ?? DEFAULT_SORT_DIRECTION;

  if (sortBy === "requestNumber") {
    return [{ requestNumber: sortDirection }];
  }

  return [{ [sortBy]: sortDirection }, { requestNumber: "asc" }];
}

async function getMarsUnitFilterOptions(): Promise<MarsUnitFilterOptions> {
  const [requestStatuses, returnStatuses, replacementNeededOptions] = await Promise.all([
    prisma.marsUnit.findMany({
      where: { requestStatus: { not: null } },
      select: { requestStatus: true },
      distinct: ["requestStatus"],
    }),
    prisma.marsUnit.findMany({
      where: { returnStatus: { not: null } },
      select: { returnStatus: true },
      distinct: ["returnStatus"],
    }),
    prisma.marsUnit.findMany({
      where: { replacementNeeded: { not: null } },
      select: { replacementNeeded: true },
      distinct: ["replacementNeeded"],
    }),
  ]);

  return {
    requestStatuses: normalizeDistinctStrings(requestStatuses.map((row) => row.requestStatus)),
    returnStatuses: normalizeDistinctStrings(returnStatuses.map((row) => row.returnStatus)),
    replacementNeededOptions: normalizeDistinctStrings(
      replacementNeededOptions.map((row) => row.replacementNeeded)
    ),
  };
}

function normalizeDistinctStrings(values: Array<string | null>): string[] {
  const deduped = new Map<string, string>();

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.localeCompare(b));
}

function pushContains(
  and: Prisma.MarsUnitWhereInput[],
  field:
    | "requestNumber"
    | "orderNumber"
    | "vendor"
    | "serialNumber"
    | "modelNumber"
    | "vendorRaNumber",
  value: string | null | undefined
) {
  const trimmed = value?.trim();
  if (!trimmed) return;
  and.push({ [field]: { contains: trimmed, mode: "insensitive" } });
}

function pushEqualsInsensitive(
  and: Prisma.MarsUnitWhereInput[],
  field: "requestStatus" | "returnStatus" | "replacementNeeded",
  value: string | null | undefined
) {
  const trimmed = value?.trim();
  if (!trimmed) return;
  and.push({ [field]: { equals: trimmed, mode: "insensitive" } });
}

function pushDateMatch(
  and: Prisma.MarsUnitWhereInput[],
  field: "dateRequested" | "lastImportedAt" | "lastAuditSeenAt",
  value: string | null | undefined
) {
  if (!value) return;

  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  and.push({
    [field]: {
      gte: start,
      lt: end,
    },
  });
}

function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}
