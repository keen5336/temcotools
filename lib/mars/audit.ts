import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isExpectedInWarehouse } from "@/lib/mars/reconciliation";

const AUDIT_FEEDBACK_UNIT_SELECT = {
  id: true,
  requestNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  requestStatus: true,
  returnStatus: true,
  staged: true,
  lastScannedAt: true,
  lastAuditSeenAt: true,
} as const satisfies Prisma.MarsUnitSelect;

const AUDIT_DETAIL_SESSION_SELECT = {
  id: true,
  startedAt: true,
  completedAt: true,
  notes: true,
  startedByUser: {
    select: {
      displayName: true,
      username: true,
    },
  },
  marsAuditScans: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      scannedValue: true,
      matched: true,
      duplicateInSession: true,
      createdAt: true,
      marsUnitId: true,
      marsUnit: {
        select: {
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
          lastKnownImportBatchId: true,
        },
      },
    },
  },
  _count: {
    select: {
      marsAuditScans: true,
    },
  },
} as const satisfies Prisma.MarsAuditSessionSelect;

const AUDIT_LIST_SESSION_SELECT = {
  id: true,
  startedAt: true,
  completedAt: true,
  notes: true,
  startedByUser: {
    select: {
      displayName: true,
      username: true,
    },
  },
  marsAuditScans: {
    select: {
      matched: true,
      duplicateInSession: true,
    },
  },
  _count: {
    select: {
      marsAuditScans: true,
    },
  },
} as const satisfies Prisma.MarsAuditSessionSelect;

type AuditFeedbackUnit = Prisma.MarsUnitGetPayload<{
  select: typeof AUDIT_FEEDBACK_UNIT_SELECT;
}>;

type AuditDetailSessionRecord = Prisma.MarsAuditSessionGetPayload<{
  select: typeof AUDIT_DETAIL_SESSION_SELECT;
}>;

type AuditListSessionRecord = Prisma.MarsAuditSessionGetPayload<{
  select: typeof AUDIT_LIST_SESSION_SELECT;
}>;

export interface MarsAuditSummary {
  totalScans: number;
  matchedScans: number;
  duplicateScans: number;
  unknownScans: number;
}

export interface MarsAuditScanResult {
  scanId: string;
  auditSessionId: string;
  scannedValue: string;
  matched: boolean;
  duplicateInSession: boolean;
  createdAt: Date;
  result: "matched" | "matched_staged" | "duplicate" | "unknown";
  unit: AuditFeedbackUnit | null;
  summary: MarsAuditSummary;
}

export interface SubmittedAuditSessionSummary {
  id: string;
  startedAt: Date;
  completedAt: Date | null;
  scanCount: number;
  summary: MarsAuditSummary;
  startedBy: string | null;
  deviceId: string | null;
  localAuditId: string | null;
  importBatchId: string | null;
  importFilename: string | null;
}

export interface AuditUnitRow {
  requestNumber: string;
  vendor: string | null;
  serialNumber: string | null;
  modelNumber: string | null;
  requestStatus: string | null;
  returnStatus: string | null;
  staged: boolean;
  lastImportedAt: Date | null;
  lastAuditSeenAt: Date | null;
  reason: string;
}

export interface AuditUnknownScanRow {
  scanId: string;
  scannedValue: string;
  createdAt: Date;
  auditSessionId: string;
  duplicateInSession: boolean;
}

export interface MarsAuditDetail {
  session: SubmittedAuditSessionSummary;
  scans: Array<{
    id: string;
    scannedValue: string;
    matched: boolean;
    duplicateInSession: boolean;
    createdAt: Date;
    unit: {
      requestNumber: string;
      vendor: string | null;
      serialNumber: string | null;
      modelNumber: string | null;
      requestStatus: string | null;
      returnStatus: string | null;
      staged: boolean;
    } | null;
  }>;
  report: {
    importBatch: {
      id: string;
      filename: string;
      uploadedAt: Date;
    } | null;
    summary: {
      expectedMissing: number;
      physicallyPresentButUnexpected: number;
      unknownScans: number;
      duplicates: number;
      matched: number;
    };
    expectedMissing: AuditUnitRow[];
    physicallyPresentButUnexpected: AuditUnitRow[];
    unknownScans: AuditUnknownScanRow[];
    duplicates: AuditUnknownScanRow[];
    matched: AuditUnitRow[];
  };
}

interface AuditSessionMetadata {
  schemaVersion: 1;
  deviceId?: string | null;
  localAuditId?: string | null;
  importBatchId?: string | null;
  importFilename?: string | null;
  submittedScanCount?: number | null;
}

