import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const RECONCILIATION_UNIT_SELECT = {
  id: true,
  requestNumber: true,
  orderNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  dateRequested: true,
  returnStatus: true,
  staged: true,
  lastImportedAt: true,
  lastAuditSeenAt: true,
  lastKnownImportBatchId: true,
} as const satisfies Prisma.MarsUnitSelect;

const LATEST_AUDIT_SCAN_SELECT = {
  id: true,
  scannedValue: true,
  matched: true,
  duplicateInSession: true,
  createdAt: true,
  marsUnitId: true,
  auditSessionId: true,
  marsUnit: {
    select: RECONCILIATION_UNIT_SELECT,
  },
} as const satisfies Prisma.MarsAuditScanSelect;

type ReconciliationUnit = Prisma.MarsUnitGetPayload<{
  select: typeof RECONCILIATION_UNIT_SELECT;
}>;

type LatestAuditScan = Prisma.MarsAuditScanGetPayload<{
  select: typeof LATEST_AUDIT_SCAN_SELECT;
}>;

export interface ReconciliationUnitRow {
  requestNumber: string;
  orderNumber: string | null;
  vendor: string | null;
  serialNumber: string | null;
  modelNumber: string | null;
  dateRequested: Date | null;
  returnStatus: string | null;
  staged: boolean;
  lastImportedAt: Date | null;
  lastAuditSeenAt: Date | null;
  reason: string;
}

export interface UnknownScanRow {
  scanId: string;
  scannedValue: string;
  createdAt: Date;
  auditSessionId: string;
  duplicateInSession: boolean;
}

export interface MarsReconciliationResult {
  strictMode: true;
  latestImportBatch: {
    id: string;
    filename: string;
    uploadedAt: Date;
  } | null;
  latestCompletedAudit: {
    id: string;
    startedAt: Date;
    completedAt: Date | null;
  } | null;
  summary: {
    expectedMissing: number;
    physicallyPresentButUnexpected: number;
    staged: number;
    unknownScans: number;
    matched: number;
  };
  expectedMissing: ReconciliationUnitRow[];
  physicallyPresentButUnexpected: ReconciliationUnitRow[];
  staged: ReconciliationUnitRow[];
  unknownScans: UnknownScanRow[];
  matched: ReconciliationUnitRow[];
}

export async function getMarsReconciliation(): Promise<MarsReconciliationResult> {
  const [latestImportBatch, latestCompletedAudit, stagedUnits] = await Promise.all([
    prisma.marsImportBatch.findFirst({
      orderBy: { uploadedAt: "desc" },
      select: {
        id: true,
        filename: true,
        uploadedAt: true,
      },
    }),
    prisma.marsAuditSession.findFirst({
      where: {
        completedAt: {
          not: null,
        },
      },
      orderBy: { completedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.marsUnit.findMany({
      where: { staged: true },
      select: RECONCILIATION_UNIT_SELECT,
      orderBy: { requestNumber: "asc" },
    }),
  ]);

  const latestSnapshotUnits = latestImportBatch
    ? await prisma.marsUnit.findMany({
        where: { lastKnownImportBatchId: latestImportBatch.id },
        select: RECONCILIATION_UNIT_SELECT,
        orderBy: { requestNumber: "asc" },
      })
    : [];

  const latestAuditScans = latestCompletedAudit
    ? await prisma.marsAuditScan.findMany({
        where: { auditSessionId: latestCompletedAudit.id },
        select: LATEST_AUDIT_SCAN_SELECT,
        orderBy: { createdAt: "desc" },
      })
    : [];

  const latestAuditSeenByUnitId = new Map<string, LatestAuditScan>();
  const unknownScans: UnknownScanRow[] = [];

  for (const scan of latestAuditScans) {
    if (!scan.marsUnitId || !scan.marsUnit) {
      unknownScans.push({
        scanId: scan.id,
        scannedValue: scan.scannedValue,
        createdAt: scan.createdAt,
        auditSessionId: scan.auditSessionId,
        duplicateInSession: scan.duplicateInSession,
      });
      continue;
    }

    if (!latestAuditSeenByUnitId.has(scan.marsUnitId)) {
      latestAuditSeenByUnitId.set(scan.marsUnitId, scan);
    }
  }

  const latestSnapshotByUnitId = new Map(latestSnapshotUnits.map((unit) => [unit.id, unit] as const));
  const expectedMissing: ReconciliationUnitRow[] = [];
  const matched: ReconciliationUnitRow[] = [];

  for (const unit of latestSnapshotUnits) {
    const seenScan = latestAuditSeenByUnitId.get(unit.id);
    const expected = isExpectedInWarehouse(unit);

    if (expected && !seenScan) {
      expectedMissing.push(toUnitRow(unit, "Expected in warehouse but not seen in the latest completed audit."));
      continue;
    }

    if (expected && seenScan) {
      matched.push(toUnitRow(unit, "Expected in warehouse and confirmed in the latest completed audit."));
    }
  }

  const physicallyPresentButUnexpected: ReconciliationUnitRow[] = [];
  for (const scan of latestAuditSeenByUnitId.values()) {
    const unit = scan.marsUnit;
    if (!unit) {
      continue;
    }

    if (!latestSnapshotByUnitId.has(unit.id)) {
      physicallyPresentButUnexpected.push(
        toUnitRow(unit, "Seen in the latest completed audit but missing from the latest import snapshot.")
      );
      continue;
    }

    if (!isExpectedInWarehouse(unit)) {
      physicallyPresentButUnexpected.push(
        toUnitRow(unit, "Seen in the latest completed audit but imported statuses indicate it should not still be in warehouse.")
      );
    }
  }

  const staged = stagedUnits.map((unit) =>
    toUnitRow(unit, "Local staged flag is active for this unit.")
  );

  return {
    strictMode: true,
    latestImportBatch,
    latestCompletedAudit,
    summary: {
      expectedMissing: expectedMissing.length,
      physicallyPresentButUnexpected: physicallyPresentButUnexpected.length,
      staged: staged.length,
      unknownScans: unknownScans.length,
      matched: matched.length,
    },
    expectedMissing,
    physicallyPresentButUnexpected,
    staged,
    unknownScans,
    matched,
  };
}

export function isExpectedInWarehouse(unit: {
  returnStatus: string | null;
}) {
  const returnStatus = normalizeStatus(unit.returnStatus);
  if (!returnStatus) {
    return true;
  }

  return !["shipped", "received"].some((term) => returnStatus.includes(term));
}

function normalizeStatus(value: string | null) {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function toUnitRow(unit: ReconciliationUnit, reason: string): ReconciliationUnitRow {
  return {
    requestNumber: unit.requestNumber,
    orderNumber: unit.orderNumber,
    vendor: unit.vendor,
    serialNumber: unit.serialNumber,
    modelNumber: unit.modelNumber,
    dateRequested: unit.dateRequested,
    returnStatus: unit.returnStatus,
    staged: unit.staged,
    lastImportedAt: unit.lastImportedAt,
    lastAuditSeenAt: unit.lastAuditSeenAt,
    reason,
  };
}
