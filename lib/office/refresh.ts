import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { readSnapshot } from "@/lib/read-snapshot";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { businessDay, fingerprint, OfficeError, plain } from "./domain";
import { evaluateOfficePageInTransaction, officeEvaluationCandidateWhere } from "./service";

const PREFIX = "office-refresh:";
const FORMAT = "office-evaluation-v1";
export const officeRefreshStatusInputSchema = z.object({}).strict();
export const advanceOfficeRefreshInputSchema = z.object({ expectedActorUserId: z.string().min(1).max(200).optional(), operationId: z.string().regex(/^[A-Za-z0-9:_-]{16,120}$/), runId: z.string().uuid().optional(), expectedCheckpoint: z.string().max(400).optional(), restart: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(50), cause: z.enum(["home", "office", "wms_import", "manual"]).default("manual") }).strict();
type Watermark = Record<string, string | null>;
export interface OfficeRefreshCheckpoint {
  refreshFormat: typeof FORMAT; sequence: number; checkpoint: string; runId: string; day: string; startedAt: string; evaluatedAt: string;
  upperUnitId: string | null; afterUnitId: string | null; processed: number; totalAtStart: number; complete: boolean; watermark: Watermark;
  needsCurrentSchedule: number; startedByUserId: string; lastActorUserId: string; lastActorName: string; nextTimeBoundary: string | null; cause: string;
}
export const officeRefreshLimitation = "This evaluates stored warehouse/Office facts. It does not refresh upstream DMP/WMS data, establish physical presence, trigger conditional RTV without a qualifying scan, or send MARS/print actions.";
const canRefresh = (principal: Principal) => principal.capabilities.includes("office.decide") || principal.capabilities.includes("inventory.write");
function assertStatusScope(principal: Principal) { if (!canRefresh(principal)) assertCapability(principal, "workflow.read"); }

