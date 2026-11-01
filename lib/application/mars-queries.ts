import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { classifyMarsUnit, getMarsBucketWhere, MARS_BUCKET_LABELS, parseMarsOperationalBucket, MARS_OPERATIONAL_BUCKETS, type MarsOperationalBucket } from "@/lib/mars/classification";

const MARS_UNIT_MCP_SELECT = {
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
  localStatus: true,
  archivedAt: true,
  archivedReason: true,
  presentInLatestImport: true,
  missingFromLatestImportAt: true,
  lastImportedAt: true,
  lastAuditSeenAt: true,
  lastScannedAt: true,
  updatedAt: true,
} as const satisfies Prisma.MarsUnitSelect;

type MarsUnitMcpRecord = Prisma.MarsUnitGetPayload<{
  select: typeof MARS_UNIT_MCP_SELECT;
}>;

export async function getMarsWorkflowSummary(principal: Principal) {
  assertCapability(principal, "workflow.read");
  const counts = await Promise.all(
    MARS_OPERATIONAL_BUCKETS.map(async (bucket) => ({
      bucket,
      label: MARS_BUCKET_LABELS[bucket],
      count: await prisma.marsUnit.count({
        where: getMarsBucketWhere(bucket),
      }),
    }))
  );

  const latestImport = await prisma.marsImportBatch.findFirst({
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      uploadedAt: true,
      rowCount: true,
      insertedCount: true,
      updatedCount: true,
      skippedCount: true,
    },
  });

  return {
    latestImport,
    buckets: counts,
  };
}

export async function searchMarsUnits(principal: Principal, options: {
  query?: string | null;
  bucket?: MarsOperationalBucket | null;
  limit: number;
}) {
  assertCapability(principal, "workflow.read");
  const where: Prisma.MarsUnitWhereInput[] = [];
  const query = options.query?.trim();
  const bucket = options.bucket ? parseMarsOperationalBucket(options.bucket) : null;

  if (bucket) {
    where.push(getMarsBucketWhere(bucket));
  }

  if (query) {
    where.push({
      OR: [
        { requestNumber: { contains: query, mode: "insensitive" } },
        { orderNumber: { contains: query, mode: "insensitive" } },
        { vendor: { contains: query, mode: "insensitive" } },
        { serialNumber: { contains: query, mode: "insensitive" } },
        { modelNumber: { contains: query, mode: "insensitive" } },
        { vendorRaNumber: { contains: query, mode: "insensitive" } },
      ],
    });
  }

  const units = await prisma.marsUnit.findMany({
    where: where.length ? { AND: where } : undefined,
    select: MARS_UNIT_MCP_SELECT,
    orderBy: [{ updatedAt: "desc" }, { requestNumber: "asc" }],
    take: options.limit,
  });

  return {
    count: units.length,
    units: units.map(toMcpUnit),
  };
}

function toMcpUnit(unit: MarsUnitMcpRecord) {
  const classification = classifyMarsUnit(unit);

  return {
    requestNumber: unit.requestNumber,
    orderNumber: unit.orderNumber,
    vendor: unit.vendor,
    serialNumber: unit.serialNumber,
    modelNumber: unit.modelNumber,
    vendorRaNumber: unit.vendorRaNumber,
    dateRequested: unit.dateRequested,
    requestStatus: unit.requestStatus,
    returnStatus: unit.returnStatus,
    replacementNeeded: unit.replacementNeeded,
    staged: unit.staged,
    localStatus: unit.localStatus,
    archivedAt: unit.archivedAt,
    archivedReason: unit.archivedReason,
    presentInLatestImport: unit.presentInLatestImport,
    missingFromLatestImportAt: unit.missingFromLatestImportAt,
    lastImportedAt: unit.lastImportedAt,
    lastAuditSeenAt: unit.lastAuditSeenAt,
    lastScannedAt: unit.lastScannedAt,
    updatedAt: unit.updatedAt,
    operational: classification,
  };
}


export async function getMarsUnit(principal: Principal, requestNumber: string) {
  assertCapability(principal, "workflow.read");
  const unit = await prisma.marsUnit.findUnique({where:{requestNumber:requestNumber.trim()}, select:MARS_UNIT_MCP_SELECT});
  return unit ? {found:true,unit:toMcpUnit(unit)} : {found:false,requestNumber};
}
export function getMarsStatusRules(principal: Principal) {
  assertCapability(principal, "workflow.read");
  return {buckets:MARS_BUCKET_LABELS, note:"Imported MARS classifications are separate from physical observations and office dispositions. A submission is not a physical-unit identity."};
}