export function normalizeAuditScanValue(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

export async function startMarsAuditSession(options: {
  userId?: string | null;
  notes?: string | null;
}) {
  return prisma.marsAuditSession.create({
    data: {
      startedByUserId: options.userId ?? null,
      notes: options.notes?.trim() || null,
    },
    select: {
      id: true,
      startedAt: true,
      notes: true,
    },
  });
}

export async function recordMarsAuditScan(options: {
  auditSessionId: string;
  scannedValue: string;
  userId?: string | null;
}): Promise<MarsAuditScanResult> {
  const normalizedValue = normalizeAuditScanValue(options.scannedValue);
  if (!normalizedValue) {
    throw new Error("Scanned value is required.");
  }

  return prisma.$transaction(async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true, completedAt: true },
    });

    if (!session) {
      throw new Error("Audit session not found.");
    }

    if (session.completedAt) {
      throw new Error("Audit session is already completed.");
    }

    const result = await processAuditScan(tx, {
      auditSessionId: options.auditSessionId,
      scannedValue: normalizedValue,
      userId: options.userId ?? null,
      createdAt: new Date(),
    });

    const summary = await getMarsAuditSummary(tx, options.auditSessionId);

    return {
      scanId: result.scanId,
      auditSessionId: options.auditSessionId,
      scannedValue: result.scannedValue,
      matched: result.matched,
      duplicateInSession: result.duplicateInSession,
      createdAt: result.createdAt,
      result: deriveAuditResult(result.matched, result.duplicateInSession, result.unit),
      unit: result.unit,
      summary,
    };
  });
}

export async function completeMarsAuditSession(options: { auditSessionId: string }) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true, completedAt: true },
    });

    if (!session) {
      throw new Error("Audit session not found.");
    }

    const completedAt = session.completedAt ?? new Date();
    const updated = await tx.marsAuditSession.update({
      where: { id: options.auditSessionId },
      data: { completedAt },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
      },
    });

    const summary = await getMarsAuditSummary(tx, options.auditSessionId);

    return {
      session: updated,
      summary,
    };
  });
}

export async function submitMarsAuditSession(options: {
  scans: string[];
  userId?: string | null;
  deviceId?: string | null;
  localAuditId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}) {
  const normalizedScans = options.scans.map(normalizeAuditScanValue).filter(Boolean);
  if (!normalizedScans.length) {
    throw new Error("At least one scanned value is required.");
  }

  const startedAt = parseOptionalDate(options.startedAt) ?? new Date();
  const completedAt = parseOptionalDate(options.completedAt) ?? new Date();
  const latestImportBatch = await prisma.marsImportBatch.findFirst({
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      uploadedAt: true,
    },
  });

  const metadata: AuditSessionMetadata = {
    schemaVersion: 1,
    deviceId: options.deviceId ?? null,
    localAuditId: options.localAuditId ?? null,
    importBatchId: latestImportBatch?.id ?? null,
    importFilename: latestImportBatch?.filename ?? null,
    submittedScanCount: normalizedScans.length,
  };

  return prisma.$transaction(async (tx) => {
    const session = await tx.marsAuditSession.create({
      data: {
        startedByUserId: options.userId ?? null,
        startedAt,
        completedAt,
        notes: JSON.stringify(metadata),
      },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
      },
    });

    let createdAtCursor = startedAt.getTime();

    for (const scannedValue of normalizedScans) {
      await processAuditScan(tx, {
        auditSessionId: session.id,
        scannedValue,
        userId: options.userId ?? null,
        createdAt: new Date(createdAtCursor),
      });
      createdAtCursor += 1;
    }

    const summary = await getMarsAuditSummary(tx, session.id);
    return { session, summary };
  });
}

export async function listSubmittedMarsAuditSessions(
  limit = 20
): Promise<SubmittedAuditSessionSummary[]> {
  const sessions = await prisma.marsAuditSession.findMany({
    where: {
      completedAt: {
        not: null,
      },
    },
    orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
    select: AUDIT_LIST_SESSION_SELECT,
  });

  return sessions.map(toSubmittedAuditSessionSummary);
}

