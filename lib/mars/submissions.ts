import type { MarsSubmissionIntent, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { type Principal } from "@/lib/auth/principal";
import { assertCurrentRtvAuthorization } from "@/lib/office/service";
import { deriveCustody, type PhysicalFact } from "@/lib/office/domain";
import { commandMars, marsEvidence, marsId, marsOperation, MarsWorkflowError, queryMars } from "./service";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const actionInput = z.object({ operationId: marsOperation, intentId: marsId, expectedRevision: z.number().int().min(1), evidence: marsEvidence }).strict();
async function lockIntent(tx: Prisma.TransactionClient, intentId: string, revision?: number) {
  await tx.$queryRaw`SELECT id FROM "MarsSubmissionIntent" WHERE id=${intentId} FOR UPDATE`;
  const intent = await tx.marsSubmissionIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new MarsWorkflowError("Submission work not found.", 404);
  if (revision !== undefined && intent.revision !== revision) throw new MarsWorkflowError("This submission work changed. Reload before acting.", 409);
  return intent;
}
async function event(tx: Prisma.TransactionClient, intent: { id: string }, principal: Principal, action: string, evidence: string, payload: unknown = {}) {
  await tx.marsSubmissionIntentEvent.create({ data: { intentId: intent.id, userId: principal.userId, action, evidence, payload: json(payload) } });
}
async function physicalAndHandling(tx: Prisma.TransactionClient, unitId: string, fresh = false) {
  await tx.$queryRaw`SELECT id FROM "WarehouseUnit" WHERE id=${unitId} FOR UPDATE`;
  if (!await tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new MarsWorkflowError("Exact physical unit not found.", 404);
  const now = new Date();
  const hold = await tx.officeDisposition.findFirst({ where: { unitId, kind: { in: ["hold","customer_property"] }, status: { in: ["active","triggered"] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true } });
  if (hold) throw new MarsWorkflowError("A current hold/customer-property instruction conflicts with RTV. Office must resolve it first.", 409);
  const observations = await tx.$queryRaw<PhysicalFact[]>`SELECT o.id,o.type,o.location,o."capturedAt",o."receivedAt" FROM "WarehousePhysicalObservation" o LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1)c ON true WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${unitId} ORDER BY o."capturedAt",o.id`;
  const custody = deriveCustody(observations);
  if (!custody.warehouseEvidence || !custody.last || (fresh && now.getTime() - custody.last.capturedAt.getTime() > 15 * 60_000)) throw new MarsWorkflowError("Confirm this exact unit's physical presence with a current scan before new MARS work. Reported WMS stock or a schedule is not physical completion.", 409);
  return custody.last;
}
async function currentIntentAuthority(tx: Prisma.TransactionClient, intent: MarsSubmissionIntent) {
  if (intent.authorizationExpiresAt <= new Date()) throw new MarsWorkflowError("This exact-unit authorization expired. Office must review before further execution or identity linking.", 409);
  if (intent.authorizationId) return assertCurrentRtvAuthorization(tx, intent.unitId, intent.authorizationId);
  return physicalAndHandling(tx, intent.unitId);
}
async function linkIdentity(tx: Prisma.TransactionClient, principal: Principal, input: { unitId: string; requestNumber: string; evidence: string; intent?: MarsSubmissionIntent; authorizationId?: string }) {
  const value = input.requestNumber.trim().replace(/\s+/g, "").toUpperCase();
  if (!value || value.length > 200) throw new MarsWorkflowError("Use the actual submission number observed in the supported MARS workflow.");
  if (!principal.capabilities.includes("inventory.identify")) {
    if (input.authorizationId) await assertCurrentRtvAuthorization(tx, input.unitId, input.authorizationId);
    else if (input.intent) await currentIntentAuthority(tx, input.intent);
    else throw new MarsWorkflowError("Identity-review permission or a current exact-unit office authorization is required to link a submission.", 403);
  } else await assertCurrentPrincipal(tx, principal, "inventory.identify");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mars-submission:${value}`},0))`;
  const aliases = await tx.warehouseIdentifier.findMany({ where: { kind: "submission", namespace: "mars", value, revokedAt: null } });
  if (aliases.some(alias => alias.unitId !== input.unitId)) throw new MarsWorkflowError("That submission is already linked to another physical unit. Resolve the identity conflict without merging original/replacement appliances.", 409);
  const revoked = await tx.warehouseIdentifier.findFirst({ where: { unitId: input.unitId, kind: "submission", namespace: "mars", value, revokedAt: { not: null } } });
  if (revoked && !aliases.length) throw new MarsWorkflowError("This exact submission link was revoked. Use the explicit identity-review correction flow; a retry must not resurrect it.", 409);
  let submission = await tx.marsUnit.findFirst({ where: { requestNumber: { equals: value, mode: "insensitive" } } });
  // Imported serial text is reported context. Its namespace/cardinality is not
  // qualified, so it neither creates aliases nor authorizes/order-merges units.
  if (!submission) submission = await tx.marsUnit.create({ data: { requestNumber: value, presentInLatestImport: false, localStatus: "active" } });
  const alias = aliases[0] ?? await tx.warehouseIdentifier.create({ data: { unitId: input.unitId, kind: "submission", namespace: "mars", value, rawValue: input.requestNumber, evidence: input.evidence, createdByUserId: principal.userId } });
  await tx.marsEvent.create({ data: { marsUnitId: submission.id, type: "physical_unit_link_verified", userId: principal.userId, payload: json({ unitId: input.unitId, identifierId: alias.id, evidence: input.evidence, intentId: input.intent?.id ?? null, meaning: "Human-evidenced identity link; no automated upstream submission or physical departure was performed." }) } });
  return { unitId: input.unitId, requestNumber: submission.requestNumber, identifierId: alias.id, alreadyLinked: Boolean(aliases.length), externalCreation: "human_observed_identity_only" };
}

export async function listMarsSubmissionIntents(principal: Principal, raw: unknown = {}) {
  const input = marsSubmissionInputs.listMarsSubmissionIntents.parse(raw);
  return queryMars(principal, async tx => ({ intents: await tx.marsSubmissionIntent.findMany({ where: { unitId: input.unitId, ...(input.includeResolved ? {} : { state: { in: ["prepared","in_progress","unknown"] } }), ...(input.afterId ? { id: { gt: input.afterId } } : {}) }, include: { events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } }, orderBy: { id: "asc" }, take: input.limit }), qualification: "Local intent and human evidence only; no qualified MARS creation adapter is configured." }));
}
export async function prepareMarsSubmissionIntent(principal: Principal, raw: unknown) {
  const input = marsSubmissionInputs.prepareMarsSubmissionIntent.parse(raw);
  return commandMars(principal, input.operationId, "intent.prepare", input, async tx => {
    let authorizedByUserId: string, authorizationExpiresAt: Date;
    if (input.authorizationId) {
      const disposition = await assertCurrentRtvAuthorization(tx, input.unitId, input.authorizationId);
      authorizedByUserId = disposition.authorizedByUserId!; authorizationExpiresAt = disposition.expiresAt!;
    } else {
      const current = await assertCurrentPrincipal(tx, principal, "office.authorize_rtv", true);
      await physicalAndHandling(tx, input.unitId, true);
      authorizedByUserId = current.userId; authorizationExpiresAt = input.authorizationExpiresAt ? new Date(input.authorizationExpiresAt) : new Date(Date.now() + 60 * 60_000);
      if (authorizationExpiresAt <= new Date() || authorizationExpiresAt.getTime() > Date.now() + 24 * 60 * 60_000) throw new MarsWorkflowError("Direct exact-unit authorization must expire within the next 24 hours.");
    }
    const existing = await tx.marsSubmissionIntent.findFirst({ where: { unitId: input.unitId, state: { in: ["prepared","in_progress","unknown"] } } });
    if (existing) return { intent: existing, existing: true, next: "Review this existing intent. Unknown or in-progress work cannot be started again; reconcile its original outcome." };
    if (await tx.warehouseIdentifier.findFirst({ where: { unitId: input.unitId, kind: "submission", revokedAt: null } })) throw new MarsWorkflowError("This unit already has a submission identity. Reconcile its existing submission/history before preparing another.", 409);
    const intent = await tx.marsSubmissionIntent.create({ data: { unitId: input.unitId, authorizationId: input.authorizationId, authorizedByUserId, authorizationExpiresAt, preparedByUserId: principal.userId, evidence: input.evidence } });
    await event(tx, intent, principal, "prepared", input.evidence, { authority: input.authorizationId ? "prior_exact_unit_office_disposition" : "current_office_authorization_capability", authorizationExpiresAt });
    return { intent, existing: false, upstreamSubmitted: false, next: "Review the exact unit and current instructions, then record a human workflow handoff. The app has not submitted anything to MARS." };
  });
}
export async function startMarsSubmissionIntent(principal: Principal, raw: unknown) {
  const input = actionInput.parse(raw);
  return commandMars(principal, input.operationId, "intent.start", input, async tx => {
    const current = await lockIntent(tx, input.intentId, input.expectedRevision);
    if (current.state !== "prepared") throw new MarsWorkflowError("Only an unstarted prepared intent may be handed off. Reconcile in-progress or unknown results; do not replay them.", 409);
    await currentIntentAuthority(tx, current);
    if (await tx.warehouseIdentifier.findFirst({ where: { unitId: current.unitId, kind: "submission", revokedAt: null } })) throw new MarsWorkflowError("A submission was linked since preparation. Review it before creating another.", 409);
    const intent = await tx.marsSubmissionIntent.update({ where: { id: current.id }, data: { state: "in_progress", startedAt: new Date(), revision: { increment: 1 } } });
    await event(tx, intent, principal, "human_workflow_handoff_recorded", input.evidence);
    return { intent, upstreamSubmitted: false, automaticReplayAllowed: false, next: "Use the supported signed-in MARS workflow manually. Record its observed submission number here. If the result is uncertain, mark this existing intent unknown; do not create another.", creationAdapter: "unqualified_no_endpoint_configured" };
  });
}
export async function markMarsSubmissionUnknown(principal: Principal, raw: unknown) {
  const input = actionInput.parse(raw);
  return commandMars(principal, input.operationId, "intent.unknown", input, async tx => { const current = await lockIntent(tx, input.intentId, input.expectedRevision); if (!["prepared","in_progress","unknown"].includes(current.state)) throw new MarsWorkflowError("This intent is already resolved.", 409); const intent = await tx.marsSubmissionIntent.update({ where: { id: current.id }, data: { state: "unknown", revision: { increment: 1 } } }); await event(tx, intent, principal, "uncertain_result_retained", input.evidence); return { intent, automaticReplayAllowed: false }; });
}
export async function cancelMarsSubmissionIntent(principal: Principal, raw: unknown) {
  const input = actionInput.parse(raw);
  return commandMars(principal, input.operationId, "intent.cancel", input, async tx => { const current = await lockIntent(tx, input.intentId, input.expectedRevision); if (current.state !== "prepared") throw new MarsWorkflowError("Only unstarted work may be cancelled. Reconcile uncertain or in-progress external results.", 409); const intent = await tx.marsSubmissionIntent.update({ where: { id: current.id }, data: { state: "cancelled", revision: { increment: 1 } } }); await event(tx, intent, principal, "unstarted_intent_cancelled", input.evidence); return { intent }; });
}
export async function reconcileMarsSubmissionIntent(principal: Principal, raw: unknown) {
  const input = marsSubmissionInputs.reconcileMarsSubmissionIntent.parse(raw);
  return commandMars(principal, input.operationId, "intent.reconcile", input, async tx => {
    const current = await lockIntent(tx, input.intentId, input.expectedRevision);
    if (!["in_progress","unknown","prepared"].includes(current.state)) throw new MarsWorkflowError("This intent is already resolved; retain its prior receipt.", 409);
    if (input.outcome === "verified_not_submitted") { await assertCurrentPrincipal(tx, principal, "office.authorize_rtv", true); await event(tx, current, principal, "verified_not_submitted", input.evidence); const intent = await tx.marsSubmissionIntent.update({ where: { id: current.id }, data: { state: "verified_not_submitted", revision: { increment: 1 } } }); return { intent, automaticReplayAllowed: false, next: "No retry was performed. A new explicitly authorized intent may be prepared only after this verified reconciliation." }; }
    if (!input.requestNumber) throw new MarsWorkflowError("Record the actual observed MARS submission number.");
    const link = await linkIdentity(tx, principal, { unitId: current.unitId, requestNumber: input.requestNumber, evidence: input.evidence, intent: current });
    const intent = await tx.marsSubmissionIntent.update({ where: { id: current.id }, data: { state: "linked", requestNumber: link.requestNumber, linkedAt: new Date(), revision: { increment: 1 } } });
    await event(tx, intent, principal, "submission_identity_linked", input.evidence, link);
    return { intent, link, physicalDeparture: "not_confirmed", labelPrinted: false };
  });
}
export async function linkMarsSubmission(principal: Principal, raw: unknown) {
  const input = marsSubmissionInputs.linkMarsSubmission.parse(raw);
  return commandMars(principal, input.operationId, "submission.link", input, async tx => { await tx.$queryRaw`SELECT id FROM "WarehouseUnit" WHERE id=${input.unitId} FOR UPDATE`; if (!await tx.warehouseUnit.findUnique({ where: { id: input.unitId }, select: { id: true } })) throw new MarsWorkflowError("Exact physical unit not found.", 404); return linkIdentity(tx, principal, input); });
}
export async function getMarsLabelHandoff(principal: Principal, raw: unknown) {
  const input = marsSubmissionInputs.getMarsLabelHandoff.parse(raw);
  return queryMars(principal, async tx => {
    const links = await tx.warehouseIdentifier.findMany({ where: { unitId: input.unitId, kind: "submission", revokedAt: null } });
    if (links.length !== 1 || links[0].namespace !== "mars" || links[0].value !== input.requestNumber.trim().toUpperCase()) throw new MarsWorkflowError("The unit needs one current unambiguous submission link before label handoff. Review changed/historical submissions explicitly.", 409);
    const submission = await tx.marsUnit.findFirst({ where: { requestNumber: { equals: links[0].value, mode: "insensitive" } }, select: { requestNumber: true } });
    if (!submission) throw new MarsWorkflowError("The submission identity is not present in retained MARS records.", 409);
    return { unitId: input.unitId, requestNumber: submission.requestNumber, labelUrl: `/tools/rtv-label#mars-unit=${encodeURIComponent(JSON.stringify({ unitId: input.unitId, requestNumber: submission.requestNumber }))}`, detailUrl: /^\d+$/.test(submission.requestNumber) ? `https://delivery-management.homedepot.com/mars/return-submissions/detail/${submission.requestNumber}` : null, printed: false, meaning: "Open existing signed-in label review. Printer selection and explicit print confirmation remain separate." };
  });
}

export const marsSubmissionInputs = {
  startMarsSubmissionIntent: actionInput,
  markMarsSubmissionUnknown: actionInput,
  cancelMarsSubmissionIntent: actionInput,
  listMarsSubmissionIntents: z.object({ unitId: marsId.optional(), limit: z.number().int().min(1).max(100).default(30), afterId: marsId.optional(), includeResolved: z.boolean().default(false) }).strict(),
  prepareMarsSubmissionIntent: z.object({ operationId: marsOperation, unitId: marsId, authorizationId: marsId.optional(), authorizationExpiresAt: z.string().datetime({ offset: true }).optional(), evidence: marsEvidence }).strict(),
  reconcileMarsSubmissionIntent: actionInput.extend({ outcome: z.enum(["linked","verified_not_submitted"]), requestNumber: marsId.optional() }),
  linkMarsSubmission: z.object({ operationId: marsOperation, unitId: marsId, requestNumber: marsId, authorizationId: marsId.optional(), evidence: marsEvidence }).strict(),
  getMarsLabelHandoff: z.object({ unitId: marsId, requestNumber: marsId }).strict(),
} as const;