async function sourceWatermark(tx: Prisma.TransactionClient): Promise<Watermark> {
  const [row] = await tx.$queryRaw<Watermark[]>`SELECT
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("createdAt")::text,'') FROM "InventoryAuditImport") AS wms,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("recordedAt")::text,'') FROM "OfficeScheduleFact") AS schedule,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("receivedAt")::text,'') FROM "WarehousePhysicalObservation") AS physical,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("createdAt")::text,'') FROM "WarehouseObservationCorrection") AS corrections,
    (SELECT COUNT(*)::text || ':' || COUNT("revokedAt")::text || ':' || COALESCE(MAX(GREATEST("createdAt",COALESCE("revokedAt","createdAt")))::text,'') FROM "WarehouseUnitAlias") AS identifiers,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("executedAt")::text,'') FROM "OfficeDispositionExecution") AS executions,
    (SELECT COUNT(*)::text || ':' || COUNT("revokedAt")::text || ':' || COALESCE(MAX(GREATEST("createdAt",COALESCE("triggeredAt","createdAt"),COALESCE("revokedAt","createdAt")))::text,'') FROM "OfficeDisposition") AS disposition,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("recordedAt")::text,'') FROM "OfficeExchangeAttempt") AS attempts,
    (SELECT COUNT(*)::text || ':' || COUNT("supersededAt")::text || ':' || COALESCE(MAX(GREATEST("createdAt",COALESCE("supersededAt","createdAt")))::text,'') FROM "OfficeReturnExpectation") AS expectations,
    (SELECT COUNT(*)::text || ':' || COALESCE(MAX("createdAt")::text,'') FROM "OfficeCaseEvent" WHERE action IN ('assign','watch','resolve','reopen')) AS decisions`;
  return row;
}
async function nextBoundary(tx: Prisma.TransactionClient, now: Date) {
  const [row] = await tx.$queryRaw<{ at: Date | null }[]>`SELECT MIN(at) AS at FROM (
    SELECT "reviewAt" AS at FROM "OfficeCase" WHERE "reviewTrigger"='date_or_conflict' AND status IN ('watching','resolved') AND "reviewAt">${now}
    UNION ALL SELECT "expiresAt" AS at FROM "OfficeDisposition" WHERE status IN ('active','triggered','executed') AND "expiresAt">${now}
    UNION ALL SELECT "expectedAt" AS at FROM "OfficeReturnExpectation" WHERE status='expected' AND "expectedAt">${now}
  ) boundaries`;
  return row.at?.toISOString() ?? null;
}
async function latestCheckpoint(tx: Prisma.TransactionClient): Promise<OfficeRefreshCheckpoint | null> {
  const rows = await tx.$queryRaw<{ result: Prisma.JsonValue }[]>`SELECT result->'receipt' AS result FROM "OfficeCommandReceipt" WHERE "operationId" LIKE 'office-refresh:%' AND result->>'refreshFormat'=${FORMAT} ORDER BY (result->>'sequence')::bigint DESC,"createdAt" DESC,id DESC LIMIT 1`;
  return rows[0] ? rows[0].result as unknown as OfficeRefreshCheckpoint : null;
}
async function statusFrom(tx: Prisma.TransactionClient, principal: Principal, checkpoint: OfficeRefreshCheckpoint | null, now: Date) {
  const watermark = await sourceWatermark(tx); const day = businessDay(now); const staleReasons: string[] = [];
  if (!checkpoint) staleReasons.push("No complete warehouse evaluation is recorded.");
  else {
    if (checkpoint.day !== day) staleReasons.push("The warehouse day changed; aging and date issues need reevaluation.");
    if (fingerprint(Object.entries(checkpoint.watermark).sort()) !== fingerprint(Object.entries(watermark).sort())) staleReasons.push("Stored source, physical or Office facts changed since this pass began.");
    if (checkpoint.nextTimeBoundary && Date.parse(checkpoint.nextTimeBoundary) <= now.getTime()) staleReasons.push("A stored review, return-due or authorization-expiry time was reached.");
  }
  const coverage = !checkpoint ? "not_started" : !checkpoint.complete ? "incomplete" : staleReasons.length ? "stale" : "fresh";
  const remaining = checkpoint && !checkpoint.complete && checkpoint.upperUnitId ? await tx.warehouseUnit.count({ where: { ...officeEvaluationCandidateWhere, id: { gt: checkpoint.afterUnitId ?? "", lte: checkpoint.upperUnitId } } }) : 0;
  return { actorUserId: principal.userId, day, coverage, canRefresh: canRefresh(principal), checkpoint, remaining, staleReasons, limitation: officeRefreshLimitation };
}
export async function getOfficeRefreshStatusInTransaction(tx: Prisma.TransactionClient, principal: Principal, now = new Date()) {
  assertStatusScope(principal);
  return statusFrom(tx, principal, await latestCheckpoint(tx), now);
}
export async function getOfficeRefreshStatus(principal: Principal, raw: unknown = {}) {
  officeRefreshStatusInputSchema.parse(raw); assertStatusScope(principal);
  return readSnapshot(async tx => { const current = await assertCurrentPrincipal(tx, principal); assertStatusScope(current); return getOfficeRefreshStatusInTransaction(tx, current); }, { isolationLevel: "RepeatableRead" });
}