export async function getMarsAuditDetail(auditSessionId: string): Promise<MarsAuditDetail | null> {
  const session = await prisma.marsAuditSession.findUnique({
    where: { id: auditSessionId },
    select: AUDIT_DETAIL_SESSION_SELECT,
  });

  if (!session) {
    return null;
  }

  const metadata = parseAuditSessionMetadata(session.notes);
  const importBatch = metadata?.importBatchId
    ? await prisma.marsImportBatch.findUnique({
        where: { id: metadata.importBatchId },
        select: {
          id: true,
          filename: true,
          uploadedAt: true,
        },
      })
    : null;

  const snapshotUnits = importBatch
    ? await prisma.marsUnit.findMany({
        where: { lastKnownImportBatchId: importBatch.id },
        select: {
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
        },
        orderBy: { requestNumber: "asc" },
      })
    : [];

  const seenByUnitId = new Map<
    string,
    {
      id: string;
      scannedValue: string;
      duplicateInSession: boolean;
      createdAt: Date;
      marsUnit: NonNullable<AuditDetailSessionRecord["marsAuditScans"][number]["marsUnit"]>;
    }
  >();
  const unknownScans: AuditUnknownScanRow[] = [];
  const duplicates: AuditUnknownScanRow[] = [];

  for (const scan of session.marsAuditScans) {
    if (scan.duplicateInSession) {
      duplicates.push({
        scanId: scan.id,
        scannedValue: scan.scannedValue,
        createdAt: scan.createdAt,
        auditSessionId: session.id,
        duplicateInSession: scan.duplicateInSession,
      });
    }

    if (!scan.marsUnitId || !scan.marsUnit) {
      unknownScans.push({
        scanId: scan.id,
        scannedValue: scan.scannedValue,
        createdAt: scan.createdAt,
        auditSessionId: session.id,
        duplicateInSession: scan.duplicateInSession,
      });
      continue;
    }

    if (!seenByUnitId.has(scan.marsUnitId)) {
      seenByUnitId.set(scan.marsUnitId, {
        id: scan.id,
        scannedValue: scan.scannedValue,
        duplicateInSession: scan.duplicateInSession,
        createdAt: scan.createdAt,
        marsUnit: scan.marsUnit,
      });
    }
  }

  const snapshotByUnitId = new Map(snapshotUnits.map((unit) => [unit.id, unit] as const));
  const expectedMissing: AuditUnitRow[] = [];
  const matched: AuditUnitRow[] = [];

  for (const unit of snapshotUnits) {
    const seenScan = seenByUnitId.get(unit.id);
    if (!isExpectedInWarehouse(unit)) {
      continue;
    }

    if (!seenScan) {
      expectedMissing.push(
        toAuditUnitRow(unit, "Expected in warehouse but not seen in this audit.")
      );
      continue;
    }

    matched.push(toAuditUnitRow(unit, "Expected in warehouse and confirmed by this audit."));
  }

  const physicallyPresentButUnexpected: AuditUnitRow[] = [];
  for (const scan of seenByUnitId.values()) {
    const unit = scan.marsUnit;

    if (!snapshotByUnitId.has(unit.id)) {
      physicallyPresentButUnexpected.push(
        toAuditUnitRow(unit, "Seen in this audit but missing from the import snapshot used at submission.")
      );
      continue;
    }

    if (!isExpectedInWarehouse(unit)) {
      physicallyPresentButUnexpected.push(
        toAuditUnitRow(unit, "Seen in this audit but imported statuses indicate it should not still be in warehouse.")
      );
    }
  }

  return {
    session: toSubmittedAuditSessionSummary(session),
    scans: session.marsAuditScans.map((scan) => ({
      id: scan.id,
      scannedValue: scan.scannedValue,
      matched: scan.matched,
      duplicateInSession: scan.duplicateInSession,
      createdAt: scan.createdAt,
      unit: scan.marsUnit
        ? {
            requestNumber: scan.marsUnit.requestNumber,
            vendor: scan.marsUnit.vendor,
            serialNumber: scan.marsUnit.serialNumber,
            modelNumber: scan.marsUnit.modelNumber,
            requestStatus: scan.marsUnit.requestStatus,
            returnStatus: scan.marsUnit.returnStatus,
            staged: scan.marsUnit.staged,
          }
        : null,
    })),
    report: {
      importBatch,
      summary: {
        expectedMissing: expectedMissing.length,
        physicallyPresentButUnexpected: physicallyPresentButUnexpected.length,
        unknownScans: unknownScans.length,
        duplicates: duplicates.length,
        matched: matched.length,
      },
      expectedMissing,
      physicallyPresentButUnexpected,
      unknownScans,
      duplicates,
      matched,
    },
  };
}

