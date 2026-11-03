import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Capability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { recordWorkflowObservation, resolveWarehouseIdentifierInTransaction } from "@/lib/warehouse/units";
import { currentOfficeDispatchRestrictions, reviewWorkflowOfficeObservation } from "@/lib/office/service";
import { DispatchError, dispatchDay, dispatchHash, dispatchId, dispatchLine, dispatchOperation, dispatchPlain, dispatchReason, dispatchSlot, dispatchSourceNotice, dispatchStamp, expandDispatchLines, type DispatchSlot } from "./model";

export { DispatchError } from "./model";
const asJson = (value: unknown) => dispatchPlain(value) as Prisma.InputJsonValue;
const slotsOf = (value: unknown) => z.array(dispatchSlot).parse(value);
async function dispatchEvent(tx: Prisma.TransactionClient, principal: Principal, input: { boardId: string; snapshotId?: string; sessionId?: string; action: string; note: string; payload?: unknown }) { await tx.dispatchEvent.create({ data: { ...input, userId: principal.userId, payload: asJson(input.payload ?? {}) } }); }
async function dispatchCommand<T extends object>(principal: Principal, operationId: string, action: string, input: unknown, capability: Capability, run: (tx: Prisma.TransactionClient) => Promise<T>, recent = false) {
  assertCapability(principal, capability);
  const fingerprint = dispatchHash({ action, input });
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, capability, recent);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-command:${principal.userId}:${operationId}`},0))`;
    const previous = await tx.dispatchCommandReceipt.findUnique({ where: { userId_operationId: { userId: principal.userId, operationId } } });
    if (previous) { if (previous.fingerprint !== fingerprint) throw new DispatchError("This operation ID was already used for different dispatch work.", 409); return { ...(previous.result as T), replayed: true }; }
    const result = dispatchPlain(await run(tx));
    await tx.dispatchCommandReceipt.create({ data: { userId: principal.userId, operationId, fingerprint, result: asJson(result) } });
    return { ...result, replayed: false };
  }, { timeout: 60_000 });
}

async function currentSnapshot(tx: Prisma.TransactionClient, snapshotId: string, expectedHeadId?: string) {
  const initial = await tx.dispatchSnapshot.findUnique({ where: { id: snapshotId }, select: { boardId: true } });
  if (!initial) throw new DispatchError("Dispatch snapshot not found.", 404);
  await tx.$executeRaw`SELECT id FROM "DispatchBoard" WHERE id=${initial.boardId} FOR UPDATE`;
  const snapshot = await tx.dispatchSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, include: { board: true } });
  if (snapshot.status !== "approved" || snapshot.board.headSnapshotId !== snapshot.id || (expectedHeadId !== undefined && expectedHeadId !== snapshot.id)) throw new DispatchError("Dispatch demand changed. Refresh the current snapshot before acting.", 409);
  return snapshot;
}

export const getDispatchAdapterStatusInputSchema = z.object({}).strict();
export async function getDispatchAdapterStatus(principal: Principal) {
  assertCapability(principal, "workflow.read");
  return { qualifiedDmpAdapterEnabled: false, officialFinalsQualified: false, supportedSources: ["manual_reviewed", "workbook_fallback"], reason: dispatchSourceNotice };
}

export const createDispatchSnapshotInputSchema = z.object({ operationId: dispatchOperation, day: dispatchDay, scope: z.string().trim().min(1).max(100), sourceKind: z.enum(["manual_reviewed", "workbook_fallback"]).default("manual_reviewed"), sourceAsOf: dispatchStamp, sourceRef: dispatchReason, coverage: z.enum(["complete", "partial"]), note: dispatchReason, lines: z.array(dispatchLine).max(500) }).strict();
export async function createDispatchSnapshot(principal: Principal, raw: unknown) {
  const input = createDispatchSnapshotInputSchema.parse(raw);
  if (Date.parse(input.sourceAsOf) > Date.now() + 300_000) throw new DispatchError("Source-as-of cannot be in the future.");
  const slots = expandDispatchLines(input.lines);
  return dispatchCommand(principal, input.operationId, "create_snapshot", input, "office.decide", async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-board:${input.day}:${input.scope}`},0))`;
    const board = await tx.dispatchBoard.findFirst({ where: { day: input.day, scope: input.scope } }) ?? await tx.dispatchBoard.create({ data: { day: input.day, scope: input.scope } });
    await tx.$executeRaw`SELECT id FROM "DispatchBoard" WHERE id=${board.id} FOR UPDATE`;
    const current = await tx.dispatchBoard.findUniqueOrThrow({ where: { id: board.id } });
    const snapshot = await tx.dispatchSnapshot.create({ data: { boardId: board.id, version: current.nextVersion, baseHeadId: current.headSnapshotId, sourceKind: input.sourceKind, sourceAsOf: new Date(input.sourceAsOf), sourceRef: input.sourceRef, coverage: input.coverage, note: input.note, slots: asJson(slots), status: input.coverage === "complete" ? "draft" : "incomplete", createdByUserId: principal.userId } });
    await tx.dispatchBoard.update({ where: { id: board.id }, data: { nextVersion: { increment: 1 } } });
    await dispatchEvent(tx, principal, { boardId: board.id, snapshotId: snapshot.id, action: "snapshot_created", note: input.note, payload: { sourceKind: snapshot.sourceKind, coverage: snapshot.coverage, slotCount: slots.length } });
    return { boardId: board.id, snapshotId: snapshot.id, version: snapshot.version, baseHeadId: snapshot.baseHeadId, status: snapshot.status, slotCount: slots.length, sourceNotice: dispatchSourceNotice };
  });
}

export const createDispatchWorkbookSnapshotInputSchema = z.object({ operationId: dispatchOperation, day: dispatchDay, scope: z.string().trim().min(1).max(100), sourceAsOf: dispatchStamp, sourceRef: dispatchReason, coverage: z.enum(["complete", "partial"]), note: dispatchReason, filename: z.string().trim().min(1).max(200), workbookBase64: z.string().min(1).max(5_600_000), routeLanes: z.array(z.object({ route: z.string().trim().min(1).max(100), lane: z.string().trim().min(1).max(100) }).strict()).min(1).max(500) }).strict();
export async function createDispatchWorkbookSnapshot(principal: Principal, raw: unknown) {
  assertCapability(principal, "office.decide");
  const input = createDispatchWorkbookSnapshotInputSchema.parse(raw);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.workbookBase64)) throw new DispatchError("Workbook must be base64-encoded XLSX data.");
  const bytes = Buffer.from(input.workbookBase64, "base64");
  if (bytes.length > 4 * 1024 * 1024) throw new DispatchError("Dispatch workbooks are limited to 4 MiB.", 413);
  const { parsePickWaveWorkbook } = await import("@/lib/pick-waves");
  const parsed = await parsePickWaveWorkbook(bytes as unknown as Parameters<typeof parsePickWaveWorkbook>[0]);
  const routes = new Map<string, string>();
  for (const mapping of input.routeLanes) { if (routes.has(mapping.route)) throw new DispatchError("Specify each workbook route once."); routes.set(mapping.route, mapping.lane); }
  const lines = parsed.items.map((item) => {
    const lane = item.routeNumber ? routes.get(item.routeNumber) : null;
    if (!lane || !item.routeNumber) throw new DispatchError(`Workbook row ${item.rowNumber} needs an explicit route and reviewed lane mapping.`);
    const identifiers = [...(item.lpn ? [{ kind: "lpn" as const, value: item.lpn }] : [])];
    // Serial namespaces and tracking-to-MSN semantics are not established by this workbook parser.
    // A reviewer can supply those exact identity groups in a new manual draft; never infer them here.
    return { lineKey: `workbook-row-${item.rowNumber}`, quantity: 1, lane, route: item.routeNumber, orderReference: item.orderNumber ?? "", description: item.description ?? "", partNumber: item.partNumber ?? "", expectedUnits: identifiers.length ? [{ identifiers }] : [] };
  });
  return createDispatchSnapshot(principal, { operationId: input.operationId, day: input.day, scope: input.scope, sourceKind: "workbook_fallback", sourceAsOf: input.sourceAsOf, sourceRef: `${input.sourceRef} · ${input.filename}`.slice(0, 2000), coverage: input.coverage, note: `${input.note}\nManual workbook fallback: each reviewed row is one unit slot. Tracking and unnamespaced serials are not physical-identity mappings; order-only rows remain unmatched.`.slice(0, 2000), lines });
}

