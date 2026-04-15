import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const MARS_UNIT_LIST_SELECT = {
  id: true,
  requestNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  requestStatus: true,
  returnStatus: true,
  staged: true,
  lastImportedAt: true,
  lastAuditSeenAt: true,
  lastScannedAt: true,
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
  staged?: boolean | null;
  page?: number | null;
  limit?: number | null;
}

export interface ListMarsUnitsResult {
  items: MarsUnitListItem[];
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
}

export function parseStagedFilter(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export async function listMarsUnits(options: ListMarsUnitsOptions): Promise<ListMarsUnitsResult> {
  const page = normalizePositiveInt(options.page, 1);
  const limit = Math.min(normalizePositiveInt(options.limit, 25), 100);
  const where = buildMarsUnitsWhere(options);

  const [items, totalCount] = await Promise.all([
    prisma.marsUnit.findMany({
      where,
      select: MARS_UNIT_LIST_SELECT,
      orderBy: [{ requestNumber: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.marsUnit.count({ where }),
  ]);

  return {
    items,
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
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

function buildMarsUnitsWhere(options: ListMarsUnitsOptions): Prisma.MarsUnitWhereInput {
  const q = options.q?.trim();
  const staged = options.staged ?? null;

  return {
    ...(typeof staged === "boolean" ? { staged } : {}),
    ...(q
      ? {
          OR: [
            { requestNumber: { contains: q, mode: "insensitive" } },
            { serialNumber: { contains: q, mode: "insensitive" } },
            { vendor: { contains: q, mode: "insensitive" } },
            { modelNumber: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}
