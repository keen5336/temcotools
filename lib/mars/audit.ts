import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeMars, MarsWorkflowError, type MarsWriter, type MarsDatabase } from "./access";
import type { Principal } from "@/lib/auth/principal";
import { recordWorkflowObservation } from "@/lib/warehouse/units";
import { createHash } from "node:crypto";
import { getMarsBatchSnapshot } from "./snapshots";

export type MarsBufferedScan = string | { value: string; scannedAt?: string | null; eventId?: string; capturedByUserId?: string | null; captureSessionId?: string | null; captureMethod?: "scanner" | "manual"; legacyUnassigned?: boolean };
import { classifyMarsUnit } from "@/lib/mars/classification";

const AUDIT_FEEDBACK_UNIT_SELECT = {
  id: true,
  requestNumber: true,
  orderNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  dateRequested: true,
  returnStatus: true,
  staged: true,
  lastScannedAt: true,
  lastAuditSeenAt: true,
} as const satisfies Prisma.MarsUnitSelect;

const AUDIT_DETAIL_SESSION_SELECT = {
  id: true,
  startedAt: true,
  completedAt: true,
  lastAmendedAt: true,
  createdAt: true,
  updatedAt: true,
  notes: true,
  startedByUser: {
    select: {
      displayName: true,
      username: true,
    },
  },
  marsAuditScans: {
    where: { voidedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      scannedValue: true,
      matched: true,
      duplicateInSession: true,
      manualEntry: true,
      createdAt: true,
      capturedAt: true,
      captureMethod: true,
      captureSessionId: true,
      captureProvenance: true,
      warehouseObservationId: true,
      userId: true,
      marsUnitId: true,
      marsUnit: {
        select: {
          id: true,
          requestNumber: true,
          orderNumber: true,
          vendor: true,
          serialNumber: true,
          modelNumber: true,
          dateRequested: true,
          returnStatus: true,
          staged: true,
          localStatus: true,
          lastImportedAt: true,
          lastAuditSeenAt: true,
          lastKnownImportBatchId: true,
        },
      },
    },
  },
  marsAuditReports: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      label: true,
      createdAt: true,
      summary: true,
      payload: true,
      generatedByUser: {
        select: {
          displayName: true,
          username: true,
        },
      },
      importBatch: {
        select: {
          id: true,
          filename: true,
          uploadedAt: true,
        },
      },
    },
  },
  _count: {
    select: {
      marsAuditScans: { where: { voidedAt: null } },
    },
  },
} as const satisfies Prisma.MarsAuditSessionSelect;

