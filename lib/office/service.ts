import { Prisma, type MarsUnit } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Capability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertUnitOperationalCustodyInTransaction } from "@/lib/warehouse/custody";
import { classifyMarsUnit } from "@/lib/mars/classification";
import { businessDay, calendarDays, deriveCustody, fingerprint, iso, OfficeError, plain, type PhysicalFact } from "./domain";

export { OfficeError } from "./domain";
const id = z.string().trim().min(1).max(200);
const operation = z.string().trim().min(1).max(150);
const explanation = z.string().trim().min(5).max(2000);
const stamp = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const at = new Date(`${value}T00:00:00Z`); return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value; }, "Choose a valid calendar date.");
const json = (value: unknown) => plain(value) as Prisma.InputJsonValue;

async function unitExists(tx: Prisma.TransactionClient, unitId: string) {
  if (!await tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new OfficeError("Physical unit not found.", 404);
}

async function command<T extends object>(principal: Principal, operationId: string, action: string, input: unknown, capability: Capability, handler: (tx: Prisma.TransactionClient) => Promise<T>, recent = false): Promise<T & { replayed: boolean }> {
  assertCapability(principal, capability);
  const hash = fingerprint({ action, input });
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, capability, recent);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`office-command:${principal.userId}:${operationId}`},0))`;
    const existing = await tx.officeCommandReceipt.findUnique({ where: { userId_operationId: { userId: principal.userId, operationId } } });
    if (existing) {
      if (existing.fingerprint !== hash) throw new OfficeError("This operation ID was already used for a different office action.", 409);
      return { ...(existing.result as T), replayed: true };
    }
    const result = plain(await handler(tx));
    await tx.officeCommandReceipt.create({ data: { userId: principal.userId, operationId, fingerprint: hash, result: json(result) } });
    return { ...result, replayed: false };
  }, { timeout: 30_000 });
}

async function caseEvent(tx: Prisma.TransactionClient, caseId: string, userId: string, action: string, reason: string, evidence: unknown = {}) {
  await tx.officeCaseEvent.create({ data: { caseId, userId, action, reason, evidence: json(evidence) } });
}

async function physicalFacts(tx: Prisma.TransactionClient, unitId: string) {
  return tx.$queryRaw<PhysicalFact[]>`
    SELECT o.id,o.type,o.location,o."capturedAt",o."receivedAt" FROM "WarehousePhysicalObservation" o
    LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
    WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END = ${unitId}
    ORDER BY o."capturedAt",o.id`;
}

async function facts(tx: Prisma.TransactionClient, unitId: string, now = new Date()) {
  const [observations, schedule, rows, expectations, dispositions] = await Promise.all([
    physicalFacts(tx, unitId),
    tx.officeScheduleFact.findFirst({ where: { unitId }, orderBy: [{ sourceAsOf: "desc" }, { recordedAt: "desc" }, { id: "desc" }] }),
    tx.inventoryAuditItem.findMany({ where: { unitId }, select: { id: true, lpn: true, status: true, receivedDate: true } }),
    tx.officeReturnExpectation.findMany({ where: { unitId }, include: { exchange: { include: { attempts: { orderBy: { occurredAt: "desc" } } } } } }),
    tx.officeDisposition.findMany({ where: { unitId, revokedAt: null, status: { in: ["active", "triggered", "executed"] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
  ]);
  const custody = deriveCustody(observations);
  const today = businessDay(now);
  const successfulReplacement = expectations.flatMap((expectation) => expectation.exchange?.status === "completed" && expectation.exchange.replacementUnitId === unitId ? expectation.exchange.attempts.filter((attempt) => attempt.outcome === "successful_exchange") : []).sort((a, b) => b.sourceAsOf.getTime() - a.sourceAsOf.getTime())[0];
  const scheduleCurrent = Boolean(schedule?.complete && businessDay(schedule.sourceAsOf) === today && (!custody.currentCheckIn || schedule.sourceAsOf >= custody.currentCheckIn.capturedAt) && (!successfulReplacement || schedule.sourceAsOf > successfulReplacement.sourceAsOf));
  const upcoming = scheduleCurrent && Boolean(schedule?.nextDeliveryDate && schedule.nextDeliveryDate >= today);
  const checkedIn = (from: Date | null) => observations.some((item) => item.type === "check_in" && (!from || item.capturedAt >= from));
  return { observations, schedule, rows, expectations, dispositions, custody, today, scheduleCurrent, upcoming, checkedIn };
}

// Internal writer seam for MARS preparation/start/link. The caller must enforce
// its own current command capability in this same transaction. A placed unit's
// executed disposition remains prior office authority, not a completed submission.
export async function assertCurrentRtvAuthorization(tx: Prisma.TransactionClient, unitId: string, dispositionId: string, now = new Date()) {
  id.parse(unitId); id.parse(dispositionId);
  if (!Number.isFinite(now.getTime())) throw new OfficeError("Use a valid authorization review time.");
  await tx.$executeRaw`SELECT id FROM "OfficeDisposition" WHERE id=${dispositionId} FOR UPDATE`;
  const disposition = await tx.officeDisposition.findUnique({ where: { id: dispositionId } });
  if (!disposition || disposition.unitId !== unitId || !["rtv", "conditional_rtv"].includes(disposition.kind) || !["active", "triggered", "executed"].includes(disposition.status) || !disposition.authorizedByUserId || !disposition.authorizedAt || disposition.authorizedAt > now || disposition.revokedAt || !disposition.expiresAt || disposition.expiresAt <= now) throw new OfficeError("A current, unrevoked and unexpired RTV authorization for this exact physical unit is required.", 409);
  // Existing source/schedule/disposition/observation inserts carry this unit's
  // foreign-key KEY SHARE lock. FOR UPDATE serializes their acceptance with the
  // guarded local MARS intent transition; it does not claim an upstream effect.
  await tx.$executeRaw`SELECT id FROM "WarehouseUnit" WHERE id=${unitId} FOR UPDATE`;
  const current = await facts(tx, unitId, now);
  const last = current.custody.last;
  if (!current.custody.warehouseEvidence || !last || last.capturedAt < disposition.authorizedAt || (disposition.triggerAt && (disposition.triggerAt > now || last.capturedAt < disposition.triggerAt))) throw new OfficeError("Confirm this exact unit in the warehouse with a qualifying scan after its authorization/trigger; departure, unknown custody or conflicting physical evidence cannot support RTV.", 409);
  let triggerObservationId: string | null = null;
  if (disposition.kind === "conditional_rtv") {
    if (!["triggered", "executed"].includes(disposition.status) || !disposition.triggerAt || !disposition.triggeredAt || disposition.triggeredAt > now || !disposition.triggeredByObservationId) throw new OfficeError("This conditional RTV instruction has not met its stored qualifying-scan trigger.", 409);
    triggerObservationId = disposition.triggeredByObservationId;
  }
  // Lock the original proof rows too: correcting an association away from this
  // unit must not race the intent writer through a null/other-unit correction.
  for (const observationId of [...new Set([last.id, ...(triggerObservationId ? [triggerObservationId] : [])])].sort()) await tx.$executeRaw`SELECT id FROM "WarehousePhysicalObservation" WHERE id=${observationId} FOR UPDATE`;
  const refreshed = await facts(tx, unitId, now);
  if (!refreshed.custody.warehouseEvidence || refreshed.custody.last?.id !== last.id) throw new OfficeError("Physical identity/custody changed while reviewing RTV. Refresh and confirm the unit again.", 409);
  if (triggerObservationId) {
    const trigger = refreshed.observations.find((item) => item.id === triggerObservationId);
    if (!trigger || trigger.type === "departure" || trigger.capturedAt < disposition.authorizedAt || trigger.capturedAt < disposition.triggerAt!) throw new OfficeError("The original conditional trigger no longer identifies this authorized physical unit. Office must review it.", 409);
  }
  if (refreshed.dispositions.some((item) => !item.revokedAt && ["hold", "customer_property"].includes(item.kind))) throw new OfficeError("A current hold/customer-property instruction conflicts with RTV for this exact unit. Office must resolve it first.", 409);
  if (disposition.requireNoUpcomingDate && (!refreshed.scheduleCurrent || refreshed.upcoming)) throw new OfficeError("This authorization requires a complete current schedule with no upcoming delivery date. Refresh/review the scheduling evidence first.", 409);
  return { ...disposition, eligibility: { reviewedAt: now.toISOString(), physicalObservationId: last.id, observedAt: last.capturedAt.toISOString(), conditionalTriggerObservationId: triggerObservationId, scheduleFactId: disposition.requireNoUpcomingDate ? refreshed.schedule?.id ?? null : null, meaning: "Prior exact-unit office authority and independent physical evidence only; no MARS submission, pickup or print completion is implied." } };
}

export interface OfficeDispatchRestriction { dispositionId: string; unitId: string; kind: string; instruction: string; targetLocation: string | null; authorityState: "office_hold" | "authorized_rtv" | "rtv_review_required"; reason: string }
// Internal current-state writer seam. This only restricts contradictory work;
// it never creates an authorization, submits MARS, prints or records movement.
export async function currentOfficeDispatchRestrictions(tx: Prisma.TransactionClient, unitId: string, now = new Date()): Promise<OfficeDispatchRestriction[]> {
  const dispositions = await tx.officeDisposition.findMany({ where: { unitId, revokedAt: null, status: { in: ["active", "triggered", "executed"] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], kind: { in: ["hold", "customer_property", "rtv", "conditional_rtv"] } }, orderBy: { id: "asc" } });
  const restrictions: OfficeDispatchRestriction[] = [];
  for (const disposition of dispositions) {
    if (disposition.kind === "conditional_rtv" && disposition.status === "active") continue;
    const base = { dispositionId: disposition.id, unitId, kind: disposition.kind, instruction: disposition.instruction, targetLocation: disposition.targetLocation };
    if (["hold", "customer_property"].includes(disposition.kind)) { restrictions.push({ ...base, authorityState: "office_hold", reason: "Current exact-unit office handling conflicts with delivery." }); continue; }
    try { await assertCurrentRtvAuthorization(tx, unitId, disposition.id, now); restrictions.push({ ...base, authorityState: "authorized_rtv", reason: "Current prior RTV authority and qualifying physical evidence route this exact unit into RTV instead of delivery." }); }
    catch (error) { if (!(error instanceof OfficeError)) throw error; restrictions.push({ ...base, authorityState: "rtv_review_required", reason: error.message }); }
  }
  return restrictions;
}

async function ensureCase(tx: Prisma.TransactionClient, principal: Principal, input: { unitId: string; reason: string; episodeKey: string; evidence: unknown; signature: unknown; nextAction: string }, now: Date) {
  const caseKey = fingerprint([input.unitId, input.reason, input.episodeKey]);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`office-case:${caseKey}`},0))`;
  const signature = fingerprint(input.signature);
  const existing = await tx.officeCase.findUnique({ where: { caseKey } });
  if (!existing) {
    const created = await tx.officeCase.create({ data: { caseKey, unitId: input.unitId, reason: input.reason, episodeKey: input.episodeKey, evidence: json(input.evidence), conditionSignature: signature, nextAction: input.nextAction } });
    await caseEvent(tx, created.id, principal.userId, "opened", input.nextAction, input.evidence);
    return created.id;
  }
  const conflict = existing.conditionSignature !== signature;
  const due = existing.reviewAt && existing.reviewAt <= now && existing.reviewTrigger === "date_or_conflict";
  const reopen = ["resolved", "watching"].includes(existing.status) && (conflict || due);
  if (reopen) {
    const reopened = await tx.officeCase.update({ where: { id: existing.id }, data: { status: "open", resolvedAt: null, resolution: null, evidence: json(input.evidence), conditionSignature: signature, reviewAt: null, revision: { increment: 1 } } });
    await caseEvent(tx, existing.id, principal.userId, "reopened", conflict ? "New conflicting operational evidence meets the issue condition." : "The stored review condition became due.", input.evidence);
    return reopened.id;
  }
  if (conflict || !["resolved", "watching"].includes(existing.status)) await tx.officeCase.update({ where: { id: existing.id }, data: { evidence: json(input.evidence), conditionSignature: signature, ...(conflict ? { revision: { increment: 1 } } : {}) } });
  return existing.id;
}