async function matchSlot(tx: Prisma.TransactionClient, slot: DispatchSlot, snapshotId: string) {
  const groups: string[][] = []; const missingIdentifiers: string[] = [];
  if (slot.expectedUnit.unitId) { const exists = await tx.warehouseUnit.findUnique({ where: { id: slot.expectedUnit.unitId }, select: { id: true } }); if (exists) groups.push([exists.id]); else missingIdentifiers.push("Declared physical unit ID is not present."); }
  for (const identifier of slot.expectedUnit.identifiers) { const resolved = await resolveWarehouseIdentifierInTransaction(tx, identifier); if (resolved.truncated) return { state: "ambiguous" as const, candidateUnitIds: resolved.candidateUnitIds, why: "Identifier candidate limit exceeded; further identity evidence is required." }; if (!resolved.candidateUnitIds.length) missingIdentifiers.push(`${identifier.kind}: ${identifier.value}`); else groups.push(resolved.candidateUnitIds); }
  const union = [...new Set(groups.flat())]; const intersection = groups.length ? groups.reduce((left, right) => left.filter((value) => right.includes(value))) : [];
  if (missingIdentifiers.length || !groups.length) return { state: "missing" as const, candidateUnitIds: union, why: missingIdentifiers.length ? `Unlinked/unknown identifiers: ${missingIdentifiers.join("; ")}` : "No physical-unit identifiers supplied. An order number alone cannot allocate a unit." };
  if (!intersection.length) return { state: "conflicting" as const, candidateUnitIds: union, why: "The supplied identifiers point to different physical units." };
  if (intersection.length > 1) return { state: "ambiguous" as const, candidateUnitIds: intersection, why: "Several physical units satisfy these identifiers. Scan or record another exact identifier." };
  const reserved = await tx.dispatchReservation.findUnique({ where: { unitId: intersection[0] }, include: { allocation: true } });
  if (reserved && (reserved.snapshotId !== snapshotId || reserved.allocation.slotKey !== slot.slotKey)) return { state: "conflicting" as const, candidateUnitIds: intersection, why: "This physical unit is already allocated to other active dispatch work." };
  const rows = await tx.inventoryAuditItem.findMany({ where: { unitId: intersection[0] }, select: { status: true, lpn: true } });
  if (rows.length && rows.every((row) => /^(delivered|shipped)$/i.test(row.status))) return { state: "conflicting" as const, candidateUnitIds: intersection, why: "Only historical/delivered source rows support this unit. Explicit current physical or office review is required." };
  const physical = await tx.$queryRaw<{ type: string }[]>`SELECT o.type FROM "WarehousePhysicalObservation" o LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${intersection[0]} ORDER BY o."capturedAt" DESC,o."receivedAt" DESC,o.id DESC LIMIT 1`;
  if (physical[0]?.type === "departure") return { state: "conflicting" as const, candidateUnitIds: intersection, why: "The latest physical evidence records departure. Review current custody before an explicit allocation decision." };
  return { state: "ready" as const, candidateUnitIds: intersection, why: "One exact unit satisfies the supplied identity evidence; allocation is a plan, not physical completion." };
}

export const reconcileDispatchRequirementsInputSchema = z.object({ snapshotId: dispatchId }).strict();
export async function reconcileDispatchRequirements(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const { snapshotId } = reconcileDispatchRequirementsInputSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.dispatchSnapshot.findUnique({ where: { id: snapshotId }, include: { board: true, allocations: { where: { releasedAt: null }, include: { unit: { select: { inventoryRows: { select: { lpn: true, description: true } } } } } } } });
    if (!snapshot) throw new DispatchError("Dispatch snapshot not found.", 404);
    const requirements = [];
    for (const slot of slotsOf(snapshot.slots)) {
      const allocation = snapshot.allocations.find((item) => item.slotKey === slot.slotKey);
      requirements.push({ ...slot, ...(allocation ? { state: "allocated" as const, candidateUnitIds: [allocation.unitId], why: "Exact unit allocated; physical pick and lane confirmation remain separate." } : await matchSlot(tx, slot, snapshot.id)), allocation: allocation ? dispatchPlain(allocation) : null });
    }
    return { snapshot: { id: snapshot.id, boardId: snapshot.boardId, day: snapshot.board.day, scope: snapshot.board.scope, version: snapshot.version, status: snapshot.status, sourceKind: snapshot.sourceKind, sourceAsOf: snapshot.sourceAsOf.toISOString(), sourceRef: snapshot.sourceRef, coverage: snapshot.coverage, baseHeadId: snapshot.baseHeadId }, isCurrentHead: snapshot.board.headSnapshotId === snapshot.id, requirements, sourceNotice: dispatchSourceNotice };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

export const allocateDispatchUnitInputSchema = z.object({ operationId: dispatchOperation, snapshotId: dispatchId, expectedHeadId: dispatchId, slotKey: z.string().min(1).max(200), unitId: dispatchId.optional(), evidence: dispatchReason }).strict();
export async function allocateDispatchUnit(principal: Principal, raw: unknown) {
  const input = allocateDispatchUnitInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "allocate", input, "dispatch.allocate", async (tx) => {
    const snapshot = await currentSnapshot(tx, input.snapshotId, input.expectedHeadId);
    const slot = slotsOf(snapshot.slots).find((item) => item.slotKey === input.slotKey);
    if (!slot) throw new DispatchError("Requirement slot not found in this version.", 404);
    if (await tx.dispatchAllocation.findFirst({ where: { snapshotId: snapshot.id, slotKey: slot.slotKey, releasedAt: null } })) throw new DispatchError("This quantity slot is already allocated.", 409);
    const match = await matchSlot(tx, slot, snapshot.id);
    const unitId = input.unitId ?? (match.state === "ready" ? match.candidateUnitIds[0] : null);
    if (!unitId) throw new DispatchError("Resolve the missing, ambiguous or conflicting match before automatic allocation.", 409);
    if (!await tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new DispatchError("Physical unit not found.", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dispatch-unit:${unitId}`},0))`;
    if (await tx.dispatchReservation.findUnique({ where: { unitId } })) throw new DispatchError("This physical unit is already reserved by active dispatch work.", 409);
    const allocation = await tx.dispatchAllocation.create({ data: { snapshotId: snapshot.id, slotKey: slot.slotKey, unitId, matchEvidence: asJson({ evidence: input.evidence, identityMatch: match, manualUnitDecision: Boolean(input.unitId), stockPresenceClaim: false }), createdByUserId: principal.userId } });
    await tx.dispatchReservation.create({ data: { unitId, allocationId: allocation.id, boardId: snapshot.boardId, snapshotId: snapshot.id } });
    await dispatchEvent(tx, principal, { boardId: snapshot.boardId, snapshotId: snapshot.id, action: "unit_allocated", note: input.evidence, payload: { allocationId: allocation.id, unitId, slotKey: slot.slotKey } });
    return { allocation: dispatchPlain(allocation), physicalCompletion: false };
  });
}

export const releaseDispatchAllocationInputSchema = z.object({ operationId: dispatchOperation, allocationId: dispatchId, expectedHeadId: dispatchId, reason: dispatchReason }).strict();
export async function releaseDispatchAllocation(principal: Principal, raw: unknown) {
  const input = releaseDispatchAllocationInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "release_allocation", input, "dispatch.allocate", async (tx) => {
    const allocation = await tx.dispatchAllocation.findUnique({ where: { id: input.allocationId } });
    if (!allocation) throw new DispatchError("Allocation not found.", 404);
    const snapshot = await currentSnapshot(tx, allocation.snapshotId, input.expectedHeadId);
    if (await tx.dispatchFinalsCredit.findFirst({ where: { allocationId: allocation.id, status: "confirmed" } })) throw new DispatchError("This allocation has lane-confirmation evidence. Create a demand amendment before replacing it.", 409);
    await tx.dispatchReservation.deleteMany({ where: { allocationId: allocation.id } });
    await tx.dispatchAllocation.update({ where: { id: allocation.id }, data: { releasedAt: new Date(), releaseReason: input.reason } });
    const binding = await tx.dispatchWaveItem.findUnique({ where: { allocationId: allocation.id } });
    if (binding) await tx.pickWave.update({ where: { id: binding.pickWaveId }, data: { archivedAt: new Date() } });
    await dispatchEvent(tx, principal, { boardId: snapshot.boardId, snapshotId: snapshot.id, action: "allocation_released", note: input.reason, payload: { allocationId: allocation.id } });
    return { allocationId: allocation.id, released: true };
  });
}

function objectJson(value: Prisma.JsonValue) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Prisma.JsonValue> : {}; }
async function ensureFinalsSession(tx: Prisma.TransactionClient, principal: Principal, snapshot: { id: string; boardId: string }) {
  return tx.dispatchFinalsSession.upsert({ where: { snapshotId: snapshot.id }, create: { snapshotId: snapshot.id, boardId: snapshot.boardId, createdByUserId: principal.userId }, update: {} });
}