async function processAuditScan(
  tx: Prisma.TransactionClient,
  options: {
    auditSessionId: string;
    scannedValue: string;
    userId: string | null;
    createdAt: Date;
  }
) {
  const duplicateCount = await tx.marsAuditScan.count({
    where: {
      auditSessionId: options.auditSessionId,
      scannedValue: options.scannedValue,
    },
  });

  const duplicateInSession = duplicateCount > 0;
  const matchedUnit = await tx.marsUnit.findUnique({
    where: { requestNumber: options.scannedValue },
    select: AUDIT_FEEDBACK_UNIT_SELECT,
  });

  const scan = await tx.marsAuditScan.create({
    data: {
      auditSessionId: options.auditSessionId,
      scannedValue: options.scannedValue,
      marsUnitId: matchedUnit?.id ?? null,
      matched: Boolean(matchedUnit),
      duplicateInSession,
      userId: options.userId,
      createdAt: options.createdAt,
    },
    select: {
      id: true,
      scannedValue: true,
      matched: true,
      duplicateInSession: true,
      createdAt: true,
    },
  });

  let unit = matchedUnit;

  if (matchedUnit) {
    unit = await tx.marsUnit.update({
      where: { id: matchedUnit.id },
      data: {
        lastScannedAt: options.createdAt,
        lastAuditSeenAt: options.createdAt,
      },
      select: AUDIT_FEEDBACK_UNIT_SELECT,
    });

    await tx.marsEvent.create({
      data: {
        marsUnitId: matchedUnit.id,
        type: "audit_seen",
        userId: options.userId,
        payload: {
          auditSessionId: options.auditSessionId,
          scannedValue: options.scannedValue,
          duplicateInSession,
        },
      },
    });
  }

  return {
    scanId: scan.id,
    scannedValue: scan.scannedValue,
    matched: scan.matched,
    duplicateInSession: scan.duplicateInSession,
    createdAt: scan.createdAt,
    unit: unit ?? null,
  };
}

async function getMarsAuditSummary(
  tx: Prisma.TransactionClient,
  auditSessionId: string
): Promise<MarsAuditSummary> {
  const [totalScans, matchedScans, duplicateScans, unknownScans] = await Promise.all([
    tx.marsAuditScan.count({ where: { auditSessionId } }),
    tx.marsAuditScan.count({ where: { auditSessionId, matched: true } }),
    tx.marsAuditScan.count({ where: { auditSessionId, duplicateInSession: true } }),
    tx.marsAuditScan.count({ where: { auditSessionId, matched: false } }),
  ]);

  return {
    totalScans,
    matchedScans,
    duplicateScans,
    unknownScans,
  };
}

function deriveAuditResult(
  matched: boolean,
  duplicateInSession: boolean,
  unit: AuditFeedbackUnit | null
): MarsAuditScanResult["result"] {
  if (duplicateInSession) {
    return "duplicate";
  }
  if (!matched || !unit) {
    return "unknown";
  }
  return unit.staged ? "matched_staged" : "matched";
}

function toSubmittedAuditSessionSummary(
  session: AuditDetailSessionRecord | AuditListSessionRecord
): SubmittedAuditSessionSummary {
  const metadata = parseAuditSessionMetadata(session.notes);

  return {
    id: session.id,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    scanCount: session._count.marsAuditScans,
    summary: {
      totalScans: session._count.marsAuditScans,
      matchedScans: session.marsAuditScans.filter((scan) => scan.matched).length,
      duplicateScans: session.marsAuditScans.filter((scan) => scan.duplicateInSession).length,
      unknownScans: session.marsAuditScans.filter((scan) => !scan.matched).length,
    },
    startedBy: session.startedByUser?.displayName ?? session.startedByUser?.username ?? null,
    deviceId: metadata?.deviceId ?? null,
    localAuditId: metadata?.localAuditId ?? null,
    importBatchId: metadata?.importBatchId ?? null,
    importFilename: metadata?.importFilename ?? null,
  };
}

function parseAuditSessionMetadata(value: string | null): AuditSessionMetadata | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<AuditSessionMetadata>;
    if (parsed.schemaVersion !== 1) {
      return null;
    }
    return {
      schemaVersion: 1,
      deviceId: parsed.deviceId ?? null,
      localAuditId: parsed.localAuditId ?? null,
      importBatchId: parsed.importBatchId ?? null,
      importFilename: parsed.importFilename ?? null,
      submittedScanCount: parsed.submittedScanCount ?? null,
    };
  } catch {
    return null;
  }
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toAuditUnitRow(
  unit: {
    requestNumber: string;
    vendor: string | null;
    serialNumber: string | null;
    modelNumber: string | null;
    requestStatus: string | null;
    returnStatus: string | null;
    staged: boolean;
    lastImportedAt: Date | null;
    lastAuditSeenAt: Date | null;
  },
  reason: string
): AuditUnitRow {
  return {
    requestNumber: unit.requestNumber,
    vendor: unit.vendor,
    serialNumber: unit.serialNumber,
    modelNumber: unit.modelNumber,
    requestStatus: unit.requestStatus,
    returnStatus: unit.returnStatus,
    staged: unit.staged,
    lastImportedAt: unit.lastImportedAt,
    lastAuditSeenAt: unit.lastAuditSeenAt,
    reason,
  };
}
