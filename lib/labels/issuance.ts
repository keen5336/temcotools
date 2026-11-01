import { randomBytes } from "node:crypto";
import type { LabelIssuance, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, AuthorizationError, CAPABILITIES, type Capability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { currentPrintingDevice, hashDeviceToken } from "./devices";
import { fingerprint, LabelError, renderLabelVersion, matchesApprovedLegacyTemplate } from "./model";
import { LABEL_PURPOSES, type LabelDispatchClaim } from "./types";

const idSchema = z.string().min(1).max(100);
const prepareSchema = z.object({ operationId: z.string().min(16).max(100), unitId: idSchema.optional(), purpose: z.enum(LABEL_PURPOSES), printerId: idSchema, versionId: idSchema.optional(), fields: z.record(z.string(), z.string().max(2000)).default({}), legacyZpl: z.string().min(1).max(128 * 1024).optional(), mode: z.enum(["direct", "relay"]), deviceId: idSchema.optional(), automatic: z.boolean().default(false), reprintOf: idSchema.optional(), reason: z.string().trim().min(3).max(500).optional() });
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
function receipt(row: LabelIssuance) {
  const selected = Object.fromEntries(Object.keys(receiptFields).map(key => [key, row[key as keyof LabelIssuance]])) as Pick<LabelIssuance, keyof typeof receiptFields>;
  return { ...selected, physicalOutput: row.appliedAt ? "applied_confirmed" : row.physicallyConfirmedAt ? "print_confirmed" : "unconfirmed" };
}
async function currentRequester(tx: Prisma.TransactionClient, row: LabelIssuance) {
  const source = row.actorGrantId?.startsWith("oauth:") ? "oauth_grant" : row.actorGrantId ? "app_grant" : "session";
  if (row.actorAuthSource !== source) throw new AuthorizationError("Unsupported requesting authority. No print was dispatched.");
  const captured: Principal = { userId: row.actorUserId, username: "", displayName: "", role: "user", authVersion: row.actorAuthVersion, sessionId: row.actorSessionId, grantId: row.actorGrantId ?? undefined, capabilities: row.actorCapabilities.filter((cap): cap is Capability => CAPABILITIES.includes(cap as Capability)) };
  return assertCurrentPrincipal(tx, captured, "labels.print");
}
const actorAuthSource = (principal: Principal) => principal.grantId?.startsWith("oauth:") ? "oauth_grant" : principal.grantId ? "app_grant" : "session";
function canRead(principal: Principal, row: LabelIssuance) {
  if (row.actorUserId === principal.userId) assertCapability(principal, "labels.print");
  else assertCapability(principal, "labels.read");
}
export async function prepareLabelIssuance(principal: Principal, input: unknown) {
  const data = prepareSchema.parse(input), inputFingerprint = fingerprint(data);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.print");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-operation:${principal.userId}:${data.operationId}`}, 811))`;
    const existing = await tx.labelIssuance.findUnique({ where: { actorUserId_operationId: { actorUserId: principal.userId, operationId: data.operationId } } });
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) throw new LabelError("This operation ID was used for different label inputs.", 409, "idempotency_conflict");
      return { created: false, issuance: receipt(existing) };
    }
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
      const rendered = renderLabelVersion(workflow.publishedVersion, { ...data.fields, unitId: data.unitId });
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
    await event(tx, issuance, principal.userId, data.reprintOf ? "reprint_prepared" : "prepared", data.reason ?? "Authorized label intent; no physical send yet.");
    return { created: true, issuance: receipt(issuance) };
  });
}
export async function claimLabelDispatch(principal: Principal, input: unknown): Promise<LabelDispatchClaim | { dispatch: false; issuance: ReturnType<typeof receipt> }> {
  const data = z.object({ issuanceId: idSchema, deviceId: idSchema, deviceToken: z.string().min(30).max(100) }).parse(input);
  return prisma.$transaction(async tx => {
    const device = await currentPrintingDevice(tx, principal, data.deviceId, data.deviceToken);
    const row = await lockIssuance(tx, data.issuanceId);
    if (row.deviceId !== device.id || row.mode !== device.mode || !device.printerIds.includes(row.printerId)) throw new AuthorizationError("This issuance is assigned to a different printing device.");
    if (row.state !== "queued") return { dispatch: false, issuance: receipt(row) };
    try { await currentRequester(tx, row); }
    catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
      await event(tx, cancelled, principal.userId, "authorization_ended_before_dispatch", "Requester/session/client permission ended before the device received a print claim.", device.id);
      return { dispatch: false, issuance: receipt(cancelled) };
    }
    if (row.workflowVersionId) {
      const workflow = await tx.labelWorkflow.findUnique({ where: { purpose: row.purpose }, select: { enabled: true, publishedVersionId: true } });
      if (!workflow?.enabled || (workflow.publishedVersionId !== row.workflowVersionId && !row.reprintOf)) {
        const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
        await event(tx, cancelled, principal.userId, "publication_changed_before_dispatch", "Publication changed or was disabled; no device print claim was issued.", device.id);
        return { dispatch: false, issuance: receipt(cancelled) };
      }
    } else if (row.purpose === "legacy_manual") {
      const templates = await tx.labelTemplate.findMany({ where: { isActive: true }, select: { zpl: true } });
      if (!matchesApprovedLegacyTemplate(row.renderedZpl, templates)) {
        const cancelled = await tx.labelIssuance.update({ where: { id: row.id }, data: { state: "not_sent", reportedAt: new Date() } });
        await event(tx, cancelled, principal.userId, "legacy_template_changed_before_dispatch", "The approved legacy template changed or was disabled before a device claim was issued.", device.id);
        return { dispatch: false, issuance: receipt(cancelled) };
      }
    }
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
  const data = z.object({ issuanceId: idSchema, deviceId: idSchema, deviceToken: z.string().min(30).max(100), reportToken: z.string().min(30).max(100), status: z.enum(["sent_unconfirmed", "unknown", "not_sent"]), note: z.string().trim().max(500).default("") }).parse(input);
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
  const data = z.object({ issuanceId: idSchema, reason: z.string().trim().min(3).max(500) }).parse(input);
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
  const data = z.object({ issuanceId: idSchema, outcome: z.enum(["printed", "applied", "not_printed"]), reason: z.string().trim().min(3).max(500) }).parse(input);
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
  const row = await prisma.labelIssuance.findUnique({ where: { id: idSchema.parse(issuanceId) }, include: { events: { orderBy: { createdAt: "asc" } } } });
  if (!row) throw new LabelError("Label issuance not found.", 404);
  canRead(principal, row);
  return { ...receipt(row), events: row.events };
}
export async function listLabelIssuances(principal: Principal, unitId?: string) {
  assertCapability(principal, "labels.read");
  return prisma.labelIssuance.findMany({ where: unitId ? { unitId: idSchema.parse(unitId) } : {}, select: receiptFields, orderBy: { createdAt: "desc" }, take: 100 });
}
export async function listPendingLabelDispatches(principal: Principal, input: unknown) {
  const data = z.object({ deviceId: idSchema, deviceToken: z.string().min(30).max(100) }).parse(input);
  return prisma.$transaction(async tx => {
    const device = await currentPrintingDevice(tx, principal, data.deviceId, data.deviceToken);
    return { issuances: await tx.labelIssuance.findMany({ where: { deviceId: data.deviceId, state: "queued", printerId: { in: device.printerIds } }, select: receiptFields, orderBy: { createdAt: "asc" }, take: 10 }) };
  });
}
export async function reprintLabelIssuance(principal: Principal, input: unknown) {
  const data = z.object({ operationId: z.string().min(16).max(100), issuanceId: idSchema, printerId: idSchema.optional(), mode: z.enum(["direct", "relay"]), deviceId: idSchema.optional(), reason: z.string().trim().min(3).max(500) }).parse(input);
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
