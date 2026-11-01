import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertCapability, type Capability, type Principal } from "@/lib/auth/principal";
import * as inventory from "./inventory";
import * as audit from "./audit";
import { importMarsWorkbook, MarsImportValidationError, type WorkbookInputBuffer } from "./import";
import { getMarsReconciliation } from "./reconciliation";
import { MARS_OPERATIONAL_BUCKETS } from "./classification";
import { MarsWorkflowError } from "./access";

export { MarsWorkflowError } from "./access";
export const marsId = z.string().trim().min(1).max(200);
export const marsOperation = z.string().trim().min(1).max(150);
export const marsEvidence = z.string().trim().min(5).max(2000);
const nullableText = z.string().max(300).nullable().optional();
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function failure(error: unknown): never {
  if (error instanceof z.ZodError || error instanceof MarsImportValidationError || (error instanceof Error && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500)) throw error;
  throw new MarsWorkflowError("MARS work could not be completed. Retain the operation ID and inspect its original receipt before retrying.", 503);
}
export const marsFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function queryMars<T>(principal: Principal, handler: (tx: Prisma.TransactionClient) => Promise<T>) {
  assertCapability(principal, "workflow.read");
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, principal, "workflow.read"); return handler(tx); }, { timeout: 60_000 }).catch(failure);
}
export async function commandMars<T extends object>(principal: Principal, operationId: string, action: string, input: unknown, handler: (tx: Prisma.TransactionClient) => Promise<T>, capability: Capability = "workflow.execute") {
  assertCapability(principal, capability);
  const fingerprint = marsFingerprint({ action, input });
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, capability);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mars-command:${principal.userId}:${operationId}`},0))`;
    const existing = await tx.marsCommandReceipt.findUnique({ where: { userId_operationId: { userId: principal.userId, operationId } } });
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.action !== action) throw new MarsWorkflowError("This operation ID already belongs to different MARS work.", 409);
      return { ...(existing.result as T), replayed: true };
    }
    const result = json(await handler(tx)) as T;
    await tx.marsCommandReceipt.create({ data: { userId: principal.userId, operationId, action, fingerprint, result: json(result) } });
    return { ...result, replayed: false };
  }, { timeout: 60_000 }).catch(failure);
}