async function clearCases(tx: Prisma.TransactionClient, principal: Principal, unitId: string, reasons: string[], resolution: string, evidence: unknown) {
  const cases = await tx.officeCase.findMany({ where: { unitId, reason: { in: reasons }, status: { not: "resolved" } } });
  for (const item of cases) {
    await tx.officeCase.update({ where: { id: item.id }, data: { status: "resolved", resolution, resolvedAt: new Date(), revision: { increment: 1 } } });
    await caseEvent(tx, item.id, principal.userId, "condition_cleared", resolution, evidence);
  }
}

async function evaluateUnit(tx: Prisma.TransactionClient, principal: Principal, unitId: string, now: Date) {
  const data = await facts(tx, unitId, now);
  const expired = await tx.officeDisposition.findMany({ where: { unitId, revokedAt: null, status: { in: ["active", "triggered", "executed"] }, expiresAt: { lte: now } } });
  for (const disposition of expired) {
    const changed = await tx.officeDisposition.updateMany({ where: { id: disposition.id, revision: disposition.revision, status: disposition.status, revokedAt: null }, data: { status: "expired", revision: { increment: 1 } } });
    if (!changed.count) continue;
    const departedEpisode = disposition.authorizedAt && data.custody.departure && data.custody.departure.capturedAt >= disposition.authorizedAt;
    const pendingRtv = disposition.kind === "rtv" || (disposition.kind === "conditional_rtv" && ["triggered", "executed"].includes(disposition.status));
    // Expiry removes authority; it does not establish presence, qualify a scan,
    // reopen an earlier departed stay, or undo an already-linked submission.
    if (!pendingRtv || !data.custody.warehouseEvidence || departedEpisode) continue;
    const aliases = await tx.warehouseUnitAlias.findMany({ where: { unitId, kind: "submission", revokedAt: null }, select: { value: true } });
    let linkedSubmission = false;
    for (const alias of aliases) {
      const units = await tx.warehouseUnitAlias.findMany({ where: { kind: "submission", value: alias.value, revokedAt: null }, distinct: ["unitId"], select: { unitId: true } });
      if (units.length === 1 && units[0].unitId === unitId) { linkedSubmission = true; break; }
    }
    if (linkedSubmission) continue;
    const caseId = await ensureCase(tx, principal, { unitId, reason: "authorized_rtv_ready", episodeKey: disposition.id, signature: { disposition: disposition.id, authority: "expired" }, evidence: { why: "Prior RTV authority expired while this exact unit has unfinished warehouse work and no unambiguous submission link.", dispositionId: disposition.id, expiresAt: disposition.expiresAt, priorStatus: disposition.status, physicalEvidence: data.custody.last, checkIn: data.custody.currentCheckIn, physicalPresenceClaim: "as_observed_only" }, nextAction: "RTV authorization expired. Office must review unfinished handling and any existing MARS intent before further execution. Do not automatically submit or replay anything." }, now);
    // The earlier placement's next action is historical after authority expiry.
    await tx.officeCase.update({ where: { id: caseId }, data: { nextAction: "RTV authorization expired. Office must review unfinished handling and any existing MARS intent before further execution. Do not automatically submit or replay anything." } });
    await caseEvent(tx, caseId, principal.userId, "authorization_expired", "No further RTV execution is authorized by this expired instruction; placement and submission/departure remain separate.", { dispositionId: disposition.id, physicalEvidence: data.custody.last });
  }
  const opened: string[] = [];
  const firstSeenThisStay = data.observations.find((item) => item.type !== "departure" && (!data.custody.departure || item.capturedAt > data.custody.departure.capturedAt));
  const currentStay = data.custody.currentCheckIn?.id ?? firstSeenThisStay?.id ?? "unknown-stay";
  if (data.custody.departure) {
    const previous = await tx.officeCase.findMany({ where: { unitId, reason: { in: ["replacement_awaiting_reschedule", "past_delivery_without_new_date", "warehouse_over_20_days", "aging_basis_review"] }, status: { not: "resolved" }, episodeKey: { not: currentStay } } });
    for (const item of previous) {
      const evidence = item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence) ? item.evidence as Record<string, Prisma.JsonValue> : {};
      const observed = evidence.checkIn ?? evidence.physicalEvidence;
      const captured = observed && typeof observed === "object" && !Array.isArray(observed) && typeof observed.capturedAt === "string" ? Date.parse(observed.capturedAt) : NaN;
      if (Number.isFinite(captured) && captured <= data.custody.departure.capturedAt.getTime()) {
        await tx.officeCase.update({ where: { id: item.id }, data: { status: "resolved", resolution: "A later physical departure ended this earlier warehouse stay; any new stay is evaluated independently.", resolvedAt: now, revision: { increment: 1 } } });
        await caseEvent(tx, item.id, principal.userId, "condition_cleared", "Earlier warehouse stay ended by physical departure.", { departure: data.custody.departure, currentStay });
      }
    }
  }
  const replacement = data.expectations.find((item) => item.kind === "replacement_failed_attempt_return" && item.status === "expected");
  const scheduleReason = replacement ? "replacement_awaiting_reschedule" : "past_delivery_without_new_date";
  if (data.custody.warehouseEvidence && data.scheduleCurrent && data.schedule?.deliveryDate && data.schedule.deliveryDate < data.today && !data.upcoming) {
    opened.push(await ensureCase(tx, principal, { unitId, reason: scheduleReason, episodeKey: currentStay, signature: { stay: currentStay, deliveryDate: data.schedule.deliveryDate, nextDeliveryDate: data.schedule.nextDeliveryDate, replacement: replacement?.exchangeId ?? null }, evidence: { why: replacement ? "Replacement checked into warehouse after a missed exchange and has no upcoming date." : "Physical warehouse evidence, a past delivery date and a complete current scheduling statement show no upcoming date.", schedule: data.schedule, physicalEvidence: data.custody.last, checkIn: data.custody.currentCheckIn, exchange: replacement?.exchange ?? null, sourceQualification: "manual_office_statement_not_qualified_dmp_adapter" }, nextAction: replacement ? "OFFICE: replacement awaiting reschedule. Review its missed attempt and original's deferred exchange relationship." : "Office: resolve the past delivery date and provide durable handling instructions." }, now));
  } else if (data.upcoming || (data.custody.last?.type === "departure" && !data.custody.conflict)) {
    await clearCases(tx, principal, unitId, ["replacement_awaiting_reschedule", "past_delivery_without_new_date"], data.upcoming ? "A complete current schedule statement supplies a new upcoming delivery date." : "A later physical departure supersedes warehouse presence evidence.", { schedule: data.schedule, physicalEvidence: data.custody.last });
  }
  if (data.custody.warehouseEvidence && data.custody.currentCheckIn && calendarDays(data.custody.currentCheckIn.capturedAt, now) > 20) {
    opened.push(await ensureCase(tx, principal, { unitId, reason: "warehouse_over_20_days", episodeKey: data.custody.currentCheckIn.id, signature: { stay: data.custody.currentCheckIn.id }, evidence: { why: "Supported check-in for the current warehouse stay is over twenty warehouse calendar days old.", days: calendarDays(data.custody.currentCheckIn.capturedAt, now), checkIn: data.custody.currentCheckIn, physicalEvidence: data.custody.last }, nextAction: "Review warehouse aging and record a disposition or watch instruction." }, now));
  } else if (data.custody.last?.type === "departure" && !data.custody.conflict) await clearCases(tx, principal, unitId, ["warehouse_over_20_days", "aging_basis_review"], "Physical departure ended the supported warehouse stay.", data.custody.last);
  if (data.custody.warehouseEvidence && !data.custody.currentCheckIn) {
    const oldReceipt = data.rows.find((row) => row.receivedDate && Number.isFinite(Date.parse(row.receivedDate)) && calendarDays(new Date(`${row.receivedDate}T12:00:00Z`), now) > 20);
    if (oldReceipt) opened.push(await ensureCase(tx, principal, { unitId, reason: "aging_basis_review", episodeKey: `reported-receipt:${oldReceipt.id}`, signature: { receipt: oldReceipt.receivedDate }, evidence: { why: "The reported received date is over twenty days old and the unit was physically seen, but a current-stay check-in is not established.", reportedRow: oldReceipt, physicalEvidence: data.custody.last, certainty: "reported_receipt_not_confirmed_current_stay" }, nextAction: "Confirm the current warehouse stay before claiming a twenty-day physical age." }, now));
    else await clearCases(tx, principal, unitId, ["aging_basis_review"], "The current reported receipt dates no longer support the earlier aging warning. Physical stay remains unestablished.", { reportedRows: data.rows, physicalEvidence: data.custody.last });
  }
  if (data.custody.warehouseEvidence && data.custody.currentCheckIn) await clearCases(tx, principal, unitId, ["aging_basis_review"], "A supported current-stay check-in now provides the physical aging basis independently of reported received dates.", { checkIn: data.custody.currentCheckIn });
  for (const expectation of data.expectations.filter((item) => item.status === "expected" && item.expectedAt && item.expectedAt <= now)) {
    if (!data.checkedIn(expectation.activatedAt)) opened.push(await ensureCase(tx, principal, { unitId, reason: "expected_return_not_confirmed", episodeKey: expectation.id, signature: { expectation: expectation.id }, evidence: { why: expectation.evidence, expectation, trailStopsAt: "Return expected; no qualifying physical check-in confirmation.", physicalPresenceClaim: false }, nextAction: "Confirm the expected return/check-in. Do not claim this unit is in the warehouse." }, now));
    else {
      const key = fingerprint([unitId, "expected_return_not_confirmed", expectation.id]);
      const existing = await tx.officeCase.findUnique({ where: { caseKey: key } });
      if (existing && existing.status !== "resolved") { await tx.officeCase.update({ where: { id: existing.id }, data: { status: "resolved", resolution: "A qualifying check-in confirms this expected return.", resolvedAt: now, revision: { increment: 1 } } }); await caseEvent(tx, existing.id, principal.userId, "condition_cleared", "Expected return checked in.", { expectationId: expectation.id }); }
    }
  }
  return { openedOrRetainedCaseIds: opened, scheduleCurrent: data.scheduleCurrent, currentWarehouseEvidence: data.custody.warehouseEvidence, warehouseEvidenceAt: iso(data.custody.last?.capturedAt), warehousePresenceClaim: "as_observed_only" as const };
}

