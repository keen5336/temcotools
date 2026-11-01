import { randomBytes } from "node:crypto";
import type { LabelIssuance, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, AuthorizationError, CAPABILITIES, type Capability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { currentPrintingDevice, hashDeviceToken, printingDeviceAuthorityInput } from "./devices";
import { fingerprint, LabelError, renderLabelVersion, matchesApprovedLegacyTemplate } from "./model";
import { dispatchDay } from "@/lib/dispatch/model";
import { LABEL_PURPOSES, type LabelDispatchClaim } from "./types";
import { assertUnitContextScopes, deriveUnitLabelContext, unitLabelDispatchDay, validateAutomaticUnitLabelObservation } from "./unit-context";

const idSchema = z.string().min(1).max(100);
export const labelPrepareInput = z.object({ operationId: z.string().min(16).max(100).describe("Durable caller operation ID; retry the same ID and inputs after a lost response."), unitId: idSchema.optional(), purpose: z.enum(LABEL_PURPOSES), printerId: idSchema, versionId: idSchema.optional(), fields: z.record(z.string(), z.string().max(2000)).default({}).describe("Compatibility only for identified units: current server context supplies operational label values."), dispatchDay: dispatchDay.optional(), wmsScope: z.string().trim().min(1).max(100).default("warehouse"), observationId: z.string().min(1).max(200).optional(), pickWaveItemId: z.string().min(1).max(200).optional(), legacyZpl: z.string().min(1).max(128 * 1024).optional().describe("Explicit approved legacy-template content snapshot; at most 128 KiB UTF-8. Not arbitrary printer commands."), mode: z.enum(["direct", "relay"]), deviceId: idSchema.optional(), automatic: z.boolean().default(false), reprintOf: idSchema.optional(), reason: z.string().trim().min(3).max(500).optional() }).strict();
export const labelDispatchClaimInput = printingDeviceAuthorityInput.extend({ issuanceId: idSchema });
export const labelDeliveryReportInput = labelDispatchClaimInput.extend({ reportToken: z.string().min(30).max(100).meta({ writeOnly: true, description: "One-use report authority returned by this actual device's successful dispatch claim." }), status: z.enum(["sent_unconfirmed", "unknown", "not_sent"]), note: z.string().trim().max(500).default("") });
export const labelCancelInput = z.object({ issuanceId: idSchema, reason: z.string().trim().min(3).max(500) });
export const labelReconcileInput = z.object({ issuanceId: idSchema, outcome: z.enum(["printed", "applied", "not_printed"]), reason: z.string().trim().min(3).max(500) });
export const labelIssuanceInput = z.object({ issuanceId: idSchema });
export const labelIssuanceListInput = z.object({ unitId: idSchema.optional() });
export const labelReprintInput = z.object({ operationId: z.string().min(16).max(100), issuanceId: idSchema, printerId: idSchema.optional(), mode: z.enum(["direct", "relay"]), deviceId: idSchema.optional(), reason: z.string().trim().min(3).max(500).describe("Explicit new reprint reason after inspecting the original receipt/printer. Never an automatic replay.") });
const receiptFields = { id: true, operationId: true, actorUserId: true, unitId: true, purpose: true, printerId: true, workflowVersionId: true, contentFingerprint: true, mode: true, deviceId: true, state: true, automatic: true, reprintOf: true, reason: true, ruleId: true, createdAt: true, dispatchedAt: true, reportedAt: true, physicallyConfirmedAt: true, appliedAt: true, reconciledAt: true, reconciliationNote: true } as const;
async function event(tx: Prisma.TransactionClient, row: { id: string; state: string }, actor: string, action: string, note: string, deviceId?: string) {
  await tx.labelIssuanceEvent.create({ data: { issuanceId: row.id, actorUserId: actor, deviceId, action, state: row.state, note } });
}
async function lockIssuance(tx: Prisma.TransactionClient, issuanceId: string) {
  await tx.$queryRaw`SELECT id FROM "LabelIssuance" WHERE id = ${issuanceId} FOR UPDATE`;
  const row = await tx.labelIssuance.findUnique({ where: { id: issuanceId } });
  if (!row) throw new LabelError("Label issuance not found.", 404);
  return row;
}
export function labelIssuanceReceipt(row: LabelIssuance) {
  const selected = Object.fromEntries(Object.keys(receiptFields).map(key => [key, row[key as keyof LabelIssuance]])) as Pick<LabelIssuance, keyof typeof receiptFields>;
  return { ...selected, physicalOutput: row.appliedAt ? "applied_confirmed" : row.physicallyConfirmedAt ? "print_confirmed" : "unconfirmed" };
}
const receipt = labelIssuanceReceipt;
async function currentRequester(tx: Prisma.TransactionClient, row: LabelIssuance) {
  const source = row.actorGrantId?.startsWith("oauth:") ? "oauth_grant" : row.actorGrantId ? "app_grant" : "session";
  if (row.actorAuthSource !== source) throw new AuthorizationError("Unsupported requesting authority. No print was dispatched.");
  const captured: Principal = { userId: row.actorUserId, username: "", displayName: "", role: "user", authVersion: row.actorAuthVersion, sessionId: row.actorSessionId, grantId: row.actorGrantId ?? undefined, capabilities: row.actorCapabilities.filter((cap): cap is Capability => CAPABILITIES.includes(cap as Capability)) };
  return assertCurrentPrincipal(tx, captured, "labels.print");
}
const actorAuthSource = (principal: Principal) => principal.grantId?.startsWith("oauth:") ? "oauth_grant" : principal.grantId ? "app_grant" : "session";
function canRead(principal: Principal, row: LabelIssuance) {
  if (principal.capabilities.includes("labels.read")) return;
  if (row.actorUserId !== principal.userId) throw new AuthorizationError("Label read permission is required for another person's receipt.");
  assertCapability(principal, "labels.print");
}
export async function prepareLabelIssuance(principal: Principal, input: unknown) {
  return prisma.$transaction(tx => prepareLabelIssuanceInTransaction(tx, principal, input));
}
// Trusted application orchestration only; HTTP/MCP bodies cannot supply a DB
// transaction or bypass the current actor and native issuance validation.
export async function prepareLabelIssuanceInTransaction(tx: Prisma.TransactionClient, principal: Principal, input: unknown) {
  const data = labelPrepareInput.parse(input), inputFingerprint = fingerprint(data);
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    if (data.purpose !== "legacy_manual") assertUnitContextScopes(current);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-operation:${principal.userId}:${data.operationId}`}, 811))`;
    const existing = await tx.labelIssuance.findUnique({ where: { actorUserId_operationId: { actorUserId: principal.userId, operationId: data.operationId } } });
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) throw new LabelError("This operation ID was used for different label inputs.", 409, "idempotency_conflict");
      return { created: false, issuance: receipt(existing) };
    }
    if (data.reprintOf) throw new LabelError("Use the explicit original-snapshot reprint action with its receipt and reason.", 409);
    let contextBinding: { unitId: string; dispatchDay?: string; wmsScope: string; observationId?: string; pickWaveItemId?: string } | undefined;
    if (data.unitId && !await tx.warehouseUnit.findUnique({ where: { id: data.unitId }, select: { id: true } })) throw new LabelError("Choose an identified warehouse unit.", 404);
    let zpl: string, contentFingerprint: string, workflowVersionId: string | undefined, ruleId: string | null = null;
    if (data.purpose === "legacy_manual") {
      if (data.automatic || !data.legacyZpl) throw new LabelError("Legacy labels require an explicit manual content snapshot.");
      if (Buffer.byteLength(data.legacyZpl) > 128 * 1024) throw new LabelError("Label content is too large.");
      const approvedTemplates = await tx.labelTemplate.findMany({ where: { isActive: true }, select: { zpl: true } });
      if (!matchesApprovedLegacyTemplate(data.legacyZpl, approvedTemplates)) throw new LabelError("Reload an active managed template before printing. Legacy content must match an approved template.", 409);
      zpl = data.legacyZpl; contentFingerprint = fingerprint({ purpose: data.purpose, zpl });
    } else {
      if (!data.unitId) throw new LabelError("A shared physical-unit ID is required for this label workflow.");
      const workflow = await tx.labelWorkflow.findUnique({ where: { purpose: data.purpose }, include: { publishedVersion: true } });
      if (!workflow?.enabled || !workflow.publishedVersion || (data.versionId && data.versionId !== workflow.publishedVersion.id)) throw new LabelError("Use the current enabled published label version.", 409);
      const selectedDay = await unitLabelDispatchDay(tx, { unitId: data.unitId, dispatchDay: data.dispatchDay, pickWaveItemId: data.pickWaveItemId });
      const context = await deriveUnitLabelContext(tx, { unitId: data.unitId, dispatchDay: selectedDay, wmsScope: data.wmsScope });
      if (data.automatic) await validateAutomaticUnitLabelObservation(tx, current.userId, context, data.observationId);
      const rendered = renderLabelVersion(workflow.publishedVersion, context.fields);
      contextBinding = { unitId: data.unitId, dispatchDay: selectedDay, wmsScope: data.wmsScope, observationId: data.observationId, pickWaveItemId: data.pickWaveItemId };
      if (data.automatic && !rendered.decision.automaticAllowed) throw new LabelError(rendered.decision.reason, 409, "automatic_rule_blocked");
      zpl = rendered.zpl; contentFingerprint = rendered.contentFingerprint; workflowVersionId = workflow.publishedVersion.id; ruleId = rendered.decision.ruleId;
    }
    const effectKey = data.unitId ? `${data.unitId}:${data.purpose}` : `legacy:${contentFingerprint}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-effect:${effectKey}`}, 811))`;
    const scope = { purpose: data.purpose, ...(data.unitId ? { unitId: data.unitId } : { unitId: null, contentFingerprint }) };
    const uncertain = await tx.labelIssuance.findFirst({ where: { ...scope, state: { in: ["dispatching", "unknown"] } }, orderBy: { createdAt: "desc" } });
    if (data.reprintOf) {
      const original = await tx.labelIssuance.findFirst({ where: { ...scope, id: data.reprintOf } });
      if (data.automatic || !data.reason || !original) throw new LabelError("A reprint requires a known prior issuance, explicit reason and manual authorization.", 409, "reprint_reason_required");
    } else if (uncertain) throw new LabelError("An earlier label may have been sent. Inspect its receipt/printer before an explicitly authorized reprint.", 409, "unknown_effect");
    let same = await tx.labelIssuance.findFirst({ where: { ...scope, contentFingerprint, state: { notIn: ["not_sent", "cancelled", "verified_not_printed"] } }, orderBy: { createdAt: "desc" } });
    if (same?.state === "queued" && !data.reprintOf) {
      same = await lockIssuance(tx, same.id);
      if (same.state === "queued") {
        try { await currentRequester(tx, same); }
        catch (error) {
          if (!(error instanceof AuthorizationError)) throw error;
          const cancelled = await tx.labelIssuance.update({ where: { id: same.id }, data: { state: "not_sent", reportedAt: new Date() } });
          await event(tx, cancelled, principal.userId, "authorization_ended_before_dispatch", "Prior queued authority ended. A new authorized request creates a separate intent.");
          same = null;
        }
      }
    }
    if (same && !data.reprintOf) { canRead(current, same); return { created: false, issuance: receipt(same), reason: "This label content was already issued. A repeat scan does not issue it again." }; }
    const printer = await tx.labelPrinter.findUnique({ where: { id: data.printerId } });
    if (!printer?.isActive) throw new LabelError("The managed printer is unavailable.", 409);
    const devices = await tx.printingDevice.findMany({ where: { ...(data.deviceId ? { id: data.deviceId } : {}), mode: data.mode, revokedAt: null, leaseExpiresAt: { gt: new Date() }, printerIds: { has: data.printerId }, ...(data.mode === "direct" ? { userId: principal.userId, sessionId: principal.sessionId } : {}) }, orderBy: { lastSeenAt: "desc" }, take: 1 });
    const device = devices[0];
    if (!device) throw new LabelError("No authorized connected device is available for this printer/mode.", 409, "device_unavailable");
    const issuance = await tx.labelIssuance.create({ data: { operationId: data.operationId, actorUserId: current.userId, actorSessionId: current.sessionId!, actorAuthVersion: current.authVersion, actorGrantId: current.grantId, actorAuthSource: actorAuthSource(current), actorCapabilities: [...current.capabilities], unitId: data.unitId, purpose: data.purpose, printerId: data.printerId, workflowVersionId, contentFingerprint, inputFingerprint, renderedZpl: zpl, mode: data.mode, deviceId: device.id, automatic: data.automatic, reprintOf: data.reprintOf, reason: data.reason, ruleId } });
    await currentRequester(tx, issuance);
    if (contextBinding) await event(tx, issuance, current.userId, "unit_context_bound", JSON.stringify(contextBinding));
    await event(tx, issuance, principal.userId, data.reprintOf ? "reprint_prepared" : "prepared", data.reason ?? "Authorized label intent; no physical send yet.");
    return { created: true, issuance: receipt(issuance) };
}
export async function claimLabelDispatch(principal: Principal, input: unknown): Promise<LabelDispatchClaim | { dispatch: false; issuance: ReturnType<typeof receipt> }> {
  const data = labelDispatchClaimInput.parse(input);
  return prisma.$transaction(async tx => {
    const device = await currentPrintingDevice(tx, principal, data.deviceId, data.deviceToken);
    const row = await lockIssuance(tx, data.issuanceId);
    if (row.deviceId !== device.id || row.mode !== device.mode || !device.printerIds.includes(row.printerId)) throw new AuthorizationError("This issuance is assigned to a different printing device.");
    if (row.state !== "queued") return { dispatch: false, issuance: receipt(row) };
    let requester: Principal;
    try { requester = await currentRequester(tx, row); }
    catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
      await event(tx, cancelled, principal.userId, "authorization_ended_before_dispatch", "Requester/session/client permission ended before the device received a print claim.", device.id);
      return { dispatch: false, issuance: receipt(cancelled) };
    }
    if (row.workflowVersionId) {
      await tx.$queryRaw`SELECT purpose FROM "LabelWorkflow" WHERE purpose=${row.purpose} FOR SHARE`;
      const workflow = await tx.labelWorkflow.findUnique({ where: { purpose: row.purpose }, select: { enabled: true, publishedVersionId: true } });
      if (!workflow?.enabled || (workflow.publishedVersionId !== row.workflowVersionId && !row.reprintOf)) {
        const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
        await event(tx, cancelled, principal.userId, "publication_changed_before_dispatch", "Publication changed or was disabled; no device print claim was issued.", device.id);
        return { dispatch: false, issuance: receipt(cancelled) };
      }
    } else if (row.purpose === "legacy_manual") {
      await tx.$queryRaw`SELECT id FROM "LabelTemplate" WHERE "isActive"=true FOR SHARE`;
      const templates = await tx.labelTemplate.findMany({ where: { isActive: true }, select: { zpl: true } });
      if (!matchesApprovedLegacyTemplate(row.renderedZpl, templates)) {
        const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
        await event(tx, cancelled, principal.userId, "legacy_template_changed_before_dispatch", "The approved legacy template changed or was disabled before a device claim was issued.", device.id);
        return { dispatch: false, issuance: receipt(cancelled) };
      }
    }
    const contextBinding = await tx.labelIssuanceEvent.findFirst({ where: { issuanceId: row.id, action: "unit_context_bound" }, orderBy: { createdAt: "asc" } });
    if (row.purpose !== "legacy_manual") {
      try {
        if (row.reprintOf) {
          const proof = await tx.labelIssuanceEvent.findFirst({ where: { issuanceId: row.id, action: "reprint_snapshot_prepared" }, select: { id: true } });
          const original = await tx.labelIssuance.findUnique({ where: { id: row.reprintOf } });
          if (!proof || !original || original.unitId !== row.unitId || original.purpose !== row.purpose || original.workflowVersionId !== row.workflowVersionId || original.contentFingerprint !== row.contentFingerprint || original.renderedZpl !== row.renderedZpl) throw new LabelError("This is not a verified original-snapshot reprint.", 409);
        } else {
          if (!contextBinding) throw new LabelError("This queued operational label has no authoritative unit binding.", 409);
          assertUnitContextScopes(requester);
          const binding = z.object({ unitId: z.string(), dispatchDay: z.string().optional(), wmsScope: z.string(), observationId: z.string().optional(), pickWaveItemId: z.string().optional() }).parse(JSON.parse(contextBinding.note));
          if (binding.unitId !== row.unitId || !row.workflowVersionId) throw new LabelError("The label's stored unit binding is invalid.", 409);
          const dispatchDay = await unitLabelDispatchDay(tx, binding);
          const context = await deriveUnitLabelContext(tx, { unitId: binding.unitId, dispatchDay, wmsScope: binding.wmsScope });
          const version = await tx.labelWorkflowVersion.findUnique({ where: { id: row.workflowVersionId } });
          if (!version) throw new LabelError("The label version is unavailable.", 409);
          const rendered = renderLabelVersion(version, context.fields);
          if (rendered.contentFingerprint !== row.contentFingerprint || (row.automatic && !rendered.decision.automaticAllowed)) throw new LabelError("Relevant unit context or label rule changed before dispatch.", 409);
          if (row.automatic) await validateAutomaticUnitLabelObservation(tx, row.actorUserId, context, binding.observationId);
        }
      } catch (error) {
        if (!(error instanceof LabelError || error instanceof AuthorizationError || error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
        const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
        await event(tx, cancelled, principal.userId, "unit_context_changed_before_dispatch", "The current unit context no longer supports this queued snapshot. Re-evaluate current instructions; no print claim was issued.", device.id);
        return { dispatch: false, issuance: receipt(cancelled) };
      }
    }
    await tx.$queryRaw`SELECT id FROM "LabelPrinter" WHERE id=${row.printerId} FOR SHARE`;
    const printer = await tx.labelPrinter.findUnique({ where: { id: row.printerId }, select: { id: true, name: true, endpoint: true, contentType: true, isActive: true } });
    if (!printer?.isActive) {
      const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
      await event(tx, cancelled, principal.userId, "printer_disabled_before_dispatch", "The printer was disabled before a device claim was issued.", device.id);
      return { dispatch: false, issuance: receipt(cancelled) };
    }
    const token = randomBytes(32).toString("base64url");
    const updated = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "dispatching", dispatchedAt: new Date(), claimTokenHash: hashDeviceToken(token) } });
    await event(tx, updated, principal.userId, "dispatch_claimed", "Claimed once by an authorized connected device. Printing is not confirmed.", device.id);
    return { dispatch: true, issuanceId: row.id, deviceId: device.id, reportToken: token, printer: { id: printer.id, name: printer.name, endpoint: printer.endpoint, contentType: printer.contentType }, zpl: row.renderedZpl };
  });
}
export async function reportLabelDelivery(principal: Principal, input: unknown) {
  const data = labelDeliveryReportInput.parse(input);
  return prisma.$transaction(async tx => {
    await currentPrintingDevice(tx, principal, data.deviceId, data.deviceToken);
    const row = await lockIssuance(tx, data.issuanceId);
    if (row.deviceId !== data.deviceId || !row.claimTokenHash || row.claimTokenHash !== hashDeviceToken(data.reportToken)) throw new AuthorizationError("This device cannot report that label issuance.");
    const reportFingerprint = fingerprint({ status: data.status, note: data.note });
    if (row.reportFingerprint) {
      if (row.reportFingerprint !== reportFingerprint) throw new LabelError("A different result was already recorded. Reconcile the original receipt instead.", 409);
      return receipt(row);
    }
    if (row.state !== "dispatching") throw new LabelError("This issuance is not awaiting a device result.", 409);
    const updated = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: data.status, reportFingerprint, reportedAt: new Date() } });
    await event(tx, updated, principal.userId, "device_report", data.note || (data.status === "sent_unconfirmed" ? "Browser/network send completed; physical output remains unconfirmed." : "Device reported an uncertain or not-sent result."), data.deviceId);
    return receipt(updated);
  });
}
export async function cancelQueuedLabel(principal: Principal, input: unknown) {
  const data = labelCancelInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    const row = await lockIssuance(tx, data.issuanceId);
    if (row.actorUserId !== current.userId && !current.capabilities.includes("labels.manage")) throw new AuthorizationError();
    if (row.state !== "queued") return receipt(row);
    const updated = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
    await event(tx, updated, principal.userId, "cancelled_before_dispatch", data.reason);
    return receipt(updated);
  });
}
export async function reconcileLabelIssuance(principal: Principal, input: unknown) {
  const data = labelReconcileInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    const row = await lockIssuance(tx, data.issuanceId);
    if (row.actorUserId !== current.userId && !current.capabilities.includes("labels.manage")) throw new AuthorizationError();
    const at = new Date();
    if (data.outcome !== "not_printed" && !row.dispatchedAt) throw new LabelError("This issuance has not been dispatched. Confirm the physical result against the issuance that was actually sent.", 409);
    const updated = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: data.outcome === "applied" ? "applied" : data.outcome === "printed" ? "print_confirmed" : "verified_not_printed", physicallyConfirmedAt: data.outcome === "not_printed" ? null : at, appliedAt: data.outcome === "applied" ? at : null, reconciledAt: at, reconciliationNote: data.reason } });
    await event(tx, updated, principal.userId, "physically_reconciled", data.reason);
    return receipt(updated);
  });
}
export async function getLabelIssuance(principal: Principal, issuanceId: string) {
  labelIssuanceInput.parse({ issuanceId });
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal);
    const row = await tx.labelIssuance.findUnique({ where: { id: idSchema.parse(issuanceId) }, include: { events: { orderBy: { createdAt: "asc" } } } });
    if (!row) throw new LabelError("Label issuance not found.", 404);
    canRead(current, row); return { ...receipt(row), events: row.events };
  });
}
export async function listLabelIssuances(principal: Principal, unitId?: string) {
  labelIssuanceListInput.parse({ unitId });
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, principal, "labels.read"); return tx.labelIssuance.findMany({ where: unitId ? { unitId: idSchema.parse(unitId) } : {}, select: receiptFields, orderBy: { createdAt: "desc" }, take: 100 }); });
}
export async function listPendingLabelDispatches(principal: Principal, input: unknown) {
  const data = printingDeviceAuthorityInput.parse(input);
  return prisma.$transaction(async tx => {
    const device = await currentPrintingDevice(tx, principal, data.deviceId, data.deviceToken);
    return { issuances: await tx.labelIssuance.findMany({ where: { deviceId: data.deviceId, state: "queued", printerId: { in: device.printerIds } }, select: receiptFields, orderBy: { createdAt: "asc" }, take: 10 }) };
  });
}
export async function reprintLabelIssuance(principal: Principal, input: unknown) {
  const data = labelReprintInput.parse(input);
  const inputFingerprint = fingerprint({ action: "reprint_snapshot", ...data });
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-operation:${principal.userId}:${data.operationId}`}, 811))`;
    const existing = await tx.labelIssuance.findUnique({ where: { actorUserId_operationId: { actorUserId: principal.userId, operationId: data.operationId } } });
    if (existing) { if (existing.inputFingerprint !== inputFingerprint) throw new LabelError("This operation ID belongs to a different label intent.", 409); return { created: false, issuance: receipt(existing) }; }
    const original = await lockIssuance(tx, data.issuanceId);
    canRead(current, original);
    const printerId = data.printerId ?? original.printerId;
    const printer = await tx.labelPrinter.findUnique({ where: { id: printerId }, select: { isActive: true } });
    if (!printer?.isActive) throw new LabelError("Choose an active managed printer.", 409);
    const device = await tx.printingDevice.findFirst({ where: { ...(data.deviceId ? { id: data.deviceId } : {}), mode: data.mode, revokedAt: null, leaseExpiresAt: { gt: new Date() }, printerIds: { has: printerId }, ...(data.mode === "direct" ? { userId: principal.userId, sessionId: principal.sessionId } : {}) }, orderBy: { lastSeenAt: "desc" } });
    if (!device) throw new LabelError("No authorized connected device is available.", 409, "device_unavailable");
    const row = await tx.labelIssuance.create({ data: { operationId: data.operationId, actorUserId: current.userId, actorSessionId: current.sessionId!, actorAuthVersion: current.authVersion, actorGrantId: current.grantId, actorAuthSource: actorAuthSource(current), actorCapabilities: [...current.capabilities], unitId: original.unitId, purpose: original.purpose, printerId, workflowVersionId: original.workflowVersionId, contentFingerprint: original.contentFingerprint, inputFingerprint, renderedZpl: original.renderedZpl, mode: data.mode, deviceId: device.id, automatic: false, reprintOf: original.id, reason: data.reason, ruleId: original.ruleId } });
    await currentRequester(tx, row);
    await event(tx, row, principal.userId, "reprint_snapshot_prepared", data.reason);
    return { created: true, issuance: receipt(row) };
  });
}
