import type { Prisma } from "@prisma/client";
import type { MarsDatabase } from "./access";

type SnapshotUnit = { id: string; requestNumber: string; orderNumber: string | null; vendor: string | null; serialNumber: string | null; modelNumber: string | null; dateRequested: Date | null; returnStatus: string | null; staged: boolean; localStatus: string; lastImportedAt: Date | null; lastAuditSeenAt: Date | null; lastKnownImportBatchId: string | null };
export async function getMarsBatchSnapshot(db: MarsDatabase, batchId: string): Promise<{ units: SnapshotUnit[]; qualification: string }> {
  const batch = await db.marsImportBatch.findUnique({ where: { id: batchId }, select: { uploadedAt: true, coverage: true, scope: true } });
  if (!batch) return { units: [], qualification: "source_batch_missing" };
  const rows = await db.marsImportRow.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } });
  if (!rows.length) return { units: [], qualification: "immutable_batch_rows_not_captured_for_legacy_import; saved reports remain historical evidence; no rows or membership were invented" };
  const byRequest = new Map<string, Prisma.JsonValue>();
  for (const row of rows) if (row.requestNumber) byRequest.set(row.requestNumber, row.fields);
  const current = await db.marsUnit.findMany({ where: { requestNumber: { in: [...byRequest.keys()] } }, select: { id: true, requestNumber: true, staged: true, lastAuditSeenAt: true } });
  const units = current.map(unit => {
    const fields = byRequest.get(unit.requestNumber) as Record<string, unknown>;
    const value = (key: string) => typeof fields[key] === "string" ? fields[key] as string : null;
    const requested = value("dateRequested");
    return { id: unit.id, requestNumber: unit.requestNumber, orderNumber: value("orderNumber"), vendor: value("vendor"), serialNumber: value("serialNumber"), modelNumber: value("modelNumber"), dateRequested: requested ? new Date(requested) : null, returnStatus: value("returnStatus"), staged: unit.staged, localStatus: "active", lastImportedAt: batch.uploadedAt, lastAuditSeenAt: unit.lastAuditSeenAt, lastKnownImportBatchId: batchId };
  });
  return { units, qualification: `immutable_source_rows; operator_declared_${batch.coverage}_coverage; scope=${batch.scope}; local_staged_and_audit_fields_are_current_separate_facts` };
}