export const recordOfficeScheduleInputSchema = z.object({ operationId: operation, unitId: id, deliveryDate: date.nullable(), nextDeliveryDate: date.nullable(), complete: z.boolean(), sourceAsOf: stamp, sourceRef: explanation, evidence: explanation }).strict();
export async function recordOfficeSchedule(principal: Principal, raw: unknown) {
  const data = recordOfficeScheduleInputSchema.parse(raw);
  if (Date.parse(data.sourceAsOf) > Date.now() + 300_000) throw new OfficeError("Source-as-of cannot be in the future.");
  return command(principal, data.operationId, "schedule", data, "office.decide", async (tx) => {
    await unitExists(tx, data.unitId);
    const saved = await tx.officeScheduleFact.create({ data: { unitId: data.unitId, deliveryDate: data.deliveryDate, nextDeliveryDate: data.nextDeliveryDate, complete: data.complete, sourceAsOf: new Date(data.sourceAsOf), sourceRef: data.sourceRef, evidence: data.evidence, recordedByUserId: principal.userId, source: "manual_office" } });
    return { schedule: plain(saved), evaluation: await evaluateUnit(tx, principal, data.unitId, new Date()), qualification: "Manual office statement; no qualified DMP ingestion is claimed." };
  });
}

export const createOfficeExchangeInputSchema = z.object({ operationId: operation, originalUnitId: id, replacementUnitId: id, orderReference: z.string().trim().min(1).max(200), evidence: explanation }).strict();
export async function createOfficeExchange(principal: Principal, raw: unknown) {
  const data = createOfficeExchangeInputSchema.parse(raw);
  if (data.originalUnitId === data.replacementUnitId) throw new OfficeError("Original and replacement must be distinct physical units.");
  return command(principal, data.operationId, "exchange", data, "office.decide", async (tx) => {
    await unitExists(tx, data.originalUnitId); await unitExists(tx, data.replacementUnitId);
    const exchange = await tx.officeExchange.create({ data: { originalUnitId: data.originalUnitId, replacementUnitId: data.replacementUnitId, orderReference: data.orderReference, evidence: data.evidence, createdByUserId: principal.userId } });
    const obligation = await tx.officeReturnExpectation.create({ data: { unitId: data.originalUnitId, exchangeId: exchange.id, kind: "original_exchange_return", status: "deferred", condition: "successful_exchange_required", evidence: "Original remains with the customer until a successful exchange. Scheduling or a missed attempt alone does not make it due.", createdByUserId: principal.userId } });
    return { exchange: plain(exchange), originalObligation: plain(obligation) };
  });
}

