import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { readSnapshot } from "@/lib/read-snapshot";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { dispatchDay, dispatchSlot, dispatchSourceNotice } from "@/lib/dispatch/model";
import { businessDay, deriveCustody, type PhysicalFact } from "@/lib/office/domain";
import { fingerprint, LabelError, normalizeLabelFields, renderLabelVersion } from "./model";
import { LABEL_PURPOSES, type LabelField, type LabelFields } from "./types";
import { labelIssuanceReceipt, prepareLabelIssuanceInTransaction } from "./issuance";

export const unitLabelContextInput = z.object({ unitId: z.string().min(1).max(200), dispatchDay: dispatchDay.optional(), wmsScope: z.string().trim().min(1).max(100).default("warehouse") }).strict();
type FieldEvidence = { field: LabelField; value: string; source: string; recordIds: string[]; sourceAsOf: string | null; recordedAt: string | null; qualification: string };
type ContextIssue = { code: string; detail: string; blocksAutomatic: boolean };
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function assertUnitContextScopes(principal: Principal) { assertCapability(principal, "inventory.read"); assertCapability(principal, "workflow.read"); }

// This reader is also used inside the native issuance/claim transaction. It
// derives operational fields from typed stored facts, never sourceData guesses.
export async function deriveUnitLabelContext(tx: Prisma.TransactionClient, raw: unknown, now = new Date()) {
  const input = unitLabelContextInput.parse(raw), day = input.dispatchDay ?? businessDay(now), issues: ContextIssue[] = [], evidence: FieldEvidence[] = [], fields: LabelFields = { unitId: input.unitId, identityResolved: "true", today: businessDay(now) };
  const unit = await tx.warehouseUnit.findUnique({ where: { id: input.unitId }, include: {
    identifiers: { where: { revokedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
    inventoryRows: { select: { id: true, lpn: true, status: true, vendor: true, orderNumber: true, receivedDate: true, description: true, sourceChangedAt: true, archivedAt: true } },
    officeSchedules: { orderBy: [{ sourceAsOf: "desc" }, { recordedAt: "desc" }, { id: "desc" }], take: 101 },
    officeDispositions: { include: { executions: true }, orderBy: { createdAt: "desc" } },
    officeCases: { include: { events: { orderBy: { createdAt: "desc" }, take: 50 } }, orderBy: { updatedAt: "desc" }, take: 101 },
    originalExchanges: { include: { attempts: { orderBy: { occurredAt: "asc" } }, expectations: true }, orderBy: { createdAt: "desc" } },
    replacementExchanges: { include: { attempts: { orderBy: { occurredAt: "asc" } }, expectations: true }, orderBy: { createdAt: "desc" } },
    returnExpectations: { orderBy: { createdAt: "desc" } },
  } });
  if (!unit) throw new LabelError("Physical unit not found.", 404);
  const batch = await tx.inventoryAuditImport.findFirst({ where: { scope: input.wmsScope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const observations = await tx.$queryRaw<PhysicalFact[]>`SELECT o.id,o.type,o.location,o."capturedAt",o."receivedAt" FROM "WarehousePhysicalObservation" o LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${input.unitId} ORDER BY o."capturedAt",o.id`;
  const reservation = await tx.dispatchReservation.findUnique({ where: { unitId: input.unitId }, include: { allocation: { include: { snapshot: { include: { board: true } } } } } });
  const custody = deriveCustody(observations);
  const memberships = batch ? await tx.inventoryImportMembership.findMany({ where: { importId: batch.id, sourceRevision: { inventoryItem: { unitId: input.unitId } } }, include: { sourceRevision: true } }) : [];
  const sourceRows = memberships.map(item => item.sourceRevision), reported = sourceRows.length ? sourceRows : unit.inventoryRows;
  const wmsQualification = sourceRows.length ? `Typed rows retained in the selected ${batch!.coverage} WMS report; reported state is separate from physical presence.` : "Retained typed WMS rows; membership in the latest selected report is not established. Historical/delivered rows are not current stock proof.";
  function put(field: LabelField, value: string | null | undefined, source: string, recordIds: string[], sourceAsOf: Date | null = null, recordedAt: Date | null = null, qualification = "Explicit stored fact; not proof of physical completion.") {
    if (!value?.trim()) return;
    if (value.length > 2000) { issues.push({ code: `oversized_${field}`, detail: `The stored ${field} value exceeds the label field limit. Its full source remains retained; review it before printing.`, blocksAutomatic: true }); return; }
    const normalized = normalizeLabelFields({ [field]: value })[field]!;
    fields[field] = normalized; evidence.push({ field, value: normalized, source, recordIds, sourceAsOf: iso(sourceAsOf), recordedAt: iso(recordedAt), qualification });
  }
  function consensus(field: LabelField, values: Array<{ value: string; id: string }>, source: string, sourceAsOf: Date | null = null, recordedAt: Date | null = null, qualification?: string) {
    const nonempty = values.filter(item => item.value.trim()), unique = [...new Set(nonempty.map(item => item.value.trim()))];
    if (unique.length === 1) put(field, unique[0], source, nonempty.map(item => item.id), sourceAsOf, recordedAt, qualification);
    else if (unique.length > 1) issues.push({ code: `conflicting_${field}`, detail: `Several stored ${field} values apply to this unit; no arbitrary value was selected.`, blocksAutomatic: true });
  }
  const allAliases = unit.identifiers.length ? await tx.warehouseIdentifier.findMany({ where: { revokedAt: null, value: { in: [...new Set(unit.identifiers.map(alias => alias.value))] } }, select: { unitId: true, kind: true, namespace: true, value: true } }) : [];
  const safeAliases = unit.identifiers.filter(alias => {
    const linked = allAliases.filter(other => other.value === alias.value && other.kind === alias.kind && other.namespace === alias.namespace);
    const unique = new Set(linked.map(other => other.unitId)).size === 1;
    if (!unique) issues.push({ code: "ambiguous_identifier_link", detail: `${alias.kind} ${alias.value} is linked to more than one physical unit in its namespace.`, blocksAutomatic: true });
    return unique;
  });
  const safeLpnValues = new Set(safeAliases.filter(alias => alias.kind === "lpn" && alias.namespace === "wms").map(alias => alias.value.toUpperCase()));
  const identityRows = reported.filter(row => safeLpnValues.has(row.lpn.toUpperCase()));
  if (sourceRows.some(row => !safeLpnValues.has(row.lpn.toUpperCase()))) issues.push({ code: "unusable_wms_identity", detail: "A reported LPN link is revoked, missing or ambiguous. Its retained source row cannot establish the current label identity.", blocksAutomatic: true });
  const headLpns = sourceRows.filter(row => safeLpnValues.has(row.lpn.toUpperCase())).map(row => ({ value: row.lpn, id: row.id }));
  consensus("lpn", headLpns.length ? headLpns : safeAliases.filter(alias => alias.kind === "lpn" && alias.namespace === "wms").map(alias => ({ value: alias.value, id: alias.id })), headLpns.length ? "wms_report_row" : "linked_lpn_alias", batch?.sourceAsOf ?? null, batch?.createdAt ?? null, wmsQualification);
  for (const field of ["vendor", "orderNumber", "receivedDate", "description"] as const) consensus(field, identityRows.map(row => ({ value: row[field], id: row.id })), sourceRows.length ? "wms_report_row" : "retained_wms_row", sourceRows.length ? batch?.sourceAsOf ?? null : null, sourceRows.length ? batch?.createdAt ?? null : null, wmsQualification);
  for (const [field, kind, namespace] of [["msn", "msn", "dmp"], ["serialNumber", "serial", null]] as const) consensus(field, safeAliases.filter(alias => alias.kind === kind && (namespace === null || alias.namespace === namespace)).map(alias => ({ value: alias.value, id: alias.id })), "evidenced_identifier_alias");
  const submissionAliases = safeAliases.filter(alias => alias.kind === "submission" && alias.namespace === "mars");
  const submissionValues = submissionAliases.map(alias => alias.value.toUpperCase());
  const submissions = submissionValues.length ? await tx.marsUnit.findMany({ where: { OR: submissionValues.map(value => ({ requestNumber: { equals: value, mode: "insensitive" as const } })) }, include: { marsEvents: { orderBy: { createdAt: "desc" }, take: 51 } } }) : [];
  const activeSubmissions = submissions.filter(item => item.localStatus === "active" && !item.archivedAt);
  if (activeSubmissions.length === 1) {
    const submission = activeSubmissions[0];
    put("submissionNumber", submission.requestNumber, "linked_mars_import", [submission.id], null, submission.lastImportedAt, "Uniquely linked imported MARS submission. Import time is not external source-as-of time.");
    for (const field of ["modelNumber", "vendorRaNumber"] as const) put(field, submission[field], "linked_mars_import", [submission.id], null, submission.lastImportedAt);
    if (!fields.vendor) put("vendor", submission.vendor, "linked_mars_import", [submission.id], null, submission.lastImportedAt);
    if (!fields.orderNumber) put("orderNumber", submission.orderNumber, "linked_mars_import", [submission.id], null, submission.lastImportedAt, "Reported order context from an explicitly linked submission; never a physical identity merge.");
    if (!fields.serialNumber) put("serialNumber", submission.serialNumber, "linked_mars_import", [submission.id], null, submission.lastImportedAt, "Reported serial on an explicitly linked submission. This does not create or namespace a serial lookup alias.");
    else if (submission.serialNumber && (submission.serialNumber.length > 2000 || fields.serialNumber.toUpperCase() !== normalizeLabelFields({ serialNumber: submission.serialNumber }).serialNumber?.toUpperCase())) issues.push({ code: "conflicting_mars_serial", detail: "The evidenced serial alias conflicts with the linked MARS reported serial. Review the source linkage before automatic printing.", blocksAutomatic: true });
  } else if (activeSubmissions.length > 1) issues.push({ code: "multiple_current_submissions", detail: "Several active MARS submissions are linked; choose/reconcile the current submission before issuing a new submission label.", blocksAutomatic: true });
  else if (submissionAliases.length === 1 && !submissions.length) put("submissionNumber", submissionAliases[0].value, "evidenced_submission_alias", [submissionAliases[0].id], null, submissionAliases[0].createdAt, "The submission identity is evidenced, but its current external status is not verified by an imported row.");
  const allocation = reservation?.allocation, snapshot = allocation?.snapshot;
  const acceptedAllocation = Boolean(allocation && !allocation.releasedAt && snapshot?.status === "approved" && snapshot.coverage === "complete" && snapshot.board.headSnapshotId === snapshot.id && snapshot.board.day === day && reservation?.snapshotId === snapshot.id);
  const slots = snapshot ? z.array(dispatchSlot).safeParse(snapshot.slots) : null;
  const slot = acceptedAllocation && slots?.success ? slots.data.find(item => item.slotKey === allocation!.slotKey) : null;
  if (acceptedAllocation && !slot) issues.push({ code: "allocation_slot_missing", detail: "The accepted allocation cannot be matched to its stored unit slot. Review dispatch before printing.", blocksAutomatic: true });
  const schedule = unit.officeSchedules[0] ?? null;
  const successfulExchange = unit.replacementExchanges.filter(exchange => exchange.status === "completed").flatMap(exchange => exchange.attempts.filter(attempt => attempt.outcome === "successful_exchange")).sort((a, b) => b.sourceAsOf.getTime() - a.sourceAsOf.getTime())[0];
  const scheduleCurrent = Boolean(schedule?.complete && businessDay(schedule.sourceAsOf) === businessDay(now) && (!custody.currentCheckIn || schedule.sourceAsOf >= custody.currentCheckIn.capturedAt) && (!successfulExchange || schedule.sourceAsOf > successfulExchange.sourceAsOf));
  const officeDate = schedule?.nextDeliveryDate || schedule?.deliveryDate;
  const scheduleConflict = Boolean(slot && snapshot && scheduleCurrent && schedule && officeDate && officeDate !== snapshot.board.day && schedule.sourceAsOf >= snapshot.sourceAsOf);
  if (scheduleConflict) issues.push({ code: "conflicting_schedule_and_dispatch", detail: "A current office schedule conflicts with the accepted dispatch date. Resolve the allocation before automatic staging labels.", blocksAutomatic: true });
  if (scheduleCurrent && schedule) put("deliveryDate", schedule.nextDeliveryDate || schedule.deliveryDate, schedule.source, [schedule.id], schedule.sourceAsOf, schedule.recordedAt, "Complete current manual office schedule fact; qualified live DMP schedule mapping is pending.");
  if (slot && snapshot && allocation && !scheduleConflict) {
    const qualification = dispatchSourceNotice;
    put("deliveryDate", snapshot.board.day, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, qualification);
    put("routeNumber", slot.route, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, qualification);
    put("stagingLocation", slot.lane, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, "Expected destination only; this does not confirm actual placement.");
    put("lane", slot.lane, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, "Expected lane; actual observed location remains separate.");
    put("partNumber", slot.partNumber, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, qualification);
    if (slot.orderReference) put("orderNumber", slot.orderReference, "accepted_dispatch_allocation", [allocation.id, snapshot.id], snapshot.sourceAsOf, snapshot.approvedAt, "Order is allocation context, never physical-unit identity.");
  }
  // Confirmed RTV placement completes that floor action, while its submission,
  // label and pickup instructions remain current until expiry or revocation.
  const dispositions = unit.officeDispositions.filter(item => ["active", "triggered", "executed"].includes(item.status) && !item.revokedAt && (!item.expiresAt || item.expiresAt > now));
  const dispositionPriorities: Record<string, number> = { hold: 0, customer_property: 1, rtv: 2, conditional_rtv: 3, reschedule: 4 };
  const priority = (kind: string) => dispositionPriorities[kind] ?? 5;
  dispositions.sort((a, b) => priority(a.kind) - priority(b.kind) || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  const instructions = dispositions.map(item => item.kind === "conditional_rtv" && !["triggered", "executed"].includes(item.status) ? `Conditional instruction${item.triggerAt ? " after " + item.triggerAt.toISOString() : ""}: ${item.instruction}` : item.instruction);
  const activeCases = unit.officeCases.filter(item => item.status !== "resolved");
  if (!instructions.length) for (const item of activeCases) if (item.nextAction) instructions.push(`${item.status === "watching" ? "Office watch" : "Office review"}: ${item.nextAction}`);
  const instruction = [...new Set(instructions)].join(" | ");
  if (instruction.length > 2000) issues.push({ code: "instructions_exceed_label", detail: "Current instructions are too long for a safe label. Review the full office trail rather than silently truncating them.", blocksAutomatic: true });
  else put("instructions", instruction, dispositions.length ? "office_disposition" : "office_case", dispositions.length ? dispositions.map(item => item.id) : activeCases.map(item => item.id));
  put("disposition", dispositions.length ? [...new Set(dispositions.map(item => item.kind))].join(" / ") : activeCases.length ? "office_review" : "", "office_disposition", dispositions.map(item => item.id));
  const handlingHold = dispositions.some(item => ["hold", "customer_property"].includes(item.kind));
  fields.hold = handlingHold || custody.conflict || issues.some(item => item.blocksAutomatic) ? "true" : "false";
  if (custody.conflict) issues.push({ code: "conflicting_physical_observations", detail: "Same-time physical observations disagree; the actual physical state requires review.", blocksAutomatic: true });
  const peopleIds = [...new Set([...unit.officeCases.map(item => item.responsibleUserId), ...unit.officeDispositions.flatMap(item => [item.decidedByUserId, item.authorizedByUserId])].filter((value): value is string => Boolean(value)))];
  const people = peopleIds.length ? await tx.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } }) : [];
  return plain({ unitId: unit.id, dispatchDay: day, wmsScope: input.wmsScope, fields, fieldEvidence: evidence, issues, people, relevantFingerprint: fingerprint(fields), physical: { observedAt: iso(custody.last?.capturedAt), receivedAt: iso(custody.last?.receivedAt), departedAt: iso(custody.departure?.capturedAt), lastObservationId: custody.last?.id ?? null, lastType: custody.conflict ? null : custody.last?.type ?? null, observedLocation: custody.conflict ? null : custody.last?.location ?? null, warehouseEvidence: custody.warehouseEvidence, conflicting: custody.conflict, certainty: "as_observed_not_live_presence" }, wms: { importId: batch?.id ?? null, sourceAsOf: iso(batch?.sourceAsOf), importedAt: iso(batch?.createdAt), coverage: batch?.coverage ?? null, membership: sourceRows.length ? "included" : "not_established", qualification: wmsQualification }, dispatch: { acceptedForSelectedDay: Boolean(slot), allocationId: allocation?.id ?? null, snapshotId: snapshot?.id ?? null, day: snapshot?.board.day ?? null, scope: snapshot?.board.scope ?? null, route: slot?.route ?? null, lane: slot?.lane ?? null, sourceKind: snapshot?.sourceKind ?? null, sourceAsOf: iso(snapshot?.sourceAsOf), approvedAt: iso(snapshot?.approvedAt), qualification: dispatchSourceNotice }, office: { scheduleCurrent, schedules: unit.officeSchedules.slice(0, 100), schedulesHaveMore: unit.officeSchedules.length > 100, dispositions: unit.officeDispositions, cases: unit.officeCases.slice(0, 100), casesHaveMore: unit.officeCases.length > 100, exchanges: [...unit.originalExchanges.map(item => ({ ...item, unitRole: "original" })), ...unit.replacementExchanges.map(item => ({ ...item, unitRole: "replacement" }))], returnExpectations: unit.returnExpectations.map(item => ({ ...item, qualifyingCheckIn: observations.find(observation => observation.type === "check_in" && item.activatedAt && observation.capturedAt >= item.activatedAt) ?? null })), qualification: "Manual office records; instruction, authorization, expected return and confirmed execution remain separate." }, mars: { linkedSubmissionAliases: submissionAliases.map(item => ({ id: item.id, value: item.value, linkedAt: item.createdAt })), submissions, sourceAsOf: null, qualification: "Explicit submission links plus imported MARS history; no order-only or unqualified serial merge. Imported time is not external source-as-of." } });
}

export async function getUnitLabelContext(principal: Principal, raw: unknown) {
  return readSnapshot(async tx => { const current = await assertCurrentPrincipal(tx, principal, "inventory.read"); assertUnitContextScopes(current); return deriveUnitLabelContext(tx, raw); }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}
export async function evaluateUnitLabels(principal: Principal, raw: unknown) {
  return readSnapshot(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.read"); assertUnitContextScopes(current);
    const context = await deriveUnitLabelContext(tx, raw);
    const workflows = await tx.labelWorkflow.findMany({ where: { enabled: true, publishedVersionId: { not: null } }, include: { publishedVersion: true }, orderBy: { purpose: "asc" } });
    const results = [];
    for (const workflow of workflows) {
      if (!workflow.publishedVersion) continue;
      try {
        const rendered = renderLabelVersion(workflow.publishedVersion, context.fields);
        const same = await tx.labelIssuance.findFirst({ where: { unitId: context.unitId, purpose: workflow.purpose, contentFingerprint: rendered.contentFingerprint, state: { notIn: ["not_sent", "cancelled", "verified_not_printed"] } }, orderBy: { createdAt: "desc" }, select: { id: true, state: true, createdAt: true, appliedAt: true, physicallyConfirmedAt: true } });
        const unknown = await tx.labelIssuance.findFirst({ where: { unitId: context.unitId, purpose: workflow.purpose, state: { in: ["dispatching", "unknown"] } }, select: { id: true } });
        results.push({ purpose: workflow.purpose, name: workflow.name, versionId: workflow.publishedVersion.id, version: workflow.publishedVersion.version, available: true, due: !same, contentFingerprint: rendered.contentFingerprint, zpl: rendered.zpl, decision: rendered.decision, blockedByUnknownIssuanceId: unknown?.id ?? null, lastMatchingIssuance: same, reason: null });
      } catch (error) { if (!(error instanceof LabelError)) throw error; results.push({ purpose: workflow.purpose, name: workflow.name, versionId: workflow.publishedVersion.id, version: workflow.publishedVersion.version, available: false, due: false, contentFingerprint: null, zpl: null, decision: null, blockedByUnknownIssuanceId: null, lastMatchingIssuance: null, reason: error.message }); }
    }
    const printers = await tx.labelPrinter.findMany({ where: { isActive: true }, select: { id: true, name: true, endpoint: true, contentType: true }, orderBy: { name: "asc" } });
    const issued = await tx.labelIssuance.findMany({ where: { unitId: context.unitId }, select: { id: true, purpose: true, state: true, createdAt: true, physicallyConfirmedAt: true, appliedAt: true }, orderBy: { createdAt: "desc" }, take: 100 });
    return plain({ context: { unitId: context.unitId, dispatchDay: context.dispatchDay, fields: context.fields, fieldEvidence: context.fieldEvidence, issues: context.issues, physical: context.physical, wms: context.wms, dispatch: context.dispatch, qualification: "Server-derived typed context. Label issuance/application and physical observations are independent." }, labels: results, printers, issued });
  }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
}

export const prepareUnitLabelInput = unitLabelContextInput.extend({ operationId: z.string().min(16).max(100), purpose: z.enum(LABEL_PURPOSES).exclude(["legacy_manual"]), printerId: z.string().min(1).max(100), mode: z.enum(["direct", "relay"]), deviceId: z.string().min(1).max(100).optional(), automatic: z.boolean().default(false), observationId: z.string().min(1).max(200).optional(), pickWaveItemId: z.string().min(1).max(200).optional() }).strict();
export async function unitLabelDispatchDay(tx: Prisma.TransactionClient, input: { unitId: string; dispatchDay?: string; pickWaveItemId?: string }) {
  if (!input.pickWaveItemId) return input.dispatchDay;
  const binding = await tx.dispatchWaveItem.findUnique({ where: { pickWaveItemId: input.pickWaveItemId }, include: { pickWave: { select: { archivedAt: true } }, allocation: { include: { snapshot: { include: { board: true } } } } } });
  if (!binding) throw new LabelError("This legacy workbook row has no accepted physical-unit allocation. Its approved legacy label remains available.", 409, "legacy_pick_wave");
  const snapshot = binding.allocation.snapshot, reservation = await tx.dispatchReservation.findUnique({ where: { unitId: input.unitId } });
  if (binding.unitId !== input.unitId || binding.allocation.releasedAt || binding.pickWave.archivedAt || snapshot.board.headSnapshotId !== snapshot.id || snapshot.status !== "approved" || snapshot.coverage !== "complete" || reservation?.allocationId !== binding.allocationId || (input.dispatchDay && input.dispatchDay !== snapshot.board.day)) throw new LabelError("This pick row no longer has a current exact-unit dispatch allocation. Review the active wave.", 409);
  return snapshot.board.day;
}
export async function validateAutomaticUnitLabelObservation(tx: Prisma.TransactionClient, actorUserId: string, context: Awaited<ReturnType<typeof deriveUnitLabelContext>>, observationId?: string) {
  if (!observationId || !context.physical.warehouseEvidence || context.physical.conflicting) throw new LabelError("An automatic label requires a qualifying physical observation of this exact unit.", 409);
  const observed = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
  const effectiveUnitId = observed?.corrections[0] ? observed.corrections[0].unitId : observed?.unitId;
  if (!observed || observed.userId !== actorUserId || effectiveUnitId !== context.unitId || observed.type === "departure" || (context.physical.departedAt && observed.capturedAt.getTime() <= Date.parse(context.physical.departedAt))) throw new LabelError("The automatic print trigger is not the caller's qualifying observation in this unit's current warehouse stay.", 409);
}
export async function prepareUnitLabel(principal: Principal, raw: unknown) {
  const input = prepareUnitLabelInput.parse(raw), requestFingerprint = fingerprint(input), sourceHash = `unit-label:${principal.userId}:${input.operationId}`;
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    assertUnitContextScopes(current);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-operation:${principal.userId}:${input.operationId}`}, 811))`;
    const previous = await tx.identityAudit.findFirst({ where: { action: "unit_labels.intent", actorUserId: current.userId, sourceHash }, orderBy: { createdAt: "asc" } });
    if (previous) {
      const stored = z.object({ requestFingerprint: z.string(), issuanceId: z.string() }).parse(JSON.parse(previous.reason ?? "{}"));
      if (stored.requestFingerprint !== requestFingerprint) throw new LabelError("This operation ID already identifies different unit-label inputs.", 409, "idempotency_conflict");
      const issuance = await tx.labelIssuance.findUnique({ where: { id: stored.issuanceId } });
      if (!issuance) throw new LabelError("The original label receipt is unavailable. No retry was dispatched.", 409);
      return { created: false, issuance: labelIssuanceReceipt(issuance), replayed: true };
    }
    const prepared = await prepareLabelIssuanceInTransaction(tx, current, input);
    await tx.identityAudit.create({ data: { action: "unit_labels.intent", actorUserId: current.userId, sessionId: current.sessionId, sourceHash, reason: JSON.stringify({ requestFingerprint, issuanceId: prepared.issuance.id, grantId: current.grantId ?? null }) } });
    return { ...prepared, replayed: false };
  }, { timeout: 30_000 });
}