const listSchema = z.object({ q: nullableText, requestNumber: nullableText, orderNumber: nullableText, vendor: nullableText, serialNumber: nullableText, modelNumber: nullableText, vendorRaNumber: nullableText, requestStatus: nullableText, returnStatus: nullableText, replacementNeeded: nullableText,
  staged: z.boolean().nullable().optional(), archived: z.boolean().nullable().optional(), bucket: z.enum(MARS_OPERATIONAL_BUCKETS).nullable().optional(), needsAttentionOnly: z.boolean().optional(), returnStatusMode: z.enum(["exclude_received","all","received_only"]).optional(), dateRequestedOn: nullableText, lastImportedOn: nullableText, lastAuditSeenOn: nullableText,
  sortBy: z.enum(["requestNumber","orderNumber","vendor","serialNumber","modelNumber","vendorRaNumber","dateRequested","requestStatus","returnStatus","replacementNeeded","staged","lastImportedAt","lastAuditSeenAt","updatedAt"]).optional(), sortDirection: z.enum(["asc","desc"]).optional(), page: z.number().int().min(1).max(100000).default(1), limit: z.number().int().min(1).max(200).default(25),
}).strict();
export async function listMarsInventory(principal: Principal, raw: unknown = {}) { const input = listSchema.parse(raw); return queryMars(principal, tx => inventory.listMarsUnits(input, tx)); }
export async function getMarsSubmission(principal: Principal, raw: unknown) { const { requestNumber } = z.object({ requestNumber: marsId }).strict().parse(raw); return queryMars(principal, tx => inventory.getMarsUnitDetail(requestNumber, tx)); }
export async function getMarsOverview(principal: Principal) { return queryMars(principal, tx => inventory.getMarsOperationalOverview(tx)); }
export async function getMarsImports(principal: Principal, raw: unknown = {}) { const { limit } = z.object({ limit: z.number().int().min(1).max(20).default(5) }).strict().parse(raw); return queryMars(principal, tx => inventory.getRecentMarsImportBatches(limit, tx)); }
export async function getMarsBuckets(principal: Principal) { return queryMars(principal, tx => inventory.getMarsWorkflowBucketSummaries(tx)); }
export async function reconcileMarsInventory(principal: Principal) { return queryMars(principal, tx => getMarsReconciliation(tx)); }
export async function getMarsAudits(principal: Principal, raw: unknown = {}) { const { limit } = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict().parse(raw); return queryMars(principal, tx => audit.listSubmittedMarsAuditSessions(limit, tx)); }
export async function getMarsAudit(principal: Principal, raw: unknown) { const { auditSessionId } = z.object({ auditSessionId: marsId }).strict().parse(raw); return queryMars(principal, tx => audit.getMarsAuditDetail(auditSessionId, tx)); }
export async function getMarsSourceRows(principal: Principal, raw: unknown) {
  const input = z.object({ batchId: marsId.optional(), requestNumber: marsId.optional(), afterId: marsId.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict().refine(value => Boolean(value.batchId || value.requestNumber), "Choose a batch or submission.").parse(raw);
  return queryMars(principal, async tx => { const rows = await tx.marsImportRow.findMany({ where: { batchId: input.batchId, requestNumber: input.requestNumber, ...(input.afterId ? { id: { gt: input.afterId } } : {}) }, include: { batch: { select: { filename: true, scope: true, coverage: true, sourceAsOf: true, uploadedAt: true } } }, orderBy: { id: "asc" }, take: input.limit + 1 }); const items = rows.slice(0,input.limit); return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null, qualification: "Original retained new-batch source rows. Legacy batches without captured rows cannot be reconstructed from the current pointer." }; });
}

export async function importMarsInventory(principal: Principal, raw: unknown) {
  const input = z.object({ operationId: marsOperation, filename: z.string().trim().min(1).max(255), fileBase64: z.string().min(1).max(28_000_000), scope: z.string().trim().min(1).max(150).default("warehouse"), coverage: z.enum(["partial","complete"]).default("partial"), sourceAsOf: z.string().datetime({ offset: true }).optional(), coverageEvidence: z.string().trim().max(2000).optional() }).strict().parse(raw);
  const fileBuffer = Buffer.from(input.fileBase64, "base64");
  if (fileBuffer.length > 20 * 1024 * 1024 || fileBuffer.toString("base64") !== input.fileBase64) throw new MarsImportValidationError("Use a valid workbook of at most 20 MiB.");
  return commandMars(principal, input.operationId, "import", { ...input, fileBase64: marsFingerprint(input.fileBase64) }, tx => importMarsWorkbook({ ...input, principal, transaction: tx, fileBuffer: fileBuffer as unknown as WorkbookInputBuffer }));
}
export async function stageMarsSubmission(principal: Principal, raw: unknown) {
  const input = z.object({ operationId: marsOperation, requestNumber: marsId, staged: z.boolean() }).strict().parse(raw);
  return commandMars(principal, input.operationId, "stage", input, async tx => ({ unit: await inventory.setMarsUnitStaged({ ...input, principal, transaction: tx }) }));
}
export async function archiveMarsSubmission(principal: Principal, raw: unknown) {
  const input = z.object({ operationId: marsOperation, requestNumber: marsId, archived: z.boolean(), reason: z.string().trim().max(2000).nullable().optional() }).strict().parse(raw);
  return commandMars(principal, input.operationId, "archive", input, async tx => ({ unit: await inventory.setMarsUnitArchived({ ...input, principal, transaction: tx }) }));
}
export async function startMarsAudit(principal: Principal, raw: unknown) {
  const input = z.object({ operationId: marsOperation, notes: z.string().max(4000).nullable().optional() }).strict().parse(raw);
  return commandMars(principal, input.operationId, "audit.start", input, async tx => ({ auditSession: await audit.startMarsAuditSession({ ...input, principal, transaction: tx }) }));
}
const scan = z.object({ operationId: marsOperation, auditSessionId: marsId, scannedValue: z.string().trim().min(1).max(500) }).strict();
export async function scanMarsAudit(principal: Principal, raw: unknown) { const input = scan.parse(raw); return commandMars(principal, input.operationId, "audit.scan", input, tx => audit.recordMarsAuditScan({ ...input, principal, transaction: tx })); }
export async function amendMarsAudit(principal: Principal, raw: unknown) {
  const input = scan.extend({ manualEntry: z.boolean().default(true) }).parse(raw);
  return commandMars(principal, input.operationId, "audit.amend", input, async tx => ({ ...await audit.addMarsAuditScan({ ...input, principal, transaction: tx }), detail: await audit.getMarsAuditDetail(input.auditSessionId, tx) }));
}
export async function completeMarsAudit(principal: Principal, raw: unknown) { const input = z.object({ operationId: marsOperation, auditSessionId: marsId }).strict().parse(raw); return commandMars(principal, input.operationId, "audit.complete", input, tx => audit.completeMarsAuditSession({ ...input, principal, transaction: tx })); }
export async function submitMarsAudit(principal: Principal, raw: unknown) {
  const buffered = z.object({ value: z.string().trim().min(1).max(500), scannedAt: z.string().datetime({ offset: true }).nullable().optional(), eventId: marsOperation.optional(), capturedByUserId: marsId.nullable().optional(), captureSessionId: marsId.nullable().optional(), captureMethod: z.enum(["scanner","manual"]).optional(), legacyUnassigned: z.boolean().optional() }).strict();
  const input = z.object({ operationId: marsOperation, scans: z.array(z.union([z.string().trim().min(1).max(500), buffered])).min(1).max(20000), deviceId: marsId.nullable().optional(), localAuditId: marsId.nullable().optional(), startedAt: z.string().datetime({ offset: true }).nullable().optional(), completedAt: z.string().datetime({ offset: true }).nullable().optional() }).strict().parse(raw);
  if (input.startedAt && input.completedAt && Date.parse(input.completedAt) < Date.parse(input.startedAt)) throw new MarsWorkflowError("Audit completion cannot precede its start.");
  if ([input.startedAt,input.completedAt].some(value => value && Date.parse(value)>Date.now()+300000)) throw new MarsWorkflowError("Audit time cannot be more than five minutes in the future.");
  return commandMars(principal, input.operationId, "audit.submit", input, tx => audit.submitMarsAuditSession({ ...input, principal, transaction: tx }));
}
export async function sightMarsSubmission(principal: Principal, raw: unknown) { const input = z.object({ operationId: marsOperation, requestNumber: marsId }).strict().parse(raw); return commandMars(principal, input.operationId, "sighting", input, tx => audit.recordMarsUnitSighting({ ...input, eventId: `mars-sighting:${marsFingerprint(input.operationId)}`, principal, transaction: tx })); }
export async function voidMarsAuditScan(principal: Principal, raw: unknown) { const input = z.object({ operationId: marsOperation, auditSessionId: marsId, scanId: marsId, reason: z.string().trim().min(5).max(2000).optional() }).strict().parse(raw); return commandMars(principal, input.operationId, "audit.scan.void", input, tx => audit.deleteMarsAuditScan({ ...input, principal, transaction: tx })); }
export async function reportMarsAudit(principal: Principal, raw: unknown) { const input = z.object({ operationId: marsOperation, auditSessionId: marsId, label: z.string().trim().max(300).nullable().optional() }).strict().parse(raw); return commandMars(principal, input.operationId, "audit.report", input, tx => audit.generateMarsAuditReport({ ...input, principal, transaction: tx })); }