export const recordOfficeExchangeAttemptInputSchema = z.object({ operationId: operation, exchangeId: id, outcome: z.enum(["missed", "successful_exchange"]), occurredAt: stamp, sourceAsOf: stamp, expectedBackAt: stamp.optional(), evidence: explanation }).strict();
export async function recordOfficeExchangeAttempt(principal: Principal, raw: unknown) {
  const data = recordOfficeExchangeAttemptInputSchema.parse(raw);
  if (Date.parse(data.occurredAt) > Date.now() + 300_000 || Date.parse(data.sourceAsOf) > Date.now() + 300_000) throw new OfficeError("Attempt/source time cannot be in the future.");
  if (Date.parse(data.sourceAsOf) < Date.parse(data.occurredAt) || (data.expectedBackAt && Date.parse(data.expectedBackAt) < Date.parse(data.occurredAt))) throw new OfficeError("Source-as-of and expected return cannot precede the recorded attempt.");
  return command(principal, data.operationId, "exchange_attempt", data, "office.decide", async (tx) => {
    await tx.$executeRaw`SELECT id FROM "OfficeExchange" WHERE id=${data.exchangeId} FOR UPDATE`;
    const exchange = await tx.officeExchange.findUnique({ where: { id: data.exchangeId } });
    if (!exchange) throw new OfficeError("Exchange not found.", 404);
    if (exchange.status === "completed") throw new OfficeError("This exchange is completed. Record a new evidenced relationship for another exchange.", 409);
    const attempt = await tx.officeExchangeAttempt.create({ data: { exchangeId: exchange.id, outcome: data.outcome, occurredAt: new Date(data.occurredAt), sourceAsOf: new Date(data.sourceAsOf), evidence: data.evidence, recordedByUserId: principal.userId, source: "manual_office" } });
    if (data.outcome === "missed") {
      await tx.officeReturnExpectation.create({ data: { unitId: exchange.replacementUnitId, exchangeId: exchange.id, sourceAttemptId: attempt.id, kind: "replacement_failed_attempt_return", status: "expected", condition: "none", expectedAt: new Date(data.expectedBackAt ?? data.occurredAt), activatedAt: new Date(data.occurredAt), evidence: "Replacement left for this exchange, which was missed. Replacement is expected back for reschedule; original's return remains deferred.", sourceAsOf: new Date(data.sourceAsOf), sourceRef: attempt.id, createdByUserId: principal.userId } });
    } else {
      await tx.officeExchange.update({ where: { id: exchange.id }, data: { status: "completed" } });
      await tx.officeReturnExpectation.updateMany({ where: { exchangeId: exchange.id, kind: "original_exchange_return" }, data: { status: "expected", condition: "none", activatedAt: new Date(data.occurredAt), expectedAt: new Date(data.expectedBackAt ?? data.occurredAt), sourceAttemptId: attempt.id, sourceAsOf: new Date(data.sourceAsOf), sourceRef: attempt.id, evidence: "Successful exchange was explicitly recorded; original is now expected back. Physical check-in is still a separate fact." } });
      const superseded = await tx.officeReturnExpectation.findMany({ where: { exchangeId: exchange.id, kind: "replacement_failed_attempt_return", status: "expected" }, select: { id: true } });
      await tx.officeReturnExpectation.updateMany({ where: { id: { in: superseded.map((item) => item.id) } }, data: { status: "superseded", supersededAt: new Date(data.occurredAt), supersededReason: "A later successful exchange supersedes this replacement return demand. Earlier check-in evidence remains independently reviewable; no physical completion is fabricated." } });
      for (const expectation of superseded) {
        const item = await tx.officeCase.findUnique({ where: { caseKey: fingerprint([exchange.replacementUnitId, "expected_return_not_confirmed", expectation.id]) } });
        if (item && item.status !== "resolved") { await tx.officeCase.update({ where: { id: item.id }, data: { status: "resolved", resolution: "Later successful exchange superseded this current return demand; any missing historical check-in remains in the trail.", resolvedAt: new Date(), revision: { increment: 1 } } }); await caseEvent(tx, item.id, principal.userId, "expectation_superseded", "This specific expectation was superseded by a later successful exchange; no check-in was fabricated.", { attemptId: attempt.id, expectationId: expectation.id }); }
      }
      await clearCases(tx, principal, exchange.replacementUnitId, ["replacement_awaiting_reschedule", "past_delivery_without_new_date"], "A later successful exchange superseded the replacement's pending reschedule issue. Physical departure/check-in evidence remains separate.", { attemptId: attempt.id });
    }
    return { attempt: plain(attempt), original: await evaluateUnit(tx, principal, exchange.originalUnitId, new Date()), replacement: await evaluateUnit(tx, principal, exchange.replacementUnitId, new Date()) };
  });
}