async function creditStillSupported(tx: Prisma.TransactionClient, credit: { unitId: string; lane: string; confirmedAt: Date; physicalObservationId: string }, lanes: string[]) {
  const original = await tx.warehousePhysicalObservation.findUnique({ where: { id: credit.physicalObservationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
  if (!original || (original.corrections[0] ? original.corrections[0].unitId : original.unitId) !== credit.unitId || original.type !== "placement" || original.location !== credit.lane) return false;
  const knownLanes = [...new Set([...lanes, credit.lane])];
  const conflicting = await tx.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM "WarehousePhysicalObservation" o
    LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
    WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${credit.unitId}
      AND o.id <> ${credit.physicalObservationId} AND o."capturedAt" >= ${credit.confirmedAt}
      AND (o.type='departure' OR ((o.type='placement' OR (o.type='presence' AND o.location IN (${Prisma.join(knownLanes)}))) AND o.location IS DISTINCT FROM ${credit.lane}))
    LIMIT 1`;
  return conflicting.length === 0;
}

async function amendLane(tx: Prisma.TransactionClient, principal: Principal, sessionId: string, lane: string, reason: string, affectedSlotKeys: string[], priorSignoffId?: string, force = false) {
  const session = await tx.dispatchFinalsSession.findUniqueOrThrow({ where: { id: sessionId } });
  const carried = objectJson(session.carriedSignoffs);
  const signed = priorSignoffId || (await tx.dispatchLaneSignoff.findFirst({ where: { sessionId, lane }, orderBy: { version: "desc" }, select: { id: true } }))?.id;
  if (!signed && !carried[lane] && !force) return;
  const existing = await tx.dispatchAmendment.findFirst({ where: { sessionId, lane, resolvedAt: null, reason } });
  const slots = [...new Set([...(existing && Array.isArray(existing.affectedSlotKeys) ? existing.affectedSlotKeys.filter((item): item is string => typeof item === "string") : []), ...affectedSlotKeys])];
  if (existing) await tx.dispatchAmendment.update({ where: { id: existing.id }, data: { affectedSlotKeys: slots } });
  else await tx.dispatchAmendment.create({ data: { sessionId, lane, reason, affectedSlotKeys: slots, priorSignoffId: signed, createdByUserId: principal.userId } });
  delete carried[lane];
  const clearances = objectJson(session.laneClearances); delete clearances[lane];
  await tx.dispatchFinalsSession.update({ where: { id: sessionId }, data: { carriedSignoffs: asJson(carried), laneClearances: asJson(clearances) } });
}

export const approveDispatchSnapshotInputSchema = z.object({ operationId: dispatchOperation, snapshotId: dispatchId, expectedHeadId: dispatchId.nullable(), evidence: dispatchReason }).strict();
export async function approveDispatchSnapshot(principal: Principal, raw: unknown) {
  const input = approveDispatchSnapshotInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "approve_snapshot", input, "office.decide", async (tx) => {
    const initial = await tx.dispatchSnapshot.findUnique({ where: { id: input.snapshotId }, select: { boardId: true } });
    if (!initial) throw new DispatchError("Snapshot not found.", 404);
    await tx.$executeRaw`SELECT id FROM "DispatchBoard" WHERE id=${initial.boardId} FOR UPDATE`;
    const snapshot = await tx.dispatchSnapshot.findUniqueOrThrow({ where: { id: input.snapshotId }, include: { board: true } });
    if (snapshot.coverage !== "complete") throw new DispatchError("An incomplete/partial report cannot replace accepted dispatch requirements.", 409);
    if (snapshot.status !== "draft" || snapshot.board.headSnapshotId !== input.expectedHeadId || snapshot.baseHeadId !== input.expectedHeadId) throw new DispatchError("The dispatch head changed or this draft is already approved. Create/review a fresh draft.", 409);
    const previous = input.expectedHeadId ? await tx.dispatchSnapshot.findUnique({ where: { id: input.expectedHeadId }, include: { allocations: { where: { releasedAt: null } }, finalsSession: true } }) : null;
    if (previous && snapshot.sourceAsOf < previous.sourceAsOf) throw new DispatchError("An older source-as-of cannot overwrite the accepted dispatch scope.", 409);
    const nextSlots = slotsOf(snapshot.slots); const oldSlots = previous ? slotsOf(previous.slots) : [];
    await tx.dispatchReservation.deleteMany({ where: { boardId: snapshot.boardId } });
    const oldWaveBindings = previous ? await tx.dispatchWaveItem.findMany({ where: { snapshotId: previous.id }, select: { pickWaveId: true }, distinct: ["pickWaveId"] }) : [];
    if (oldWaveBindings.length) await tx.pickWave.updateMany({ where: { id: { in: oldWaveBindings.map((binding) => binding.pickWaveId) } }, data: { archivedAt: new Date() } });
    const approved = await tx.dispatchSnapshot.update({ where: { id: snapshot.id }, data: { status: "approved", approvedByUserId: principal.userId, approvedAt: new Date() } });
    await tx.dispatchBoard.update({ where: { id: snapshot.boardId }, data: { headSnapshotId: snapshot.id, revision: { increment: 1 } } });
    const session = await ensureFinalsSession(tx, principal, approved);
    const copiedAllocations = new Map<string, { id: string; unitId: string }>();
    for (const oldAllocation of previous?.allocations ?? []) {
      const before = oldSlots.find((slot) => slot.slotKey === oldAllocation.slotKey); const after = nextSlots.find((slot) => slot.slotKey === oldAllocation.slotKey);
      if (!before || !after || before.constraintHash !== after.constraintHash) continue;
      const allocated = await tx.dispatchAllocation.create({ data: { snapshotId: snapshot.id, slotKey: after.slotKey, unitId: oldAllocation.unitId, matchEvidence: asJson({ carriedFromAllocationId: oldAllocation.id, priorEvidence: oldAllocation.matchEvidence, unchangedConstraintHash: after.constraintHash, physicalCompletion: false }), createdByUserId: principal.userId } });
      await tx.dispatchReservation.create({ data: { unitId: allocated.unitId, allocationId: allocated.id, snapshotId: snapshot.id, boardId: snapshot.boardId } });
      copiedAllocations.set(after.slotKey, allocated);
    }
    const oldSession = previous?.finalsSession;
    const changed = new Set<string>();
    for (const slot of [...oldSlots, ...nextSlots]) { const before = oldSlots.find((item) => item.slotKey === slot.slotKey); const after = nextSlots.find((item) => item.slotKey === slot.slotKey); if (!before || !after || before.constraintHash !== after.constraintHash) changed.add(slot.slotKey); }
    if (oldSession) {
      const credits = await tx.dispatchFinalsCredit.findMany({ where: { sessionId: oldSession.id, status: "confirmed" } });
      for (const credit of credits) { const allocation = copiedAllocations.get(credit.slotKey); if (!allocation || allocation.unitId !== credit.unitId || !await creditStillSupported(tx, credit, oldSlots.map((slot) => slot.lane))) { changed.add(credit.slotKey); continue; } await tx.dispatchFinalsCredit.create({ data: { sessionId: session.id, slotKey: credit.slotKey, allocationId: allocation.id, unitId: credit.unitId, lane: credit.lane, confirmedAt: credit.confirmedAt, scanId: credit.scanId, physicalObservationId: credit.physicalObservationId, carriedFromCreditId: credit.id } }); }
      const carried: Record<string, Prisma.JsonValue> = {};
      for (const lane of [...new Set(nextSlots.map((slot) => slot.lane))]) {
        if ([...oldSlots, ...nextSlots].some((slot) => slot.lane === lane && changed.has(slot.slotKey))) continue;
        const priorScope = { boardId: snapshot.boardId, snapshot: { version: { lte: previous!.version } } };
        if (await tx.dispatchAmendment.count({ where: { session: priorScope, lane, resolvedAt: null } }) || await tx.dispatchFinalsScan.count({ where: { session: priorScope, actualLane: lane, reviewStatus: "open" } })) continue;
        const signature = await tx.dispatchLaneSignoff.findFirst({ where: { sessionId: oldSession.id, lane }, orderBy: { version: "desc" } });
        const priorCarry = objectJson(oldSession.carriedSignoffs)[lane];
        const currentCredits = await tx.dispatchFinalsCredit.count({ where: { sessionId: session.id, lane, status: "confirmed" } });
        if (currentCredits !== nextSlots.filter((slot) => slot.lane === lane).length) continue;
        if (signature) carried[lane] = { signoffId: signature.id, sourceSnapshotId: previous!.id, signedAt: signature.signedAt.toISOString(), signedByUserId: signature.signedByUserId, carriedAt: new Date().toISOString(), meaning: "Prior compatible signature retained by reference; this is not a new human signature." };
        else if (priorCarry) carried[lane] = priorCarry;
      }
      await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { carriedSignoffs: asJson(carried) } });
    }
    for (const lane of previous ? [...new Set([...oldSlots, ...nextSlots].filter((slot) => changed.has(slot.slotKey)).map((slot) => slot.lane))] : []) {
      const signature = oldSession ? await tx.dispatchLaneSignoff.findFirst({ where: { sessionId: oldSession.id, lane }, orderBy: { version: "desc" }, select: { id: true } }) : null;
      await amendLane(tx, principal, session.id, lane, "Dispatch requirements changed; recheck only affected lines/lanes.", [...changed].filter((key) => [...oldSlots, ...nextSlots].some((slot) => slot.slotKey === key && slot.lane === lane)), signature?.id, true);
    }
    await dispatchEvent(tx, principal, { boardId: snapshot.boardId, snapshotId: snapshot.id, sessionId: session.id, action: "snapshot_approved", note: input.evidence, payload: { previousHeadId: input.expectedHeadId, copiedAllocations: copiedAllocations.size, changedSlotKeys: [...changed], sourceKind: snapshot.sourceKind } });
    return { snapshotId: snapshot.id, version: snapshot.version, finalsSessionId: session.id, copiedAllocations: copiedAllocations.size, changedSlotKeys: [...changed], sourceNotice: dispatchSourceNotice };
  });
}

export const generateDispatchPickWaveInputSchema = z.object({ operationId: dispatchOperation, snapshotId: dispatchId, expectedHeadId: dispatchId }).strict();
export async function generateDispatchPickWave(principal: Principal, raw: unknown) {
  const input = generateDispatchPickWaveInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "generate_pick_wave", input, "dispatch.allocate", async (tx) => {
    const snapshot = await currentSnapshot(tx, input.snapshotId, input.expectedHeadId); const slots = slotsOf(snapshot.slots);
    const allocations = await tx.dispatchAllocation.findMany({ where: { snapshotId: snapshot.id, releasedAt: null }, include: { waveItem: true, unit: { include: { identifiers: { where: { revokedAt: null }, orderBy: { id: "asc" } }, inventoryRows: { orderBy: { lpn: "asc" } } } } }, orderBy: { slotKey: "asc" } });
    const pending = allocations.filter((allocation) => !allocation.waveItem);
    const existingWaveIds = [...new Set(allocations.flatMap((allocation) => allocation.waveItem ? [allocation.waveItem.pickWaveId] : []))];
    if (!pending.length) return { created: false, waveIds: existingWaveIds, allocated: allocations.length, missingSlots: slots.length - allocations.length, sourceNotice: dispatchSourceNotice };
    const wave = await tx.pickWave.create({ data: { name: `Dispatch ${snapshot.board.day} ${snapshot.board.scope} v${snapshot.version}`.slice(0, 120), sourceFilename: `manual-dispatch-${snapshot.board.day}-v${snapshot.version}`, createdByUserId: principal.userId } });
    const mappings = new Map<string, string>();
    for (let index = 0; index < pending.length; index++) {
      const allocation = pending[index]; const slot = slots.find((item) => item.slotKey === allocation.slotKey)!;
      const lpn = allocation.unit.identifiers.find((alias) => alias.kind === "lpn")?.value ?? null;
      const serial = allocation.unit.identifiers.find((alias) => alias.kind === "serial")?.value ?? null;
      const item = await tx.pickWaveItem.create({ data: { pickWaveId: wave.id, rowNumber: index + 2, routeNumber: slot.route, orderNumber: slot.orderReference || null, lpn, serialNumber: serial, partNumber: slot.partNumber || null, description: slot.description || allocation.unit.inventoryRows[0]?.description || null } });
      await tx.dispatchWaveItem.create({ data: { allocationId: allocation.id, pickWaveId: wave.id, pickWaveItemId: item.id, unitId: allocation.unitId, snapshotId: snapshot.id } });
      mappings.set(slot.route, slot.lane);
    }
    await tx.pickWaveRouteMapping.createMany({ data: [...mappings].map(([routeNumber, stagingLocation]) => ({ pickWaveId: wave.id, routeNumber, stagingLocation })) });
    await dispatchEvent(tx, principal, { boardId: snapshot.boardId, snapshotId: snapshot.id, action: "pick_wave_generated", note: "Generated native Pick Wave rows from exact accepted allocations; unmatched slots stay queued.", payload: { pickWaveId: wave.id, itemCount: pending.length } });
    return { created: true, waveIds: [...existingWaveIds, wave.id], allocated: allocations.length, missingSlots: slots.length - allocations.length, sourceNotice: dispatchSourceNotice };
  });
}

export async function resolveDispatchPickItemInTransaction(tx: Prisma.TransactionClient, input: { pickWaveId: string; rawIdentifier: string }) {
  const bound = await tx.dispatchWaveItem.findFirst({ where: { pickWaveId: input.pickWaveId }, select: { id: true, snapshotId: true } });
  if (!bound) return { boundWave: false, itemId: null, unitId: null, ambiguous: false, reason: "Legacy workbook wave." };
  await tx.$executeRaw`SELECT b.id FROM "DispatchBoard" b INNER JOIN "DispatchSnapshot" s ON s."boardId"=b.id WHERE s.id=${bound.snapshotId} FOR UPDATE OF b`;
  const identity = await resolveWarehouseIdentifierInTransaction(tx, { value: input.rawIdentifier, kind: "auto" });
  if (identity.resolution !== "resolved" || !identity.unitId) return { boundWave: true, itemId: null, unitId: null, ambiguous: identity.resolution === "ambiguous", reason: "Scan a unique linked unit identifier; order/part context does not identify this physical allocation." };
  const binding = await tx.dispatchWaveItem.findFirst({ where: { pickWaveId: input.pickWaveId, unitId: identity.unitId, allocation: { releasedAt: null } }, include: { allocation: { include: { snapshot: { include: { board: true } } } } } });
  if (!binding || binding.allocation.snapshot.board.headSnapshotId !== binding.snapshotId) return { boundWave: true, itemId: null, unitId: identity.unitId, ambiguous: false, reason: "This unit is not allocated to this current Pick Wave version." };
  return { boundWave: true, itemId: binding.pickWaveItemId, unitId: identity.unitId, ambiguous: false, reason: "Exact physical-unit allocation binding." };
}

export const createFinalsSessionInputSchema = z.object({ operationId: dispatchOperation, snapshotId: dispatchId, expectedHeadId: dispatchId }).strict();
export async function createFinalsSession(principal: Principal, raw: unknown) {
  const input = createFinalsSessionInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "create_finals_session", input, "workflow.execute", async (tx) => {
    const snapshot = await currentSnapshot(tx, input.snapshotId, input.expectedHeadId); const session = await ensureFinalsSession(tx, principal, snapshot);
    return { sessionId: session.id, snapshotId: snapshot.id, day: snapshot.board.day, scope: snapshot.board.scope, sourceAsOf: snapshot.sourceAsOf.toISOString(), sourceNotice: dispatchSourceNotice };
  });
}

async function lockedFinalsSession(tx: Prisma.TransactionClient, sessionId: string) {
  const initial = await tx.dispatchFinalsSession.findUnique({ where: { id: sessionId }, select: { boardId: true } });
  if (!initial) throw new DispatchError("Lane verification session not found.", 404);
  await tx.$executeRaw`SELECT id FROM "DispatchBoard" WHERE id=${initial.boardId} FOR UPDATE`;
  return tx.dispatchFinalsSession.findUniqueOrThrow({ where: { id: sessionId }, include: { snapshot: true, board: true } });
}

export const recordFinalsScanInputSchema = z.object({ sessionId: dispatchId, eventId: z.string().min(1).max(100), lane: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()), rawIdentifier: z.string().min(1).max(500), confirmPlacement: z.boolean(), capturedAt: dispatchStamp, capturedByUserId: dispatchId.optional(), captureMethod: z.enum(["scanner", "manual", "ocr"]).default("manual"), deviceId: z.string().max(200).optional(), identifierType: z.enum(["auto", "lpn", "msn", "serial", "submission"]).default("auto"), namespace: z.string().max(100).optional() }).strict();
export async function recordFinalsScan(principal: Principal, raw: unknown) {
  const input = recordFinalsScanInputSchema.parse(raw);
  const receipt = await dispatchCommand(principal, `finals:${dispatchHash([input.sessionId, input.eventId])}`, "finals_scan", input, "workflow.execute", async (tx) => {
    const session = await lockedFinalsSession(tx, input.sessionId); const slots = slotsOf(session.snapshot.slots);
    const physical = await recordWorkflowObservation(tx, principal, { eventId: `finals:${dispatchHash([input.sessionId, input.eventId])}`, rawIdentifier: input.rawIdentifier, identifierType: input.identifierType, namespace: input.namespace, type: input.confirmPlacement ? "placement" : "presence", location: input.lane, capturedAt: input.capturedAt, capturedByUserId: input.capturedByUserId, captureMethod: input.captureMethod, deviceId: input.deviceId });
    const office = await reviewWorkflowOfficeObservation(tx, principal, { observationId: physical.observation.observationId });
    const current = session.board.headSnapshotId === session.snapshotId;
    const identity = await resolveWarehouseIdentifierInTransaction(tx, { value: input.rawIdentifier, kind: input.identifierType, namespace: input.namespace });
    let unitId = physical.unitId;
    let outcome = "unidentified"; let expectedLane: string | null = null; let message = "Unidentified barcode — preserve this scan and resolve its unit identity.";
    let allocation: Awaited<ReturnType<typeof tx.dispatchAllocation.findFirst>> = null;
    if (!current) { outcome = "stale_snapshot"; message = "Demand changed. Physical evidence was retained; open the current verification version before fulfilling requirements."; }
    else if (identity.resolution === "ambiguous" || (unitId && identity.unitId !== unitId)) { outcome = "ambiguous"; message = "Ambiguous or changed identity — scan another linked unit identifier."; unitId = null; }
    else if (unitId && physical.resolution === "resolved") {
      allocation = await tx.dispatchAllocation.findFirst({ where: { snapshotId: session.snapshotId, unitId, releasedAt: null } });
      const slot = allocation ? slots.find((item) => item.slotKey === allocation!.slotKey) : null;
      expectedLane = slot?.lane ?? null;
      if (!allocation || !slot) {
        const aliases = await tx.warehouseIdentifier.findMany({ where: { unitId, revokedAt: null } });
        const potential = slots.filter((item) => (!item.expectedUnit.unitId || item.expectedUnit.unitId === unitId) && (item.expectedUnit.unitId || item.expectedUnit.identifiers.length) && item.expectedUnit.identifiers.every((reference) => aliases.some((alias) => alias.kind === reference.kind && alias.value === reference.value && (!reference.namespace || alias.namespace === reference.namespace))));
        if (potential.length === 1) { expectedLane = potential[0].lane; outcome = input.lane !== expectedLane ? "wrong_lane" : "allocation_required"; message = input.lane !== expectedLane ? `WRONG LANE / MOVE TO LANE ${expectedLane}. Office allocation and destination confirmation are still required.` : "Known requirement candidate; office must allocate this exact unit before lane fulfillment."; }
        else if (potential.length > 1) { outcome = "ambiguous_requirement"; message = "This unit could match multiple quantity slots. Office must resolve the exact allocation."; }
        else {
          const elsewhere = await tx.dispatchReservation.findUnique({ where: { unitId }, include: { allocation: { include: { snapshot: { include: { board: true } } } } } });
          const otherSlot = elsewhere ? slotsOf(elsewhere.allocation.snapshot.slots).find((item) => item.slotKey === elsewhere.allocation.slotKey) : null;
          outcome = elsewhere ? "other_dispatch" : "unexpected"; expectedLane = otherSlot?.lane ?? null;
          message = elsewhere ? `Reserved for ${elsewhere.allocation.snapshot.board.day} / ${elsewhere.allocation.snapshot.board.scope}${expectedLane ? ` / lane ${expectedLane}` : ""}. Review that dispatch context before moving.` : "Unexpected known warehouse unit — not allocated to this dispatch version.";
        }
      } else if (slot.lane !== input.lane) { outcome = "wrong_lane"; message = `WRONG LANE / MOVE TO LANE ${slot.lane}. Confirm the actual destination with a new scan; this scan does not fulfill it.`; }
      else if (!input.confirmPlacement) { outcome = "placement_confirmation_required"; message = "Unit identified. Confirm it is physically in the selected lane before fulfilling the requirement."; }
      else {
        const credit = await tx.dispatchFinalsCredit.findFirst({ where: { sessionId: session.id, unitId, status: "confirmed" } });
        const supported = await creditStillSupported(tx, { unitId, lane: input.lane, confirmedAt: new Date(input.capturedAt), physicalObservationId: physical.observation.observationId }, slots.map((item) => item.lane));
        outcome = !supported ? "stale_physical_confirmation" : credit && credit.slotKey === slot.slotKey && await creditStillSupported(tx, credit, slots.map((item) => item.lane)) ? "duplicate" : "confirmed";
        message = outcome === "stale_physical_confirmation" ? "Later physical evidence conflicts with this delayed confirmation. Recheck the actual lane now." : outcome === "duplicate" ? "Duplicate confirmation retained; quantity was not counted again." : `Confirmed in lane ${slot.lane}.`;
      }
    }
    else if (!slots.some((slot) => slot.lane === input.lane) && !await tx.dispatchAmendment.count({ where: { sessionId: session.id, lane: input.lane } })) { outcome = "unknown_lane"; message = "This lane is not defined for the selected dispatch version. Actual observed location and unidentified scan were retained."; }
    const dispatchOutcome = outcome;
    const handling = office.blockingDispatch.filter((instruction) => instruction.unitId === unitId);
    if (unitId && identity.resolution === "resolved" && handling.length) {
      outcome = "office_conflict";
      message = `OFFICE / ${handling.some((item) => item.authorityState === "authorized_rtv") ? "AUTHORIZED RTV" : "HANDLING REVIEW"}: ${handling.map((item) => `${item.instruction}${item.targetLocation ? ` (instruction: ${item.targetLocation}; placement is not confirmed)` : ""}${item.authorityState === "rtv_review_required" ? ` Review: ${item.reason}` : ""}`).join(" ")} Delivery lane fulfillment is blocked; no MARS submission or print was sent.`;
    }
    const resolved = ["confirmed", "duplicate", "placement_confirmation_required", "stale_snapshot"].includes(outcome);
    const scan = await tx.dispatchFinalsScan.create({ data: { sessionId: session.id, userId: principal.userId, eventId: input.eventId, fingerprint: dispatchHash(input), rawIdentifier: input.rawIdentifier, actualLane: input.lane, expectedLane, unitId, physicalObservationId: physical.observation.observationId, resolution: identity.resolution, candidateUnitIds: identity.candidateUnitIds, outcome, capturedAt: new Date(input.capturedAt), reviewStatus: resolved ? "resolved" : "open" } });
    let changed = !resolved;
    if (unitId) {
      const credits = await tx.dispatchFinalsCredit.findMany({ where: { sessionId: session.id, unitId, status: "confirmed" } });
      for (const credit of credits) if ((credit.lane !== input.lane && new Date(input.capturedAt) >= credit.confirmedAt) || outcome === "confirmed" || outcome === "office_conflict") {
        await tx.dispatchFinalsCredit.update({ where: { id: credit.id }, data: { status: "invalidated", invalidatedByScanId: scan.id, invalidatedAt: new Date() } });
        await amendLane(tx, principal, session.id, credit.lane, outcome === "office_conflict" ? "Current exact-unit office handling conflicts with delivery; fresh review and lane confirmation are required." : "Later physical location/confirmation changed; targeted lane recheck required.", [credit.slotKey]); changed = true;
      }
    }
    if (outcome === "confirmed" && allocation && unitId) {
      await tx.dispatchFinalsCredit.create({ data: { sessionId: session.id, slotKey: allocation.slotKey, allocationId: allocation.id, unitId, lane: input.lane, confirmedAt: new Date(input.capturedAt), scanId: scan.id, physicalObservationId: physical.observation.observationId } });
      changed = true;
    }
    if (["confirmed", "duplicate"].includes(outcome) && unitId) {
      const redirects = await tx.dispatchFinalsScan.findMany({ where: { session: { boardId: session.boardId, snapshot: { version: { lte: session.snapshot.version } } }, unitId, reviewStatus: "open", outcome: "wrong_lane", capturedAt: { lte: new Date(input.capturedAt) } }, select: { id: true, actualLane: true } });
      await tx.dispatchFinalsScan.updateMany({ where: { id: { in: redirects.map((item) => item.id) } }, data: { reviewStatus: "resolved", reviewedAt: new Date(), reviewedByUserId: principal.userId, reviewReason: `New destination scan confirms the exact unit in current demand v${session.snapshot.version}, lane ${input.lane}. Prior observed/expected lanes remain original evidence.`, resolvedByScanId: scan.id } });
      if (redirects.length) changed = true;
    }
    if (!resolved) await amendLane(tx, principal, session.id, input.lane, "A later exception requires review before this lane remains signed off.", allocation ? [allocation.slotKey] : []);
    if (changed) await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { revision: { increment: 1 } } });
    await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "finals_scan", note: message, payload: { scanId: scan.id, outcome, dispatchOutcome, observedLane: input.lane, expectedLane, physicalObservationId: physical.observation.observationId, office } });
    const revision = (await tx.dispatchFinalsSession.findUniqueOrThrow({ where: { id: session.id }, select: { revision: true } })).revision;
    return { observation: physical.observation, scan: dispatchPlain(scan), outcome, dispatchOutcome, office, expectedLane, actionMessage: message, sessionRevision: revision, fulfilled: outcome === "confirmed" || outcome === "duplicate", sourceNotice: dispatchSourceNotice };
  });
  // The current scan/rules/task receipt above is atomic. Other current dispatch
  // scopes recheck this same immutable observation separately, with ordered
  // board locks; retrying this local follow-up never repeats an external effect.
  let dispatchReview: { affectedSessionIds: string[] } | { pendingReview: true };
  try { dispatchReview = await reviewDispatchObservation(principal, { observationId: receipt.observation.observationId }); }
  catch { dispatchReview = { pendingReview: true }; }
  return { ...receipt, dispatchReview };
}

export const reviewFinalsExceptionInputSchema = z.object({ operationId: dispatchOperation, scanId: dispatchId, sessionId: dispatchId.describe("Current verification session; supply it to review a capture retained from an earlier demand version.").optional(), expectedSessionRevision: z.number().int().positive(), reason: dispatchReason }).strict();
export async function reviewFinalsException(principal: Principal, raw: unknown) {
  const input = reviewFinalsExceptionInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "review_finals_exception", input, "dispatch.signoff", async (tx) => {
    const scan = await tx.dispatchFinalsScan.findUnique({ where: { id: input.scanId } });
    if (!scan) throw new DispatchError("Scan not found.", 404);
    const session = await lockedFinalsSession(tx, input.sessionId ?? scan.sessionId);
    const origin = await tx.dispatchFinalsSession.findUniqueOrThrow({ where: { id: scan.sessionId }, select: { boardId: true, snapshotId: true, snapshot: { select: { version: true } } } });
    if (origin.boardId !== session.boardId || origin.snapshot.version > session.snapshot.version) throw new DispatchError("Review this capture in the current verification session for its own dispatch day/scope.", 409);
    if (session.board.headSnapshotId !== session.snapshotId || session.revision !== input.expectedSessionRevision) throw new DispatchError("Verification changed. Reload before reviewing the exception.", 409);
    if (["wrong_lane", "ambiguous", "unidentified", "ambiguous_requirement", "allocation_required", "unknown_lane", "office_conflict"].includes(scan.outcome)) {
      const correction = await tx.warehouseObservationCorrection.findFirst({ where: { observationId: scan.physicalObservationId }, orderBy: { revision: "desc" } });
      const originalObservation = await tx.warehousePhysicalObservation.findUniqueOrThrow({ where: { id: scan.physicalObservationId }, select: { unitId: true } });
      const identity = await resolveWarehouseIdentifierInTransaction(tx, { value: scan.rawIdentifier, kind: "auto" });
      // Revoking/reassigning an alias does not rewrite which appliance this
      // original observation identified. Only an explicit observation correction
      // changes that association; fresh lookup can resolve formerly unknown scans.
      const unitId = correction ? correction.unitId : originalObservation.unitId ?? (identity.resolution === "resolved" ? identity.unitId : null);
      if (unitId && scan.sessionId !== session.id && scan.outcome === "wrong_lane") {
        const oldAllocation = await tx.dispatchAllocation.findFirst({ where: { snapshotId: origin.snapshotId, unitId }, orderBy: { createdAt: "desc" } });
        const currentSlots = slotsOf(session.snapshot.slots);
        const currentAllocations = await tx.dispatchAllocation.findMany({ where: { snapshotId: session.snapshotId, releasedAt: null }, select: { slotKey: true, unitId: true } });
        const aliases = await tx.warehouseIdentifier.findMany({ where: { unitId, revokedAt: null }, select: { kind: true, namespace: true, value: true } });
        const mayStillBeRequired = currentSlots.some((slot) => {
          const allocated = currentAllocations.find((item) => item.slotKey === slot.slotKey);
          if (allocated) return allocated.unitId === unitId;
          if (slot.expectedUnit.unitId) return slot.expectedUnit.unitId === unitId;
          if (!slot.expectedUnit.identifiers.length) return true;
          return slot.expectedUnit.identifiers.every((reference) => aliases.some((alias) => alias.kind === reference.kind && alias.value === reference.value && (!reference.namespace || alias.namespace === reference.namespace)));
        });
        if (oldAllocation && !currentSlots.some((slot) => slot.slotKey === oldAllocation.slotKey) && !mayStillBeRequired) {
          const observations = await tx.$queryRaw<{ id: string; type: string; location: string | null; capturedAt: Date }[]>`WITH effective AS (SELECT o.id,o.type,o.location,o."capturedAt" FROM "WarehousePhysicalObservation" o LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${unitId}) SELECT * FROM effective WHERE "capturedAt"=(SELECT MAX("capturedAt") FROM effective) ORDER BY id DESC`;
          const latest = observations[0];
          const conflict = latest && observations.some((observation) => observation.type !== latest.type || observation.location !== latest.location);
          if (latest && !conflict && latest.capturedAt > scan.capturedAt && (latest.type === "departure" || (latest.type === "placement" && latest.location && latest.location.toUpperCase() !== scan.actualLane.toUpperCase()))) {
            const updated = await tx.dispatchFinalsScan.update({ where: { id: scan.id }, data: { reviewStatus: "resolved", reviewedByUserId: principal.userId, reviewedAt: new Date(), reviewReason: `${input.reason} Current demand removed this unit requirement; later exact-unit ${latest.type} evidence resolves the prior lane issue without fulfilling any delivery quantity.` } });
            await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { revision: { increment: 1 } } });
            await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "exception_resolved_after_requirement_removed", note: input.reason, payload: { scanId: scan.id, originSessionId: scan.sessionId, originSnapshotVersion: origin.snapshot.version, removedSlotKey: oldAllocation.slotKey, unitId, resolutionObservationId: latest.id, type: latest.type, location: latest.location, capturedAt: latest.capturedAt.toISOString(), fulfillmentAdded: false } });
            return { scan: dispatchPlain(updated), fulfillmentAdded: false, resolutionObservation: { observationId: latest.id, type: latest.type, location: latest.location, capturedAt: latest.capturedAt.toISOString() } };
          }
        }
      }
      const credit = unitId ? await tx.dispatchFinalsCredit.findFirst({ where: { sessionId: session.id, unitId, status: "confirmed" } }) : null;
      const proof = credit ? await tx.dispatchFinalsScan.findFirst({ where: { sessionId: session.id, unitId, actualLane: credit.lane, outcome: { in: ["confirmed", "duplicate"] }, capturedAt: { gte: scan.capturedAt } }, orderBy: { capturedAt: "desc" } }) : null;
      if (!credit || !proof || !await creditStillSupported(tx, credit, slotsOf(session.snapshot.slots).map((slot) => slot.lane))) throw new DispatchError("Resolve identity/allocation and obtain a new exact destination confirmation first. A review note cannot manufacture fulfillment.", 409);
      if ((await currentOfficeDispatchRestrictions(tx, credit.unitId)).length) throw new DispatchError("Resolve current exact-unit office handling before resolving this exception.", 409);
      const updated = await tx.dispatchFinalsScan.update({ where: { id: scan.id }, data: { reviewStatus: "resolved", reviewedByUserId: principal.userId, reviewedAt: new Date(), reviewReason: input.reason, resolvedByScanId: proof.id } });
      await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { revision: { increment: 1 } } });
      await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "exception_resolved_by_physical_proof", note: input.reason, payload: { scanId: scan.id, originSessionId: scan.sessionId, originSnapshotVersion: origin.snapshot.version, destinationScanId: proof.id, unitId } });
      return { scan: dispatchPlain(updated), fulfillmentAdded: false };
    }
    const updated = await tx.dispatchFinalsScan.update({ where: { id: scan.id }, data: { reviewStatus: "accepted", reviewedByUserId: principal.userId, reviewedAt: new Date(), reviewReason: input.reason } });
    await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { revision: { increment: 1 } } });
    await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "exception_accepted", note: input.reason, payload: { scanId: scan.id, originSessionId: scan.sessionId, originSnapshotVersion: origin.snapshot.version, outcome: scan.outcome } });
    return { scan: dispatchPlain(updated), fulfillmentAdded: false };
  }, true);
}

export const confirmDispatchLaneEmptyInputSchema = z.object({ operationId: dispatchOperation, sessionId: dispatchId, expectedHeadId: dispatchId, lane: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()), evidence: dispatchReason }).strict();
export async function confirmDispatchLaneEmpty(principal: Principal, raw: unknown) {
  const input = confirmDispatchLaneEmptyInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "lane_empty", input, "workflow.execute", async (tx) => {
    const session = await lockedFinalsSession(tx, input.sessionId);
    if (session.board.headSnapshotId !== input.expectedHeadId || session.snapshotId !== input.expectedHeadId) throw new DispatchError("Demand changed. Refresh before confirming the lane.", 409);
    if (slotsOf(session.snapshot.slots).some((slot) => slot.lane === input.lane)) throw new DispatchError("This lane has required units; scan/confirm them instead of declaring it empty.");
    const inheritedScope = { boardId: session.boardId, snapshot: { version: { lte: session.snapshot.version } } };
    if (!await tx.dispatchAmendment.count({ where: { session: inheritedScope, lane: input.lane } }) && !await tx.dispatchFinalsScan.count({ where: { session: inheritedScope, actualLane: input.lane, reviewStatus: { in: ["open", "accepted"] } } })) throw new DispatchError("This lane is outside this dispatch verification scope.");
    const clearance = { userId: principal.userId, confirmedAt: new Date().toISOString(), evidence: input.evidence, meaning: "Human-confirmed empty lane; no unit departure/destination is inferred." };
    await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { laneClearances: asJson({ ...objectJson(session.laneClearances), [input.lane]: clearance }), revision: { increment: 1 } } });
    await tx.dispatchFinalsScan.updateMany({ where: { session: inheritedScope, actualLane: input.lane, reviewStatus: "open" }, data: { reviewStatus: "resolved", reviewedAt: new Date(), reviewedByUserId: principal.userId, reviewReason: `Lane explicitly inspected empty in current demand v${session.snapshot.version}: ${input.evidence}` } });
    await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "lane_empty_confirmed", note: input.evidence, payload: { lane: input.lane, clearance } });
    return { lane: input.lane, clearance, destinationRequirementsFulfilled: false };
  });
}

async function finalsView(tx: Prisma.TransactionClient, sessionId: string) {
  const session = await tx.dispatchFinalsSession.findUnique({ where: { id: sessionId }, include: { board: true, snapshot: { include: { allocations: { where: { releasedAt: null } } } }, credits: { where: { status: "confirmed" } }, signoffs: { orderBy: [{ lane: "asc" }, { version: "desc" }] }, amendments: { orderBy: { createdAt: "desc" } } } });
  if (!session) throw new DispatchError("Lane verification session not found.", 404);
  const slots = slotsOf(session.snapshot.slots);
  const inheritedScope = { boardId: session.boardId, snapshot: { version: { lte: session.snapshot.version } } };
  const exceptions = (await tx.dispatchFinalsScan.findMany({ where: { session: inheritedScope, reviewStatus: { in: ["open", "accepted"] } }, include: { session: { select: { snapshot: { select: { version: true } } } } }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }] })).map(({ session: origin, ...scan }) => ({ ...scan, originSessionId: scan.sessionId, originSnapshotVersion: origin.snapshot.version, carriedFromPriorVersion: scan.sessionId !== sessionId }));
  const inheritedAmendments = await tx.dispatchAmendment.findMany({ where: { session: inheritedScope, resolvedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const lanes = [...new Set([...slots.map((slot) => slot.lane), ...session.amendments.map((item) => item.lane), ...inheritedAmendments.map((item) => item.lane), ...exceptions.map((item) => item.actualLane), ...Object.keys(objectJson(session.laneClearances)), ...session.signoffs.map((item) => item.lane)])].sort();
  const credits: (typeof session.credits[number] & { physicallySupported: boolean })[] = [];
  for (const credit of session.credits) credits.push({ ...credit, physicallySupported: await creditStillSupported(tx, credit, lanes) });
  const officeConflicts = (await tx.officeDisposition.findMany({ where: { unitId: { in: session.snapshot.allocations.map((item) => item.unitId) }, status: { in: ["active", "triggered", "executed"] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], kind: { in: ["hold", "customer_property", "rtv", "conditional_rtv"] } }, select: { id: true, unitId: true, kind: true, status: true, instruction: true } })).filter((item) => item.kind !== "conditional_rtv" || ["triggered", "executed"].includes(item.status));
  const carried = objectJson(session.carriedSignoffs); const clearances = objectJson(session.laneClearances);
  return {
    sessionId: session.id, boardId: session.boardId, snapshotId: session.snapshotId, revision: session.revision,
    day: session.board.day, scope: session.board.scope, isCurrentHead: session.board.headSnapshotId === session.snapshotId,
    sourceKind: session.snapshot.sourceKind, sourceAsOf: session.snapshot.sourceAsOf.toISOString(), sourceRef: session.snapshot.sourceRef, snapshotVersion: session.snapshot.version,
    lanes: lanes.map((lane) => {
      const required = slots.filter((slot) => slot.lane === lane).map((slot) => {
        const allocation = session.snapshot.allocations.find((item) => item.slotKey === slot.slotKey);
        const credit = credits.find((item) => item.slotKey === slot.slotKey && item.physicallySupported && item.unitId === allocation?.unitId);
        const officeBlocked = officeConflicts.some((item) => item.unitId === allocation?.unitId);
        return { ...slot, allocation: allocation ? dispatchPlain(allocation) : null, confirmation: credit && !officeBlocked ? dispatchPlain(credit) : null, physicalConfirmation: credit ? dispatchPlain(credit) : null, officeBlocked };
      });
      const openExceptions = exceptions.filter((item) => item.actualLane === lane && item.reviewStatus === "open");
      const unresolvedAmendments = inheritedAmendments.filter((item) => item.lane === lane);
      const latestSignoff = session.signoffs.find((item) => item.lane === lane) ?? null;
      const conflicts = officeConflicts.filter((item) => required.some((slot) => slot.allocation?.unitId === item.unitId));
      const complete = required.every((slot) => slot.confirmation) && (required.length > 0 || Boolean(clearances[lane]));
      return { lane, required, requiredCount: required.length, confirmedCount: required.filter((slot) => slot.confirmation).length, complete, officeConflicts: conflicts, openExceptions: dispatchPlain(openExceptions), acceptedExceptions: dispatchPlain(exceptions.filter((item) => item.actualLane === lane && item.reviewStatus === "accepted")), amendments: dispatchPlain(unresolvedAmendments), latestSignoff: dispatchPlain(latestSignoff), carriedSignoff: carried[lane] ?? null, emptyClearance: clearances[lane] ?? null, needsRecheck: !complete || conflicts.length > 0 || openExceptions.length > 0 || unresolvedAmendments.length > 0 || (!latestSignoff && !carried[lane]), invalidatedPhysicalProofs: credits.filter((item) => item.lane === lane && !item.physicallySupported).map((item) => item.id) };
    }),
    signoffs: dispatchPlain(session.signoffs), amendments: dispatchPlain([...new Map([...session.amendments, ...inheritedAmendments].map((item) => [item.id, item])).values()]), sourceNotice: dispatchSourceNotice,
  };
}

export const getFinalsSessionInputSchema = z.object({ sessionId: dispatchId }).strict();
export async function getFinalsSession(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const { sessionId } = getFinalsSessionInputSchema.parse(raw);
  return prisma.$transaction((tx) => finalsView(tx, sessionId), { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

// Trusted dashboard read within its existing current-principal transaction.
// Reuse physical-support/signoff rules instead of counting stale credit rows.
export async function getDispatchDashboardInTransaction(tx: Prisma.TransactionClient, day: string) {
  const boards = await tx.dispatchBoard.findMany({ where: { day, headSnapshotId: { not: null } }, orderBy: { id: "desc" }, take: 6 });
  const results = [];
  for (const board of boards.slice(0, 5)) {
    const session = await tx.dispatchFinalsSession.findUnique({ where: { snapshotId: board.headSnapshotId! }, select: { id: true } });
    if (!session) { results.push({ boardId: board.id, scope: board.scope, snapshotId: board.headSnapshotId!, required: 0, confirmed: 0, signedLanes: 0, recheckLanes: 0, unavailable: true }); continue; }
    const view = await finalsView(tx, session.id);
    results.push({ boardId: board.id, scope: board.scope, snapshotId: view.snapshotId, sourceAsOf: view.sourceAsOf, required: view.lanes.reduce((sum, lane) => sum + lane.requiredCount, 0), confirmed: view.lanes.reduce((sum, lane) => sum + lane.confirmedCount, 0), signedLanes: view.lanes.filter(lane => !lane.needsRecheck && (lane.latestSignoff || lane.carriedSignoff)).length, recheckLanes: view.lanes.filter(lane => lane.needsRecheck).length, unavailable: false });
  }
  return { scopes: results, hasMore: boards.length > 5, sourceNotice: dispatchSourceNotice };
}

export const signOffDispatchLaneInputSchema = z.object({ operationId: dispatchOperation, sessionId: dispatchId, lane: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()), expectedSessionRevision: z.number().int().positive(), evidence: dispatchReason }).strict();
export async function signOffDispatchLane(principal: Principal, raw: unknown) {
  const input = signOffDispatchLaneInputSchema.parse(raw);
  return dispatchCommand(principal, input.operationId, "signoff_lane", input, "dispatch.signoff", async (tx) => {
    const session = await lockedFinalsSession(tx, input.sessionId);
    if (session.board.headSnapshotId !== session.snapshotId || session.revision !== input.expectedSessionRevision) throw new DispatchError("Demand or verification changed. Refresh before signing this lane.", 409);
    const view = await finalsView(tx, session.id); const lane = view.lanes.find((item) => item.lane === input.lane);
    if (!lane) throw new DispatchError("Lane not in this dispatch verification scope.", 404);
    const unitIds = lane.required.flatMap((slot) => slot.allocation ? [slot.allocation.unitId] : []);
    for (const unitId of [...new Set(unitIds)].sort()) if ((await currentOfficeDispatchRestrictions(tx, unitId)).length) throw new DispatchError("An active office hold/property/RTV instruction conflicts with delivery. Resolve that exact unit's instruction before sign-off.", 409);
    if (!lane.complete || lane.openExceptions.length) throw new DispatchError("This lane still has missing/current physical confirmations or unresolved exceptions.", 409);
    const previous = await tx.dispatchLaneSignoff.findFirst({ where: { sessionId: session.id, lane: input.lane }, orderBy: { version: "desc" } });
    const payload = { snapshotId: session.snapshotId, snapshotVersion: session.snapshot.version, sourceKind: session.snapshot.sourceKind, sourceAsOf: session.snapshot.sourceAsOf.toISOString(), sourceRef: session.snapshot.sourceRef, sessionRevision: session.revision, lane: input.lane, requirements: lane.required, acceptedExceptions: lane.acceptedExceptions, emptyClearance: lane.emptyClearance, evidence: input.evidence, sourceNotice: dispatchSourceNotice };
    const signature = await tx.dispatchLaneSignoff.create({ data: { sessionId: session.id, lane: input.lane, version: (previous?.version ?? 0) + 1, snapshotId: session.snapshotId, sourceAsOf: session.snapshot.sourceAsOf, payload: asJson(payload), payloadHash: dispatchHash(payload), signedByUserId: principal.userId } });
    await tx.dispatchAmendment.updateMany({ where: { session: { boardId: session.boardId, snapshot: { version: { lte: session.snapshot.version } } }, lane: input.lane, resolvedAt: null }, data: { resolvedAt: signature.signedAt, resolvedBySignoffId: signature.id } });
    const carried = objectJson(session.carriedSignoffs); delete carried[input.lane];
    await tx.dispatchFinalsSession.update({ where: { id: session.id }, data: { revision: { increment: 1 }, carriedSignoffs: asJson(carried) } });
    await dispatchEvent(tx, principal, { boardId: session.boardId, snapshotId: session.snapshotId, sessionId: session.id, action: "lane_signed", note: input.evidence, payload: { signoffId: signature.id, lane: input.lane, version: signature.version, payloadHash: signature.payloadHash } });
    return { signoff: dispatchPlain(signature), sourceNotice: dispatchSourceNotice };
  }, true);
}

export const listDispatchBoardsInputSchema = z.object({ day: dispatchDay.optional(), afterId: dispatchId.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export async function listDispatchBoards(principal: Principal, raw: unknown = {}) {
  assertCapability(principal, "workflow.read");
  const input = listDispatchBoardsInputSchema.parse(raw);
  const boards = await prisma.dispatchBoard.findMany({ where: { ...(input.day ? { day: input.day } : {}), ...(input.afterId ? { id: { gt: input.afterId } } : {}) }, include: { headSnapshot: { include: { finalsSession: { select: { id: true } } } }, _count: { select: { snapshots: true } } }, orderBy: { id: "asc" }, take: input.limit + 1 });
  return { boards: dispatchPlain(boards.slice(0, input.limit)), nextAfterId: boards.length > input.limit ? boards[input.limit - 1].id : null, sourceNotice: dispatchSourceNotice };
}

export const getDispatchBoardInputSchema = z.object({ boardId: dispatchId }).strict();
export async function getDispatchBoard(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const input = getDispatchBoardInputSchema.parse(raw);
  const board = await prisma.dispatchBoard.findUnique({ where: { id: input.boardId }, include: { snapshots: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, baseHeadId: true, coverage: true, sourceAsOf: true, sourceKind: true, sourceRef: true, note: true, createdAt: true, approvedAt: true, finalsSession: { select: { id: true } } } } } });
  if (!board) throw new DispatchError("Dispatch board not found.", 404);
  return { board: dispatchPlain(board), sourceNotice: dispatchSourceNotice };
}

export const getFinalsScanHistoryInputSchema = z.object({ sessionId: dispatchId, afterId: dispatchId.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict();
export async function getFinalsScanHistory(principal: Principal, raw: unknown) {
  assertCapability(principal, "workflow.read");
  const input = getFinalsScanHistoryInputSchema.parse(raw);
  const scans = await prisma.dispatchFinalsScan.findMany({ where: { sessionId: input.sessionId, ...(input.afterId ? { id: { gt: input.afterId } } : {}) }, orderBy: { id: "asc" }, take: input.limit + 1 });
  return { scans: dispatchPlain(scans.slice(0, input.limit)), nextAfterId: scans.length > input.limit ? scans[input.limit - 1].id : null };
}

// Derived follow-up only. It never authorizes movement, allocates stock or sends upstream requests.
export const reviewDispatchObservationInputSchema = z.object({ observationId: dispatchId }).strict();
export async function reviewDispatchObservation(principal: Principal, raw: unknown) {
  const input = reviewDispatchObservationInputSchema.parse(raw);
  const capability = principal.capabilities.includes("inventory.write") ? "inventory.write" : "workflow.execute";
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, capability);
    const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: input.observationId } });
    if (!observation || observation.userId !== principal.userId) throw new DispatchError("Use the original operator's observation receipt.", 403);
    const correction = await tx.warehouseObservationCorrection.findFirst({ where: { observationId: observation.id }, orderBy: { revision: "desc" } });
    const unitId = correction ? correction.unitId : observation.unitId;
    const credits = await tx.dispatchFinalsCredit.findMany({ where: { status: "confirmed", OR: [...(unitId ? [{ unitId }] : []), { physicalObservationId: observation.id }] }, include: { session: { include: { board: true } } } });
    const affectedSessionIds = new Set<string>();
    for (const boardId of [...new Set(credits.map((item) => item.session.boardId))].sort()) await tx.$executeRaw`SELECT id FROM "DispatchBoard" WHERE id=${boardId} FOR UPDATE`;
    for (const credit of credits) {
      const currentBoard = await tx.dispatchBoard.findUniqueOrThrow({ where: { id: credit.session.boardId }, select: { headSnapshotId: true } });
      if (currentBoard.headSnapshotId !== credit.session.snapshotId) continue;
      const snapshot = await tx.dispatchSnapshot.findUniqueOrThrow({ where: { id: credit.session.snapshotId } });
      const officeBlocked = (await currentOfficeDispatchRestrictions(tx, credit.unitId)).length > 0;
      if (!officeBlocked && await creditStillSupported(tx, credit, slotsOf(snapshot.slots).map((slot) => slot.lane))) continue;
      const changed = await tx.dispatchFinalsCredit.updateMany({ where: { id: credit.id, status: "confirmed" }, data: { status: "invalidated", invalidatedAt: new Date() } });
      if (!changed.count) continue;
      await amendLane(tx, principal, credit.sessionId, credit.lane, officeBlocked ? "Current exact-unit office handling conflicts with dispatch; recheck this lane after office resolution." : "Later independent physical evidence conflicts with lane confirmation.", [credit.slotKey]);
      affectedSessionIds.add(credit.sessionId);
    }
    for (const sessionId of affectedSessionIds) await tx.dispatchFinalsSession.update({ where: { id: sessionId }, data: { revision: { increment: 1 } } });
    return { affectedSessionIds: [...affectedSessionIds] };
  }, { timeout: 60_000 });
}
