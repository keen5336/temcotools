import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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

type AuditFeedbackUnit = Prisma.MarsUnitGetPayload<{
  select: typeof AUDIT_FEEDBACK_UNIT_SELECT;
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

    const duplicateCount = await tx.marsAuditScan.count({
      where: {
        auditSessionId: options.auditSessionId,
        scannedValue: normalizedValue,
      },
    });

    const duplicateInSession = duplicateCount > 0;
    const matchedUnit = await tx.marsUnit.findUnique({
      where: { requestNumber: normalizedValue },
      select: AUDIT_FEEDBACK_UNIT_SELECT,
    });

    const scannedAt = new Date();
    const scan = await tx.marsAuditScan.create({
      data: {
        auditSessionId: options.auditSessionId,
        scannedValue: normalizedValue,
        marsUnitId: matchedUnit?.id ?? null,
        matched: Boolean(matchedUnit),
        duplicateInSession,
        userId: options.userId ?? null,
      },
      select: {
        id: true,
        auditSessionId: true,
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
          lastScannedAt: scannedAt,
          lastAuditSeenAt: scannedAt,
        },
        select: AUDIT_FEEDBACK_UNIT_SELECT,
      });

      await tx.marsEvent.create({
        data: {
          marsUnitId: matchedUnit.id,
          type: "audit_seen",
          userId: options.userId ?? null,
          payload: {
            auditSessionId: options.auditSessionId,
            scannedValue: normalizedValue,
            duplicateInSession,
          },
        },
      });
    }

    const summary = await getMarsAuditSummary(tx, options.auditSessionId);

    return {
      scanId: scan.id,
      auditSessionId: scan.auditSessionId,
      scannedValue: scan.scannedValue,
      matched: scan.matched,
      duplicateInSession: scan.duplicateInSession,
      createdAt: scan.createdAt,
      result: deriveAuditResult(scan.matched, scan.duplicateInSession, unit),
      unit: unit ?? null,
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