export const manageOfficeCaseInputSchema = z.object({ operationId: operation, caseId: id, expectedRevision: z.number().int().positive(), action: z.enum(["assign", "watch", "resolve", "reopen"]), reason: explanation, responsibleUserId: id.nullable().optional(), nextAction: z.string().trim().min(1).max(1000).optional(), reviewAt: stamp.nullable().optional(), reviewTrigger: z.enum(["date_or_conflict", "conflict_only"]).default("date_or_conflict") }).strict();
export async function manageOfficeCase(principal: Principal, raw: unknown) {
  const data = manageOfficeCaseInputSchema.parse(raw);
  if (data.action === "watch" && !data.nextAction) throw new OfficeError("A watch needs a durable next action/instruction.");
  if (data.action === "watch" && data.reviewTrigger === "date_or_conflict" && !data.reviewAt) throw new OfficeError("Choose a review date or explicit conflicting-evidence trigger.");
  return command(principal, data.operationId, "manage_case", data, "office.decide", async (tx) => {
    await tx.$executeRaw`SELECT id FROM "OfficeCase" WHERE id=${data.caseId} FOR UPDATE`;
    const item = await tx.officeCase.findUnique({ where: { id: data.caseId } });
    if (!item) throw new OfficeError("Office case not found.", 404);
    if (item.revision !== data.expectedRevision) throw new OfficeError("This case changed. Reload its evidence before deciding.", 409);
    if (data.responsibleUserId && !await tx.user.findFirst({ where: { id: data.responsibleUserId, isActive: true }, select: { id: true } })) throw new OfficeError("Assign an active person.");
    const status = data.action === "watch" ? "watching" : data.action === "resolve" ? "resolved" : data.action === "reopen" ? "open" : item.status === "open" ? "assigned" : item.status;
    const updated = await tx.officeCase.update({ where: { id: item.id }, data: { status, responsibleUserId: data.responsibleUserId === undefined ? item.responsibleUserId : data.responsibleUserId, nextAction: data.nextAction ?? item.nextAction, reviewAt: data.reviewAt ? new Date(data.reviewAt) : null, reviewTrigger: data.reviewTrigger, resolution: data.action === "resolve" ? data.reason : data.action === "reopen" ? null : item.resolution, resolvedAt: data.action === "resolve" ? new Date() : data.action === "reopen" ? null : item.resolvedAt, revision: { increment: 1 } } });
    await caseEvent(tx, item.id, principal.userId, data.action, data.reason, { previousRevision: item.revision, decision: data });
    return { case: plain(updated) };
  });
}

export const createOfficeReturnExpectationInputSchema = z.object({ operationId: operation, unitId: id, activatedAt: stamp, expectedAt: stamp, sourceAsOf: stamp, sourceRef: explanation, evidence: explanation }).strict();
export async function createOfficeReturnExpectation(principal: Principal, raw: unknown) {
  const data = createOfficeReturnExpectationInputSchema.parse(raw);
  if (Date.parse(data.activatedAt) > Date.parse(data.expectedAt) || Date.parse(data.sourceAsOf) > Date.now() + 300_000) throw new OfficeError("Use a valid expectation interval and source-as-of time.");
  return command(principal, data.operationId, "return_expectation", data, "office.decide", async (tx) => {
    await unitExists(tx, data.unitId);
    const expectation = await tx.officeReturnExpectation.create({ data: { unitId: data.unitId, kind: "office_return", status: "expected", condition: "none", activatedAt: new Date(data.activatedAt), expectedAt: new Date(data.expectedAt), sourceAsOf: new Date(data.sourceAsOf), sourceRef: data.sourceRef, evidence: data.evidence, createdByUserId: principal.userId } });
    return { expectation: plain(expectation), evaluation: await evaluateUnit(tx, principal, data.unitId, new Date()) };
  });
}

export const createOfficeDispositionInputSchema = z.object({ operationId: operation, unitId: id, caseId: id.optional(), kind: z.enum(["reschedule", "customer_property", "hold", "rtv", "conditional_rtv"]), reason: explanation, instruction: explanation, triggerAt: stamp.optional(), expiresAt: stamp.optional(), requireNoUpcomingDate: z.boolean().default(false), targetLocation: z.string().trim().min(1).max(200).optional() }).strict();
export async function createOfficeDisposition(principal: Principal, raw: unknown) {
  const data = createOfficeDispositionInputSchema.parse(raw);
  const rtv = data.kind === "rtv" || data.kind === "conditional_rtv";
  if (rtv && !data.expiresAt) throw new OfficeError("RTV authorization requires an explicit expiry.");
  if (data.kind === "conditional_rtv" && !data.triggerAt) throw new OfficeError("Conditional RTV requires its exact scan-after deadline.");
  if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now()) throw new OfficeError("Choose a future expiry.");
  if (data.triggerAt && data.expiresAt && Date.parse(data.triggerAt) >= Date.parse(data.expiresAt)) throw new OfficeError("Authorization must remain valid after the trigger deadline.");
  return command(principal, data.operationId, "disposition", data, rtv ? "office.authorize_rtv" : "office.decide", async (tx) => {
    await unitExists(tx, data.unitId);
    if (data.caseId && !await tx.officeCase.findFirst({ where: { id: data.caseId, unitId: data.unitId }, select: { id: true } })) throw new OfficeError("Disposition must target the case's exact physical unit.");
    const disposition = await tx.officeDisposition.create({ data: { unitId: data.unitId, caseId: data.caseId, kind: data.kind, reason: data.reason, instruction: data.instruction, decidedByUserId: principal.userId, authorizedByUserId: rtv ? principal.userId : null, authorizedAt: rtv ? new Date() : null, triggerAt: data.triggerAt ? new Date(data.triggerAt) : null, expiresAt: data.expiresAt ? new Date(data.expiresAt) : null, requireNoUpcomingDate: data.requireNoUpcomingDate, targetLocation: data.targetLocation } });
    if (data.caseId) await caseEvent(tx, data.caseId, principal.userId, rtv ? "rtv_authorized" : "disposition_recorded", data.reason, { dispositionId: disposition.id, exactUnitId: data.unitId });
    return { disposition: plain(disposition), execution: "Instruction/authorization recorded only. No physical movement, MARS submission or print was performed." };
  }, rtv);
}