const AUDIT_LIST_SESSION_SELECT = {
  id: true,
  startedAt: true,
  completedAt: true,
  lastAmendedAt: true,
  notes: true,
  startedByUser: {
    select: {
      displayName: true,
      username: true,
    },
  },
  marsAuditScans: {
    where: { voidedAt: null },
    select: {
      matched: true,
      duplicateInSession: true,
    },
  },
  _count: {
    select: {
      marsAuditScans: { where: { voidedAt: null } },
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
  lastAmendedAt: Date | null;
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

export interface AuditUnknownScanRow {
  scanId: string;
  scannedValue: string;
  createdAt: Date;
  auditSessionId: string;
  duplicateInSession: boolean;
}

export interface MarsAuditDetail {
  session: SubmittedAuditSessionSummary;
  voidedScans: Array<{ id: string; scannedValue: string; createdAt: Date; voidedAt: Date | null; voidedByUserId: string | null; voidReason: string | null }>;
  scans: Array<{
    id: string;
    scannedValue: string;
    matched: boolean;
    duplicateInSession: boolean;
    manualEntry: boolean;
    createdAt: Date;
    capturedAt: Date | null;
    captureMethod: string | null;
    captureSessionId: string | null;
    captureProvenance: string;
    warehouseObservationId: string | null;
    userId: string | null;
    unit: {
      requestNumber: string;
      orderNumber: string | null;
      vendor: string | null;
      serialNumber: string | null;
      modelNumber: string | null;
      dateRequested: Date | null;
      returnStatus: string | null;
      staged: boolean;
    } | null;
  }>;
  currentReport: MarsAuditReportPayload;
  savedReports: MarsSavedAuditReport[];
}

export interface MarsAuditReportPayload {
  sourceQualification?: string;
  physicalEvidenceQualification?: string;
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
}

export interface MarsSavedAuditReport {
  id: string;
  label: string | null;
  createdAt: Date;
  generatedBy: string | null;
  importBatch: {
    id: string;
    filename: string;
    uploadedAt: Date;
  } | null;
  summary: MarsAuditReportPayload["summary"];
  payload: MarsAuditReportPayload;
}

interface BuiltAuditReport {
  payload: MarsAuditReportPayload;
  importBatchId: string | null;
}

interface MarsAuditScanRecordInput extends MarsWriter {
  auditSessionId: string;
  scannedValue: string;
  userId?: string | null;
  manualEntry?: boolean;
}

interface MarsAuditScanRecord {
  id: string;
  scannedValue: string;
  matched: boolean;
  duplicateInSession: boolean;
  manualEntry: boolean;
  createdAt: Date;
  unit: AuditFeedbackUnit | null;
}

export interface MarsAuditReportGenerationResult {
  reportId: string;
  auditSessionId: string;
  label: string | null;
  createdAt: Date;
  payload: MarsAuditReportPayload;
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
} & MarsWriter) {
  return writeMars(options, async (tx) => {
    const batch = await tx.marsImportBatch.findFirst({ orderBy: [{ uploadedAt: "desc" }, { id: "desc" }], select: { id: true, filename: true } });
    return tx.marsAuditSession.create({
    data: {
      startedByUserId: options.principal.userId,
      notes: JSON.stringify({ schemaVersion: 1, importBatchId: batch?.id ?? null, importFilename: batch?.filename ?? null, operatorNotes: options.notes?.trim() || null }),
    },
    select: {
      id: true,
      startedAt: true,
      notes: true,
    },
    });
  });
}

export async function recordMarsAuditScan(options: {
  auditSessionId: string;
  scannedValue: string;
  userId?: string | null;
} & MarsWriter): Promise<MarsAuditScanResult> {
  const normalizedValue = normalizeAuditScanValue(options.scannedValue);
  if (!normalizedValue) {
    throw new MarsWorkflowError("Scanned value is required.");
  }

  return writeMars(options, async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true, completedAt: true },
    });

    if (!session) {
      throw new MarsWorkflowError("Audit session not found.");
    }

    if (session.completedAt) throw new MarsWorkflowError("Audit session is already completed.");
    const result = await processAuditScan(tx, {
      auditSessionId: options.auditSessionId,
      scannedValue: normalizedValue,
      userId: options.principal.userId,
      createdAt: new Date(),
      manualEntry: false,
      principal: options.principal,
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

export async function completeMarsAuditSession(options: { auditSessionId: string } & MarsWriter) {
  return writeMars(options, async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true, completedAt: true },
    });

    if (!session) {
      throw new MarsWorkflowError("Audit session not found.");
    }

    const completedAt = session.completedAt ?? new Date();
    const updated = await tx.marsAuditSession.update({
      where: { id: options.auditSessionId },
      data: {
        completedAt,
        lastAmendedAt: new Date(),
      },
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
  scans: MarsBufferedScan[];
  userId?: string | null;
  deviceId?: string | null;
  localAuditId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
} & MarsWriter) {
  const normalizedScans = options.scans.map(scan => typeof scan === "string" ? { value: normalizeAuditScanValue(scan), legacyUnassigned: true } : { ...scan, value: normalizeAuditScanValue(scan.value) }).filter(scan => scan.value);
  if (!normalizedScans.length) {
    throw new MarsWorkflowError("At least one scanned value is required.");
  }

  const startedAt = parseOptionalDate(options.startedAt) ?? new Date();
  const completedAt = parseOptionalDate(options.completedAt) ?? new Date();
  const latestImportBatch = await (options.transaction ?? prisma).marsImportBatch.findFirst({
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

  return writeMars(options, async (tx) => {
    const sourceDraftId = options.deviceId && options.localAuditId ? createHash("sha256").update(JSON.stringify([options.deviceId,options.localAuditId])).digest("hex") : null;
    const sourceDraftFingerprint = createHash("sha256").update(JSON.stringify({ scans: normalizedScans, startedAt: options.startedAt, completedAt: options.completedAt })).digest("hex");
    if (sourceDraftId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mars-draft:${sourceDraftId}`},0))`;
      const previous = await tx.marsAuditSession.findUnique({ where: { sourceDraftId }, select: { id: true, startedAt: true, completedAt: true, sourceDraftFingerprint: true } });
      if (previous) {
        if (previous.sourceDraftFingerprint !== sourceDraftFingerprint) throw new MarsWorkflowError("This local draft was already submitted with different evidence. Review its original retained audit.");
        return { session: { id: previous.id, startedAt: previous.startedAt, completedAt: previous.completedAt }, summary: await getMarsAuditSummary(tx, previous.id) };
      }
    }
    const session = await tx.marsAuditSession.create({
      data: {
        startedByUserId: options.principal.userId,
        startedAt,
        completedAt,
        lastAmendedAt: completedAt,
        notes: JSON.stringify(metadata),
        sourceDraftId,
        sourceDraftFingerprint,
      },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
      },
    });

    let createdAtCursor = startedAt.getTime();

    for (const scan of normalizedScans) {
      const capturedAt = scan.scannedAt ? new Date(scan.scannedAt) : null;
      const legacy = Boolean(scan.legacyUnassigned);
      if (!legacy) {
        if (!capturedAt || !Number.isFinite(capturedAt.getTime()) || scan.capturedByUserId !== options.principal.userId || !scan.captureSessionId || capturedAt < startedAt || capturedAt > completedAt || capturedAt.getTime() > Date.now() + 300_000) throw new MarsWorkflowError("A physical buffered capture needs its original user, individual session and timestamp within the audit period. Unassigned legacy history cannot become a new person's physical observation.");
        const captureSession = await tx.userSession.findUnique({ where: { id: scan.captureSessionId }, select: { userId: true, createdAt: true, expiresAt: true, revokedAt: true, lockedAt: true } });
        if (!captureSession || captureSession.userId !== options.principal.userId || capturedAt < captureSession.createdAt || capturedAt > captureSession.expiresAt || (captureSession.revokedAt && capturedAt >= captureSession.revokedAt) || (captureSession.lockedAt && capturedAt >= captureSession.lockedAt)) throw new MarsWorkflowError("The buffered capture is not bound to this operator's valid original session.");
      }
      await processAuditScan(tx, {
        auditSessionId: session.id,
        scannedValue: scan.value,
        userId: legacy ? null : options.principal.userId,
        createdAt: capturedAt && Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date(createdAtCursor),
        manualEntry: legacy || scan.captureMethod !== "scanner",
        principal: options.principal,
        captureProvenance: legacy ? "legacy_unassigned" : "user_bound_capture",
        actualCapturedAt: capturedAt && Number.isFinite(capturedAt.getTime()) ? capturedAt : null,
        captureSessionId: legacy ? null : scan.captureSessionId,
        eventId: scan.eventId,
      });
      createdAtCursor += 1;
    }

    const summary = await getMarsAuditSummary(tx, session.id);
    return { session, summary };
  });
}

export async function recordMarsUnitSighting(options: {
  requestNumber: string;
  userId?: string | null;
  eventId?: string;
} & MarsWriter) {
  const normalizedValue = normalizeAuditScanValue(options.requestNumber);
  if (!normalizedValue) {
    throw new MarsWorkflowError("Request number is required.");
  }

  return writeMars(options, async (tx) => {
    const unit = await tx.marsUnit.findUnique({
      where: { requestNumber: normalizedValue },
      select: AUDIT_FEEDBACK_UNIT_SELECT,
    });

    if (!unit) {
      const seenAt = new Date();
      const warehouseObservation = await recordWorkflowObservation(tx, options.principal, { eventId: options.eventId ?? `mars-sighting:${crypto.randomUUID()}`, rawIdentifier: normalizedValue, identifierType: "submission", namespace: "mars", type: "presence", capturedAt: seenAt.toISOString(), capturedByUserId: options.principal.userId, captureMethod: "manual" });
      return { seenAt, unit: null, warehouseObservation };
    }

    const seenAt = new Date();
    const updated = await tx.marsUnit.update({
      where: { id: unit.id },
      data: {
        lastScannedAt: seenAt,
        lastAuditSeenAt: seenAt,
      },
      select: AUDIT_FEEDBACK_UNIT_SELECT,
    });

    const sighting = await tx.marsEvent.create({
      data: {
        marsUnitId: unit.id,
        type: "manual_seen",
        userId: options.principal.userId,
        payload: {
          requestNumber: normalizedValue,
          seenAt,
        },
      },
    });

    const warehouseObservation = await recordWorkflowObservation(tx, options.principal, { eventId: options.eventId ?? `mars-sighting:${sighting.id}`, rawIdentifier: normalizedValue, identifierType: "submission", namespace: "mars", type: "presence", capturedAt: seenAt.toISOString(), capturedByUserId: options.principal.userId, captureMethod: "manual" });

    return {
      seenAt,
      unit: updated,
      warehouseObservation,
    };
  });
}

export async function listSubmittedMarsAuditSessions(
  limit = 20, db: MarsDatabase = prisma
): Promise<SubmittedAuditSessionSummary[]> {
  const sessions = await db.marsAuditSession.findMany({
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

export async function addMarsAuditScan(
  options: MarsAuditScanRecordInput
): Promise<MarsAuditScanRecord & { summary: MarsAuditSummary }> {
  const normalizedValue = normalizeAuditScanValue(options.scannedValue);
  if (!normalizedValue) {
    throw new MarsWorkflowError("Scanned value is required.");
  }

  return writeMars(options, async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true },
    });

    if (!session) {
      throw new MarsWorkflowError("Audit session not found.");
    }

    const result = await processAuditScan(tx, {
      auditSessionId: options.auditSessionId,
      scannedValue: normalizedValue,
      userId: options.principal.userId,
      createdAt: new Date(),
      manualEntry: options.manualEntry ?? true,
      principal: options.principal,
    });

    await tx.marsAuditSession.update({
      where: { id: options.auditSessionId },
      data: { lastAmendedAt: new Date() },
    });

    const summary = await getMarsAuditSummary(tx, options.auditSessionId);

    return {
      id: result.scanId,
      scannedValue: result.scannedValue,
      matched: result.matched,
      duplicateInSession: result.duplicateInSession,
      manualEntry: result.manualEntry,
      createdAt: result.createdAt,
      unit: result.unit,
      summary,
    };
  });
}

export async function deleteMarsAuditScan(options: {
  auditSessionId: string;
  scanId: string;
  reason?: string;
} & MarsWriter) {
  return writeMars(options, async (tx) => {
    const scan = await tx.marsAuditScan.findFirst({
      where: {
        id: options.scanId,
        auditSessionId: options.auditSessionId,
      },
      select: {
        id: true,
      },
    });

    if (!scan) {
      throw new MarsWorkflowError("Audit scan not found.");
    }

    await tx.marsAuditScan.updateMany({
      where: { id: options.scanId, voidedAt: null },
      data: { voidedAt: new Date(), voidedByUserId: options.principal.userId, voidReason: options.reason?.trim() || "Removed from active audit by an authorized operator; original evidence retained." },
    });

    await recomputeDuplicateFlags(tx, options.auditSessionId);
    await tx.marsAuditSession.update({
      where: { id: options.auditSessionId },
      data: { lastAmendedAt: new Date() },
    });

    return {
      scanId: options.scanId,
      physicalObservationRetained: true,
      correctionMeaning: "Audit membership was voided. Any original physical observation remains evidence; retract or correct it through the authorized warehouse observation review.",
      summary: await getMarsAuditSummary(tx, options.auditSessionId),
    };
  });
}

export async function generateMarsAuditReport(options: {
  auditSessionId: string;
  userId?: string | null;
  label?: string | null;
} & MarsWriter): Promise<MarsAuditReportGenerationResult> {
  return writeMars(options, async (tx) => {
    const session = await tx.marsAuditSession.findUnique({
      where: { id: options.auditSessionId },
      select: { id: true },
    });

    if (!session) {
      throw new MarsWorkflowError("Audit session not found.");
    }

    const built = await buildAuditReport(tx, options.auditSessionId);
    const report = await tx.marsAuditReport.create({
      data: {
        auditSessionId: options.auditSessionId,
        importBatchId: built.importBatchId,
        generatedByUserId: options.principal.userId,
        label: options.label?.trim() || null,
        summary: built.payload.summary,
        payload: built.payload as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        label: true,
        createdAt: true,
      },
    });

    return {
      reportId: report.id,
      auditSessionId: options.auditSessionId,
      label: report.label,
      createdAt: report.createdAt,
      payload: built.payload,
    };
  });
}

export async function getMarsAuditDetail(auditSessionId: string, db: MarsDatabase = prisma): Promise<MarsAuditDetail | null> {
  const session = await db.marsAuditSession.findUnique({
    where: { id: auditSessionId },
    select: AUDIT_DETAIL_SESSION_SELECT,
  });

  if (!session) {
    return null;
  }

  const built = await buildAuditReport(db, auditSessionId);

  return {
    session: toSubmittedAuditSessionSummary(session),
    scans: session.marsAuditScans.map((scan) => ({
      id: scan.id,
      scannedValue: scan.scannedValue,
      matched: scan.matched,
      duplicateInSession: scan.duplicateInSession,
      manualEntry: scan.manualEntry,
      createdAt: scan.createdAt,
      capturedAt: scan.capturedAt,
      captureMethod: scan.captureMethod,
      captureSessionId: scan.captureSessionId,
      captureProvenance: scan.captureProvenance,
      warehouseObservationId: scan.warehouseObservationId,
      userId: scan.userId,
      unit: scan.marsUnit
        ? {
            requestNumber: scan.marsUnit.requestNumber,
            orderNumber: scan.marsUnit.orderNumber,
            vendor: scan.marsUnit.vendor,
            serialNumber: scan.marsUnit.serialNumber,
            modelNumber: scan.marsUnit.modelNumber,
            dateRequested: scan.marsUnit.dateRequested,
            returnStatus: scan.marsUnit.returnStatus,
            staged: scan.marsUnit.staged,
          }
        : null,
    })),
    currentReport: built.payload,
    voidedScans: await db.marsAuditScan.findMany({ where: { auditSessionId, voidedAt: { not: null } }, select: { id: true, scannedValue: true, createdAt: true, voidedAt: true, voidedByUserId: true, voidReason: true }, orderBy: { voidedAt: "desc" } }),
    savedReports: session.marsAuditReports.map((report) => ({
      id: report.id,
      label: report.label,
      createdAt: report.createdAt,
      generatedBy:
        report.generatedByUser?.displayName ?? report.generatedByUser?.username ?? null,
      importBatch: report.importBatch,
      summary: report.summary as unknown as MarsAuditReportPayload["summary"],
      payload: report.payload as unknown as MarsAuditReportPayload,
    })),
  };
}

async function processAuditScan(
  tx: Prisma.TransactionClient,
  options: {
    auditSessionId: string;
    scannedValue: string;
    userId: string | null;
    createdAt: Date;
    manualEntry: boolean;
    principal: Principal;
    captureProvenance?: "user_bound_capture" | "legacy_unassigned";
    actualCapturedAt?: Date | null;
    captureSessionId?: string | null;
    eventId?: string;
  }
) {
  const duplicateCount = await tx.marsAuditScan.count({
    where: {
      auditSessionId: options.auditSessionId,
      voidedAt: null,
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
      voidedAt: null,
      scannedValue: options.scannedValue,
      marsUnitId: matchedUnit?.id ?? null,
      matched: Boolean(matchedUnit),
      duplicateInSession,
      manualEntry: options.manualEntry,
      userId: options.userId,
      createdAt: options.createdAt,
      capturedAt: options.captureProvenance === "legacy_unassigned" ? options.actualCapturedAt ?? null : options.createdAt,
      captureMethod: options.manualEntry ? "manual" : "scanner",
      captureSessionId: options.captureSessionId ?? (options.captureProvenance === "legacy_unassigned" ? null : options.principal.sessionId),
      captureProvenance: options.captureProvenance ?? "user_bound_capture",
    },
    select: {
      id: true,
      scannedValue: true,
      matched: true,
      duplicateInSession: true,
      createdAt: true,
    },
  });

  if (options.captureProvenance !== "legacy_unassigned") {
    const observation = await recordWorkflowObservation(tx, options.principal, { eventId: options.eventId ?? `mars-audit:${scan.id}`, rawIdentifier: options.scannedValue, identifierType: "submission", namespace: "mars", type: "presence", capturedAt: options.createdAt.toISOString(), capturedByUserId: options.principal.userId, captureMethod: options.manualEntry ? "manual" : "scanner" });
    await tx.marsAuditScan.update({ where: { id: scan.id }, data: { warehouseObservationId: observation.observation.observationId } });
  }

  let unit = matchedUnit;

  if (matchedUnit && options.captureProvenance !== "legacy_unassigned") {
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
    manualEntry: options.manualEntry,
    createdAt: scan.createdAt,
    unit: unit ?? null,
  };
}

async function recomputeDuplicateFlags(
  tx: Prisma.TransactionClient,
  auditSessionId: string
) {
  const scans = await tx.marsAuditScan.findMany({
    where: { auditSessionId, voidedAt: null },
    select: {
      id: true,
      scannedValue: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const seen = new Set<string>();
  for (const scan of scans) {
    const duplicateInSession = seen.has(scan.scannedValue);
    seen.add(scan.scannedValue);

    await tx.marsAuditScan.update({
      where: { id: scan.id },
      data: { duplicateInSession },
    });
  }
}

async function getMarsAuditSummary(
  tx: Prisma.TransactionClient,
  auditSessionId: string
): Promise<MarsAuditSummary> {
  const [totalScans, matchedScans, duplicateScans, unknownScans] = await Promise.all([
    tx.marsAuditScan.count({ where: { auditSessionId, voidedAt: null } }),
    tx.marsAuditScan.count({ where: { auditSessionId, voidedAt: null, matched: true } }),
    tx.marsAuditScan.count({ where: { auditSessionId, voidedAt: null, duplicateInSession: true } }),
    tx.marsAuditScan.count({ where: { auditSessionId, voidedAt: null, matched: false } }),
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

async function buildAuditReport(
  db: Prisma.TransactionClient | typeof prisma,
  auditSessionId: string
): Promise<BuiltAuditReport> {
  const session = await db.marsAuditSession.findUnique({
    where: { id: auditSessionId },
    select: AUDIT_DETAIL_SESSION_SELECT,
  });

  if (!session) {
    throw new MarsWorkflowError("Audit session not found.");
  }

  const metadata = parseAuditSessionMetadata(session.notes);
  const importBatch = metadata?.importBatchId
    ? await db.marsImportBatch.findUnique({
        where: { id: metadata.importBatchId },
        select: {
          id: true,
          filename: true,
          uploadedAt: true,
        },
      })
    : null;

  const capturedSnapshot = importBatch ? await getMarsBatchSnapshot(db, importBatch.id) : { units: [], qualification: "No pinned import batch is available." };
  const snapshotUnits = capturedSnapshot.units;

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
    const classification = classifyMarsUnit(unit, { seenInAudit: Boolean(seenScan) });
    if (!classification.expectedInWarehouse) {
      continue;
    }

    if (!seenScan) {
      expectedMissing.push(
        toAuditUnitRow(
          unit,
          `${classification.label}: expected in warehouse but not seen in this audit.`
        )
      );
      continue;
    }

    matched.push(
      toAuditUnitRow(unit, `${classification.label}: expected in warehouse and confirmed by this audit.`)
    );
  }

  const physicallyPresentButUnexpected: AuditUnitRow[] = [];
  for (const scan of seenByUnitId.values()) {
    const unit = snapshotByUnitId.get(scan.marsUnit.id) ?? scan.marsUnit;

    const classification = classifyMarsUnit(unit, { seenInAudit: true });

    if (!snapshotByUnitId.has(unit.id)) {
      physicallyPresentButUnexpected.push(
        toAuditUnitRow(
          unit,
          unit.localStatus === "deleted"
            ? "Seen in this audit but this submission was deleted from MARS and archived locally."
            : "Seen in this audit but missing from the import snapshot used for this session."
        )
      );
      continue;
    }

    if (!classification.expectedInWarehouse || classification.bucket === "problem") {
      physicallyPresentButUnexpected.push(
        toAuditUnitRow(
          unit,
          classification.problemReasons[0] ??
            `${classification.label}: seen in this audit but not expected in warehouse.`
        )
      );
    }
  }

  return {
    importBatchId: importBatch?.id ?? null,
    payload: {
      sourceQualification: capturedSnapshot.qualification,
      physicalEvidenceQualification: session.marsAuditScans.every(scan => scan.captureProvenance === "user_bound_capture") ? "Individual-session captures; sightings are separate from departure/external status." : "Historical or unsigned captures are included; this report does not establish current attributed warehouse presence.",
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

function toSubmittedAuditSessionSummary(
  session: AuditDetailSessionRecord | AuditListSessionRecord
): SubmittedAuditSessionSummary {
  const metadata = parseAuditSessionMetadata(session.notes);

  return {
    id: session.id,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    lastAmendedAt: session.lastAmendedAt ?? null,
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
    orderNumber: string | null;
    vendor: string | null;
    serialNumber: string | null;
    modelNumber: string | null;
    dateRequested: Date | null;
    returnStatus: string | null;
    staged: boolean;
    localStatus?: string;
    lastImportedAt: Date | null;
    lastAuditSeenAt: Date | null;
  },
  reason: string
): AuditUnitRow {
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