export async function advanceOfficeRefresh(principal: Principal, raw: unknown) {
  const input = advanceOfficeRefreshInputSchema.parse(raw);
  const capability = principal.capabilities.includes("office.decide") ? "office.decide" : "inventory.write";
  assertCapability(principal, capability);
  const operationId = PREFIX + input.operationId, hash = fingerprint(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, capability);
    if (input.expectedActorUserId && input.expectedActorUserId !== current.userId) throw new OfficeError("The signed-in person changed. Reload before continuing the warehouse refresh.", 409);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('office-refresh',0))`;
    const replay = await tx.officeCommandReceipt.findUnique({ where: { userId_operationId: { userId: current.userId, operationId } } });
    if (replay) {
      if (replay.fingerprint !== hash) throw new OfficeError("This refresh operation ID was already used for another page.", 409);
      const saved = replay.result as unknown as { receipt: OfficeRefreshCheckpoint; noWork: boolean };
      return { receipt: saved.receipt, noWork: saved.noWork, status: await statusFrom(tx, current, await latestCheckpoint(tx), new Date()), replayed: true };
    }
    const now = new Date(); const previous = await latestCheckpoint(tx); const previousStatus = await statusFrom(tx, current, previous, now);
    if (input.expectedCheckpoint && previous?.checkpoint !== input.expectedCheckpoint) throw new OfficeError("Another authorized request advanced the refresh. Reload its current progress before continuing.", 409);
    if (input.runId && previous?.runId !== input.runId) throw new OfficeError("This refresh was replaced. Reload the current run before continuing.", 409);
    if (previousStatus.coverage === "fresh" && !input.restart) {
      // An explicit no-work command also has a stable receipt. Read-only freshness
      // checks never call this writer, so a fresh open page does not create writes.
      await tx.officeCommandReceipt.create({ data: { userId: current.userId, operationId, fingerprint: hash, result: plain({ receipt: previous, noWork: true }) as unknown as Prisma.InputJsonValue } });
      return { receipt: previous!, noWork: true, status: previousStatus, replayed: false };
    }
    const start = input.restart || !previous || previous.day !== businessDay(now) || previous.complete;
    let checkpoint: OfficeRefreshCheckpoint;
    if (start) {
      // Capture inputs before selecting the scope: facts accepted during scope
      // selection must invalidate this pass, including new IDs beyond its bound.
      const watermark = await sourceWatermark(tx);
      const upper = await tx.warehouseUnit.findFirst({ where: officeEvaluationCandidateWhere, orderBy: { id: "desc" }, select: { id: true } });
      checkpoint = { refreshFormat: FORMAT, sequence: (previous?.sequence ?? 0) + 1, checkpoint: `${current.userId}:${input.operationId}`, runId: randomUUID(), day: businessDay(now), startedAt: now.toISOString(), evaluatedAt: now.toISOString(), upperUnitId: upper?.id ?? null, afterUnitId: null, processed: 0, needsCurrentSchedule: 0, totalAtStart: upper ? await tx.warehouseUnit.count({ where: { ...officeEvaluationCandidateWhere, id: { lte: upper.id } } }) : 0, complete: !upper, watermark, startedByUserId: current.userId, lastActorUserId: current.userId, lastActorName: current.displayName, nextTimeBoundary: await nextBoundary(tx, now), cause: input.cause };
    } else checkpoint = { ...previous!, sequence: previous!.sequence + 1, checkpoint: `${current.userId}:${input.operationId}`, lastActorUserId: current.userId, lastActorName: current.displayName };
    if (checkpoint.upperUnitId && !checkpoint.complete) {
      const page = await evaluateOfficePageInTransaction(tx, current, { limit: input.limit, afterUnitId: checkpoint.afterUnitId ?? undefined, throughUnitId: checkpoint.upperUnitId }, now);
      checkpoint.processed += page.evaluations.length; checkpoint.needsCurrentSchedule += page.evaluations.filter(item => item.currentWarehouseEvidence && !item.scheduleCurrent).length; checkpoint.complete = !page.hasMore; checkpoint.afterUnitId = page.evaluations.at(-1)?.unitId ?? checkpoint.afterUnitId;
    }
    checkpoint.evaluatedAt = new Date().toISOString();
    const boundary = await nextBoundary(tx, now);
    if (boundary && (!checkpoint.nextTimeBoundary || boundary < checkpoint.nextTimeBoundary)) checkpoint.nextTimeBoundary = boundary;
    await tx.officeCommandReceipt.create({ data: { userId: current.userId, operationId, fingerprint: hash, result: plain({ refreshFormat: FORMAT, sequence: checkpoint.sequence, receipt: checkpoint, noWork: false }) as unknown as Prisma.InputJsonValue, createdAt: new Date() } });
    return { receipt: checkpoint, noWork: false, status: await statusFrom(tx, current, checkpoint, new Date()), replayed: false };
  }, { timeout: 60_000, maxWait: 30_000 });
}
export type OfficeRefreshStatus = Awaited<ReturnType<typeof getOfficeRefreshStatus>>;