export const revokeOfficeDispositionInputSchema = z.object({ operationId: operation, dispositionId: id, expectedRevision: z.number().int().positive(), reason: explanation }).strict();
export async function revokeOfficeDisposition(principal: Principal, raw: unknown) {
  const data = revokeOfficeDispositionInputSchema.parse(raw);
  const target = await prisma.officeDisposition.findUnique({ where: { id: data.dispositionId }, select: { kind: true } });
  if (!target) throw new OfficeError("Disposition not found.", 404);
  const rtv = target.kind === "rtv" || target.kind === "conditional_rtv";
  return command(principal, data.operationId, "revoke_disposition", data, rtv ? "office.authorize_rtv" : "office.decide", async (tx) => {
    await tx.$executeRaw`SELECT id FROM "OfficeDisposition" WHERE id=${data.dispositionId} FOR UPDATE`;
    const current = await tx.officeDisposition.findUniqueOrThrow({ where: { id: data.dispositionId } });
    if (current.revision !== data.expectedRevision) throw new OfficeError("Disposition changed. Reload before revoking.", 409);
    const disposition = await tx.officeDisposition.update({ where: { id: current.id }, data: { status: "revoked", revokedAt: new Date(), revokedByUserId: principal.userId, revocationReason: data.reason, revision: { increment: 1 } } });
    const ready = await tx.officeCase.findUnique({ where: { caseKey: fingerprint([current.unitId, "authorized_rtv_ready", current.id]) } });
    if (ready) {
      await tx.officeCase.update({ where: { id: ready.id }, data: { status: "open", nextAction: "RTV authorization revoked. Office must decide new handling instructions.", resolvedAt: null, resolution: null, conditionSignature: fingerprint([current.id, "revoked"]), revision: { increment: 1 } } });
      await caseEvent(tx, ready.id, principal.userId, "authorization_revoked", data.reason, { dispositionId: current.id });
    }
    return { disposition: plain(disposition) };
  }, rtv);
}

async function evaluateObservation(tx: Prisma.TransactionClient, principal: Principal, observationId: string, now: Date) {
  const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
  if (!observation) throw new OfficeError("Physical observation not found.", 404);
  const unitId = observation.corrections[0] ? observation.corrections[0].unitId : observation.unitId;
  if (!unitId) return { instructions: [], blockingDispatch: [] as OfficeDispatchRestriction[], evaluation: null, reason: "Resolve the scan's unit identity before applying office instructions." };
  const data = await facts(tx, unitId, now);
  const instructions: Array<{ dispositionId: string; unitId: string; instruction: string; action: string; targetLocation: string | null }> = [];
  for (const disposition of data.dispositions.filter(item => !["rtv", "conditional_rtv"].includes(item.kind))) {
    if (disposition.expiresAt && disposition.expiresAt <= now) continue;
    instructions.push({ dispositionId: disposition.id, unitId, instruction: disposition.instruction, action: disposition.kind, targetLocation: disposition.targetLocation });
  }
  for (const disposition of data.dispositions) {
    if (!["rtv", "conditional_rtv"].includes(disposition.kind) || !disposition.authorizedAt || !disposition.authorizedByUserId || !disposition.expiresAt || disposition.expiresAt <= now) continue;
    if (observation.type === "departure" || !data.custody.warehouseEvidence || observation.capturedAt < disposition.authorizedAt || (disposition.triggerAt && (disposition.triggerAt > now || observation.capturedAt < disposition.triggerAt))) continue;
    if (disposition.requireNoUpcomingDate && (!data.scheduleCurrent || data.upcoming)) continue;
    const conflicting = data.dispositions.filter((item) => ["hold", "customer_property"].includes(item.kind));
    if (conflicting.length) {
      await ensureCase(tx, principal, { unitId, reason: "disposition_conflict", episodeKey: disposition.id, signature: conflicting.map((item) => item.id).sort(), evidence: { rtvDisposition: disposition.id, conflictingDispositions: conflicting.map((item) => ({ id: item.id, kind: item.kind, instruction: item.instruction })) }, nextAction: "Office review: hold/customer-property instructions conflict with RTV. Do not execute RTV until resolved." }, now);
      continue;
    }
    if (disposition.status === "active") {
      const changed = await tx.officeDisposition.updateMany({ where: { id: disposition.id, status: "active", revision: disposition.revision }, data: { status: "triggered", triggeredByObservationId: observation.id, triggeredAt: now, revision: { increment: 1 } } });
      if (!changed.count) {
        const current = await tx.officeDisposition.findUnique({ where: { id: disposition.id } });
        if (!current || current.status !== "triggered" || !current.expiresAt || current.expiresAt <= now) continue;
      }
    }
    await ensureCase(tx, principal, { unitId, reason: "authorized_rtv_ready", episodeKey: disposition.id, signature: { disposition: disposition.id }, evidence: { why: disposition.reason, exactUnitId: unitId, qualifyingObservation: observation.id, authorizedByUserId: disposition.authorizedByUserId, authorizedAt: disposition.authorizedAt, expiresAt: disposition.expiresAt }, nextAction: disposition.instruction }, now);
    instructions.push({ dispositionId: disposition.id, unitId, instruction: disposition.instruction, action: "route_to_authorized_rtv_workflow", targetLocation: disposition.targetLocation });
  }
  const evaluation = await evaluateUnit(tx, principal, unitId, now);
  const blockingDispatch = await currentOfficeDispatchRestrictions(tx, unitId, now);
  const validatedInstructions = instructions.filter((instruction) => instruction.action !== "route_to_authorized_rtv_workflow" || blockingDispatch.some((restriction) => restriction.dispositionId === instruction.dispositionId && restriction.authorityState === "authorized_rtv"));
  for (const restriction of blockingDispatch.filter((item) => item.authorityState === "rtv_review_required")) {
    await ensureCase(tx, principal, { unitId, reason: "disposition_conflict", episodeKey: restriction.dispositionId, signature: { dispositionId: restriction.dispositionId, reason: restriction.reason }, evidence: { why: restriction.reason, priorDispositionId: restriction.dispositionId, exactUnitId: unitId, qualifyingObservation: observation.id, instruction: restriction.instruction }, nextAction: "Office must reconcile current physical/scheduling evidence with the prior RTV instruction before dispatch or RTV execution." }, now);
    validatedInstructions.push({ dispositionId: restriction.dispositionId, unitId, instruction: `Office review required: ${restriction.reason}`, action: "office_review_required", targetLocation: restriction.targetLocation });
  }
  return { instructions: validatedInstructions, blockingDispatch, evaluation, reason: "Instructions are distinct from confirmed execution; no MARS operation was sent." };
}

export async function reviewWorkflowOfficeObservation(tx: Prisma.TransactionClient, principal: Principal, input: { observationId: string }) {
  await assertCurrentPrincipal(tx, principal, "workflow.execute");
  const observationId = id.parse(input.observationId);
  const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, select: { userId: true } });
  if (!observation || observation.userId !== principal.userId) throw new OfficeError("Workflow review requires the original operator's own captured observation.", 403);
  return evaluateObservation(tx, principal, observationId, new Date());
}

export const reviewOfficeObservationInputSchema = z.object({ observationId: id }).strict();
export async function reviewOfficeObservation(principal: Principal, raw: unknown) {
  const { observationId } = reviewOfficeObservationInputSchema.parse(raw);
  assertCapability(principal, "inventory.write");
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "inventory.write");
    const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, select: { userId: true } });
    if (!observation || observation.userId !== principal.userId) throw new OfficeError("Review your own captured scan or use office case review.", 403);
    return evaluateObservation(tx, principal, observationId, new Date());
  });
}

export const recordOfficeDispositionExecutionInputSchema = z.object({ operationId: operation, dispositionId: id, observationId: id, evidence: explanation }).strict();
export async function recordOfficeDispositionExecution(principal: Principal, raw: unknown) {
  const data = recordOfficeDispositionExecutionInputSchema.parse(raw);
  return command(principal, data.operationId, "execute_disposition", data, "workflow.execute", async (tx) => {
    await tx.$executeRaw`SELECT id FROM "OfficeDisposition" WHERE id=${data.dispositionId} FOR UPDATE`;
    const disposition = await tx.officeDisposition.findUnique({ where: { id: data.dispositionId }, include: { executions: true } });
    if (!disposition || !["active", "triggered"].includes(disposition.status) || !disposition.authorizedByUserId || !disposition.expiresAt || disposition.expiresAt <= new Date()) throw new OfficeError("A current exact-unit RTV authorization is required.", 409);
    await assertUnitOperationalCustodyInTransaction(tx, principal, disposition.unitId);
    const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: data.observationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
    const actualUnitId = observation?.corrections[0] ? observation.corrections[0].unitId : observation?.unitId;
    if (!observation || observation.userId !== principal.userId || actualUnitId !== disposition.unitId || observation.type !== "placement" || !observation.location || !disposition.authorizedAt || observation.capturedAt < disposition.authorizedAt || (disposition.triggerAt && observation.capturedAt < disposition.triggerAt)) throw new OfficeError("Confirm actual placement of this exact authorized unit with your own qualifying scan.");
    if (disposition.targetLocation && disposition.targetLocation.trim().toUpperCase() !== observation.location.trim().toUpperCase()) throw new OfficeError("The placement does not confirm the authorized destination.");
    const current = await facts(tx, disposition.unitId);
    if (current.dispositions.some((item) => ["hold", "customer_property"].includes(item.kind))) throw new OfficeError("A hold/customer-property instruction conflicts with RTV. Office must resolve it first.", 409);
    if (!current.custody.warehouseEvidence || current.custody.last?.id !== observation.id || (disposition.requireNoUpcomingDate && (!current.scheduleCurrent || current.upcoming))) throw new OfficeError("New evidence conflicts with this execution. Review the current unit instructions.", 409);
    const execution = await tx.officeDispositionExecution.create({ data: { dispositionId: disposition.id, action: "rtv_placement_confirmed", observationId: observation.id, evidence: data.evidence, executedByUserId: principal.userId } });
    await tx.officeDisposition.update({ where: { id: disposition.id }, data: { status: "executed", revision: { increment: 1 } } });
    const ready = await tx.officeCase.findUnique({ where: { caseKey: fingerprint([disposition.unitId, "authorized_rtv_ready", disposition.id]) } });
    if (ready && ready.status !== "resolved") { await tx.officeCase.update({ where: { id: ready.id }, data: { status: "resolved", resolution: "This authorized RTV placement was physically confirmed. External submission/pickup remain separate.", resolvedAt: new Date(), revision: { increment: 1 } } }); await caseEvent(tx, ready.id, principal.userId, "execution_confirmed", "Exact authorized unit placement confirmed.", { executionId: execution.id, observationId: observation.id }); }
    return { execution: plain(execution), externalEffect: "No MARS submission, pickup or printer action was performed." };
  });
}

export const officeEvaluationCandidateWhere: Prisma.WarehouseUnitWhereInput = { OR: [{ officeSchedules: { some: {} } }, { officeDispositions: { some: {} } }, { returnExpectations: { some: {} } }, { observations: { some: {} } }, { observationCorrections: { some: {} } }, { sharedAliases: { some: { kind: "submission", revokedAt: null } } }] };
async function candidateUnits(tx: Prisma.TransactionClient, input: { unitIds?: string[]; limit?: number; afterUnitId?: string; throughUnitId?: string }) {
  const limit = input.limit ?? 100;
  const units = await tx.warehouseUnit.findMany({ where: { ...(input.unitIds ? {} : officeEvaluationCandidateWhere), id: { ...(input.unitIds ? { in: input.unitIds } : {}), gt: input.afterUnitId ?? "", ...(input.throughUnitId ? { lte: input.throughUnitId } : {}) } }, orderBy: { id: "asc" }, take: limit + 1, select: { id: true } });
  return { units: units.slice(0, limit), hasMore: units.length > limit, nextAfterUnitId: units.length > limit ? units[limit - 1].id : null };
}
export const officeEvaluationInputSchema = z.object({ unitIds: z.array(id).min(1).max(200).optional(), limit: z.number().int().min(1).max(200).default(100), afterUnitId: id.optional() }).strict();
export const evaluateOfficeWorkInputSchema = officeEvaluationInputSchema;
export const getExpectedReturnWorklistInputSchema = officeEvaluationInputSchema;
export async function evaluateOfficePageInTransaction(tx: Prisma.TransactionClient, principal: Principal, input: { unitIds?: string[]; limit?: number; afterUnitId?: string; throughUnitId?: string }, now = new Date()) {
  const capability = principal.capabilities.includes("office.decide") ? "office.decide" : "inventory.write";
  await assertCurrentPrincipal(tx, principal, capability);
  const page = await candidateUnits(tx, input);
  const evaluations = [];
  for (const unit of page.units) evaluations.push({ unitId: unit.id, ...await evaluateUnit(tx, principal, unit.id, now) });
  return { evaluations, hasMore: page.hasMore, nextAfterUnitId: page.nextAfterUnitId };
}
export async function evaluateOfficeWork(principal: Principal, raw: unknown = {}) {
  const input = officeEvaluationInputSchema.parse(raw);
  const capability = principal.capabilities.includes("office.decide") ? "office.decide" : "inventory.write";
  assertCapability(principal, capability);
  return prisma.$transaction((tx) => evaluateOfficePageInTransaction(tx, principal, input), { timeout: 60_000 });
}

export const listOfficeCasesInputSchema = z.object({ unitId: id.optional(), status: z.enum(["active", "all", "open", "assigned", "watching", "resolved"]).default("active"), limit: z.number().int().min(1).max(200).default(100), afterId: id.optional() }).strict();
export async function listOfficeCases(principal: Principal, raw: unknown = {}) {
  assertCapability(principal, "workflow.read");
  const data = listOfficeCasesInputSchema.parse(raw);
  const cases = await prisma.officeCase.findMany({ where: { ...(data.unitId ? { unitId: data.unitId } : {}), ...(data.status === "all" ? {} : data.status === "active" ? { status: { not: "resolved" } } : { status: data.status }), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, orderBy: { id: "asc" }, take: data.limit + 1, include: { unit: { select: { inventoryRows: { select: { lpn: true, description: true } } } } } });
  return { cases: plain(cases.slice(0, data.limit)), hasMore: cases.length > data.limit, nextAfterId: cases.length > data.limit ? cases[data.limit - 1].id : null };
}

export const getOfficeCaseInputSchema = z.object({ caseId: id }).strict();
export async function getOfficeCase(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const { caseId } = getOfficeCaseInputSchema.parse(raw);
  const result = await prisma.officeCase.findUnique({ where: { id: caseId }, include: { events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, dispositions: { include: { executions: true }, orderBy: { createdAt: "desc" } }, unit: { select: { inventoryRows: { select: { lpn: true, description: true } } } } } });
  if (!result) throw new OfficeError("Office case not found.", 404);
  return plain(result);
}

export const getOfficeUnitContextInputSchema = z.object({ unitId: id }).strict();
export async function getOfficeUnitContext(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const { unitId } = getOfficeUnitContextInputSchema.parse(raw);
  if (!await prisma.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new OfficeError("Physical unit not found.", 404);
  const [schedules, exchanges, expectations, dispositions] = await Promise.all([
    prisma.officeScheduleFact.findMany({ where: { unitId }, orderBy: { sourceAsOf: "desc" }, take: 100 }),
    prisma.officeExchange.findMany({ where: { OR: [{ originalUnitId: unitId }, { replacementUnitId: unitId }] }, include: { attempts: { orderBy: { occurredAt: "asc" } }, expectations: true }, orderBy: { createdAt: "desc" } }),
    prisma.officeReturnExpectation.findMany({ where: { unitId }, orderBy: { createdAt: "desc" } }),
    prisma.officeDisposition.findMany({ where: { unitId }, include: { executions: true }, orderBy: { createdAt: "desc" } }),
  ]);
  return plain({ unitId, schedules, exchanges, expectations, dispositions, sourceQualification: "Manual office facts are not a qualified live DMP adapter." });
}

export const getOfficePeopleInputSchema = z.object({}).strict();
export async function getOfficePeople(principal: Principal) {
  assertCapability(principal, "office.decide");
  return prisma.user.findMany({ where: { isActive: true }, select: { id: true, displayName: true, username: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }] });
}

export interface ReturnWorkItem { key: string; kind: string; unitId: string | null; why: string; trailStopsAt: string; physicalEvidenceAt: string | null; expectationId?: string; submissionNumber?: string; sourceAsOf?: string | null; certainty: string }
async function unitReturnWork(tx: Prisma.TransactionClient, unitId: string, now: Date): Promise<ReturnWorkItem[]> {
  const data = await facts(tx, unitId, now);
  const items: ReturnWorkItem[] = [];
  for (const expectation of data.expectations.filter((item) => item.status === "expected" && item.expectedAt && item.expectedAt <= now && !data.checkedIn(item.activatedAt))) items.push({ key: `expected:${expectation.id}`, kind: "expected_return_not_checked_in", unitId, expectationId: expectation.id, why: expectation.evidence, trailStopsAt: "Expected movement has no qualifying check-in confirmation.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), certainty: "expected_not_physically_confirmed" });
  const aliases = await tx.warehouseUnitAlias.findMany({ where: { unitId, kind: "submission", revokedAt: null }, select: { value: true } });
  const validValues: string[] = [];
  for (const alias of aliases) {
    const linked = await tx.warehouseUnitAlias.findMany({ where: { kind: "submission", value: alias.value, revokedAt: null }, select: { unitId: true }, distinct: ["unitId"] });
    if (linked.length === 1) validValues.push(alias.value.toLowerCase());
    else items.push({ key: `submission-ambiguous:${unitId}:${alias.value}`, kind: "ambiguous_submission_link", unitId, submissionNumber: alias.value, why: "This submission identifier is linked to several distinct physical units.", trailStopsAt: "Resolve physical identity before asserting submission status or creating another return.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), certainty: "ambiguous_link_not_resolved_identity" });
  }
  const submissions = validValues.length ? await tx.$queryRaw<MarsUnit[]>`SELECT * FROM "MarsUnit" WHERE lower("requestNumber") IN (${Prisma.join(validValues)})` : [];
  const rtv = data.dispositions.find((item) => ["rtv", "conditional_rtv"].includes(item.kind) && (item.kind === "rtv" || ["triggered", "executed"].includes(item.status)));
  if (rtv && data.custody.warehouseEvidence && !submissions.length) {
    if (data.custody.currentCheckIn && !aliases.length) items.push({ key: `rtv-no-submission:${unitId}`, kind: "checked_in_rtv_without_submission", unitId, why: rtv.reason, trailStopsAt: "Physical check-in and RTV authority exist; no submission identity is linked.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), certainty: "authorization_and_observation_separate_from_submission" });
    else items.push({ key: `seen-no-submission:${unitId}`, kind: "physically_seen_no_matching_submission", unitId, why: "This physically observed return-context unit has an eligible RTV disposition but no matching MARS submission.", trailStopsAt: aliases.length ? "Existing submission link cannot be verified against imported MARS records. Reconcile before creating another." : "RTV handling is authorized, but the trail has physical sighting rather than a confirmed return check-in and no submission link.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), certainty: "linkage_gap_not_an_automatic_new_submission" });
  }
  const audit = await tx.marsAuditSession.findFirst({ where: { completedAt: { not: null } }, orderBy: { completedAt: "desc" } });
  for (const submission of submissions) {
    const external = classifyMarsUnit(submission);
    const seenInAudit = audit && (data.observations.some((observation) => observation.capturedAt >= audit.startedAt && observation.capturedAt <= audit.completedAt!) || await tx.marsAuditScan.count({ where: { auditSessionId: audit.id, marsUnitId: submission.id } }) > 0);
    if (audit && submission.createdAt <= audit.completedAt! && external.expectedInWarehouse && !seenInAudit) items.push({ key: `submission-audit:${submission.id}:${audit.id}`, kind: "submission_not_seen_in_audit", unitId, submissionNumber: submission.requestNumber, why: `MARS imported status ${submission.returnStatus || "unknown"} expects this submission in warehouse; the latest completed MARS audit did not see its linked unit/submission.`, trailStopsAt: `Expected submission → missing observation in completed audit ${audit.id}.`, physicalEvidenceAt: iso(data.custody.last?.capturedAt), sourceAsOf: null, certainty: "scoped_audit_gap_not_proof_of_departure" });
    if (["shipped", "received"].includes(external.bucket) && data.custody.warehouseEvidence && (!submission.lastImportedAt || data.custody.last!.capturedAt >= submission.lastImportedAt)) items.push({ key: `external-seen:${submission.id}`, kind: "external_departed_but_seen_here", unitId, submissionNumber: submission.requestNumber, why: `MARS reports ${submission.returnStatus}; a later physical observation still sees this linked unit here.`, trailStopsAt: "External reported state conflicts with later physical evidence; reconcile pickup/departure/status.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), sourceAsOf: null, certainty: "source_as_of_unknown_import_time_is_not_source_time" });
  }
  if (data.custody.warehouseEvidence && data.rows.some((row) => /^delivered$/i.test(row.status))) items.push({ key: `wms-delivered-seen:${unitId}`, kind: "external_departed_but_seen_here", unitId, why: "A retained WMS row reports delivered, while physical warehouse evidence has not been superseded by departure.", trailStopsAt: "Reported delivery versus observed warehouse custody needs reconciliation.", physicalEvidenceAt: iso(data.custody.last?.capturedAt), sourceAsOf: null, certainty: "reported_state_conflict_requires_timeline_review" });
  return items;
}

export async function getExpectedReturnWorklist(principal: Principal, raw: unknown = {}) {
  assertCapability(principal, "workflow.read");
  const input = officeEvaluationInputSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const page = await candidateUnits(tx, input);
    const items: ReturnWorkItem[] = [];
    for (const unit of page.units) items.push(...await unitReturnWork(tx, unit.id, new Date()));
    return { items, hasMore: page.hasMore, nextAfterUnitId: page.nextAfterUnitId, qualification: "Shared physical/office evidence plus imported MARS statuses; live DMP/MARS mappings and submissions are not claimed." };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}
