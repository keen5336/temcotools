import { assertTemplateLabelWrite } from "@/lib/templates/service";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { LabelError, labelDraftInput, labelVersionHash, renderLabelVersion, validateLabelDraft } from "./model";
import { dispatchDay } from "@/lib/dispatch/model";
import { assertUnitContextScopes, deriveUnitLabelContext } from "./unit-context";
import { LABEL_PURPOSES, type LabelDraft } from "./types";

const purposeSchema = z.enum(LABEL_PURPOSES).exclude(["legacy_manual"]);
const noteSchema = z.string().trim().min(1).max(500);
const expectedSchema = z.number().int().min(0);
export const labelWorkflowPurposeInput = z.object({ purpose: purposeSchema });
export const labelWorkflowSaveInput = labelDraftInput.extend({ expectedRevision: expectedSchema.describe("Use 0 to create a new purpose, otherwise its current revision."), note: noteSchema });
export const labelWorkflowPublishInput = z.object({ purpose: purposeSchema, expectedRevision: expectedSchema.min(1), note: noteSchema });
export const labelWorkflowRollbackInput = labelWorkflowPublishInput.extend({ versionId: z.string().min(1).max(100) });
export const labelWorkflowEnabledInput = labelWorkflowPublishInput.extend({ enabled: z.boolean() });
export const labelPreviewInput = labelDraftInput.extend({ fields: z.record(z.string(), z.string().max(2000)) });
export const labelEvaluationInput = z.object({ purpose: purposeSchema, unitId: z.string().min(1).max(100), fields: z.record(z.string(), z.string().max(2000)).default({}).describe("Compatibility input only; identified-unit evaluation uses current authoritative warehouse context."), dispatchDay: dispatchDay.optional(), wmsScope: z.string().trim().min(1).max(100).default("warehouse") });
const versionSummary = { id: true, version: true, name: true, contentHash: true, publishedAt: true, publishedByUserId: true, note: true } as const;
async function lockedWorkflow(tx: Prisma.TransactionClient, purpose: string, expected: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-workflow:${purpose}`}, 810))`;
  await tx.$queryRaw`SELECT purpose FROM "LabelWorkflow" WHERE purpose = ${purpose} FOR UPDATE`;
  const current = await tx.labelWorkflow.findFirst({ where: { purpose } });
  if (!current || current.revision !== expected) throw new LabelError("The label workflow changed. Reload its current revision.", 409);
  return current;
}
export async function listLabelWorkflows(principal: Principal) {
  assertCapability(principal, "labels.manage");
  return prisma.labelWorkflow.findMany({ include: { publishedVersion: true }, orderBy: { purpose: "asc" } });
}
export async function getLabelManagerData(principal: Principal) {
  assertCapability(principal, "labels.manage");
  const [workflows, printers, legacyTemplates] = await Promise.all([
    listLabelWorkflows(principal),
    prisma.labelPrinter.findMany({ where: { isActive: true }, select: { id: true, name: true, endpoint: true, contentType: true }, orderBy: { name: "asc" } }),
    prisma.labelTemplate.findMany({ where: { isActive: true }, select: { id: true, name: true, kind: true, zpl: true }, orderBy: { name: "asc" } }),
  ]);
  return { workflows, printers, legacyTemplates, canPrint: principal.capabilities.includes("labels.print") };
}
export async function listPublishedLabelWorkflows(principal: Principal) {
  assertCapability(principal, "labels.read");
  return prisma.labelWorkflow.findMany({ where: { enabled: true, publishedVersionId: { not: null } }, select: { purpose: true, name: true, publishedVersion: true }, orderBy: { name: "asc" } });
}
export async function getLabelWorkflow(principal: Principal, purposeInput: string) {
  assertCapability(principal, "labels.manage");
  const { purpose } = labelWorkflowPurposeInput.parse({ purpose: purposeInput });
  const workflow = await prisma.labelWorkflow.findFirst({ where: { purpose }, include: { publishedVersion: true, versions: { select: versionSummary, orderBy: { version: "desc" }, take: 100 }, audits: { orderBy: { createdAt: "desc" }, take: 100 } } });
  if (!workflow) throw new LabelError("Label workflow not found.", 404);
  return workflow;
}
export async function saveLabelWorkflow(principal: Principal, input: unknown) {
  assertCapability(principal, "labels.manage");
  const envelope = labelWorkflowSaveInput.parse(input);
  const draft = validateLabelDraft(input);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, principal, "labels.manage");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-workflow:${draft.purpose}`}, 810))`;
    await tx.$queryRaw`SELECT purpose FROM "LabelWorkflow" WHERE purpose=${draft.purpose} FOR UPDATE`;
    await assertTemplateLabelWrite(tx, actor, draft.purpose);
    const current = await tx.labelWorkflow.findFirst({ where: { purpose: draft.purpose } });
    if ((current?.revision ?? 0) !== envelope.expectedRevision) throw new LabelError("The label workflow changed. Reload before saving.", 409);
    const data = { name: draft.name, draftZpl: draft.zpl, requiredFields: draft.requiredFields, rules: draft.rules as unknown as Prisma.InputJsonValue, widthMm: draft.widthMm, heightMm: draft.heightMm, dpi: draft.dpi, updatedByUserId: principal.userId };
    const workflow = current ? await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId: principal.siteId!, purpose: draft.purpose } }, data: { ...data, revision: { increment: 1 } } }) : await tx.labelWorkflow.create({ data: { purpose: draft.purpose, ...data } });
    await tx.labelWorkflowAudit.create({ data: { purpose: draft.purpose, actorUserId: principal.userId, action: current ? "draft_saved" : "created", revision: workflow.revision, note: envelope.note } });
    return workflow;
  });
}
export async function publishLabelWorkflow(principal: Principal, input: unknown) {
  const data = labelWorkflowPublishInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    const current = await lockedWorkflow(tx, data.purpose, data.expectedRevision);
    await assertTemplateLabelWrite(tx, actor, data.purpose);
    const draft = validateLabelDraft({ purpose: current.purpose, name: current.name, zpl: current.draftZpl, requiredFields: current.requiredFields, rules: current.rules, widthMm: current.widthMm, heightMm: current.heightMm, dpi: current.dpi });
    const latest = await tx.labelWorkflowVersion.findFirst({ where: { purpose: data.purpose }, orderBy: { version: "desc" }, select: { version: true } });
    const published = await tx.labelWorkflowVersion.create({ data: { ...draft, purpose: data.purpose, rules: draft.rules as unknown as Prisma.InputJsonValue, version: (latest?.version ?? 0) + 1, contentHash: labelVersionHash(draft), publishedByUserId: principal.userId, note: data.note } });
    const workflow = await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId: principal.siteId!, purpose: data.purpose } }, data: { publishedVersionId: published.id, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.labelWorkflowAudit.create({ data: { purpose: data.purpose, actorUserId: principal.userId, action: "published", revision: workflow.revision, versionId: published.id, note: data.note } });
    return { workflow, published };
  });
}
export async function rollbackLabelWorkflow(principal: Principal, input: unknown) {
  const data = labelWorkflowRollbackInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    await lockedWorkflow(tx, data.purpose, data.expectedRevision);
    await assertTemplateLabelWrite(tx, actor, data.purpose);
    const version = await tx.labelWorkflowVersion.findFirst({ where: { id: data.versionId, purpose: data.purpose } });
    if (!version) throw new LabelError("Choose a published version of this label purpose.", 404);
    const workflow = await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId: principal.siteId!, purpose: data.purpose } }, data: { publishedVersionId: version.id, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.labelWorkflowAudit.create({ data: { purpose: data.purpose, actorUserId: principal.userId, action: "rolled_back", revision: workflow.revision, versionId: version.id, note: data.note } });
    return workflow;
  });
}
export async function setLabelWorkflowEnabled(principal: Principal, input: unknown) {
  const data = labelWorkflowEnabledInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    await lockedWorkflow(tx, data.purpose, data.expectedRevision);
    await assertTemplateLabelWrite(tx, actor, data.purpose);
    const workflow = await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId: principal.siteId!, purpose: data.purpose } }, data: { enabled: data.enabled, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.labelWorkflowAudit.create({ data: { purpose: data.purpose, actorUserId: principal.userId, action: data.enabled ? "enabled" : "disabled", revision: workflow.revision, note: data.note } });
    return workflow;
  });
}
export function previewLabelDraft(principal: Principal, input: unknown) {
  assertCapability(principal, "labels.manage");
  const draft = validateLabelDraft(input);
  const { fields } = labelPreviewInput.parse(input);
  return { ...renderLabelVersion({ id: "draft-preview", ...draft }, fields), widthMm: draft.widthMm, heightMm: draft.heightMm, dpi: draft.dpi, limitation: "Content and ZPL preview only; actual printer raster/media qualification is separate." };
}
export async function evaluateLabel(principal: Principal, input: { purpose: LabelDraft["purpose"]; unitId: string; fields?: unknown; dispatchDay?: string; wmsScope?: string }) {
  return prisma.$transaction(async tx => {
  const current = await assertCurrentPrincipal(tx, principal, "labels.read"); assertUnitContextScopes(current);
  const { purpose, unitId, dispatchDay, wmsScope } = labelEvaluationInput.parse(input);
  const context = await deriveUnitLabelContext(tx, { unitId, dispatchDay, wmsScope });
  const [unit, workflow, observations, issued] = await Promise.all([
    tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } }),
    tx.labelWorkflow.findFirst({ where: { purpose }, include: { publishedVersion: true } }),
    tx.$queryRaw<{ id: string; type: string; location: string | null; capturedAt: Date; receivedAt: Date; userId: string }[]>`
      WITH effective AS (
        SELECT o.id,o.type,o.location,o."capturedAt",o."receivedAt",o."userId" FROM "WarehousePhysicalObservation" o
        LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
        WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${unitId}
      ) SELECT * FROM effective WHERE "capturedAt"=(SELECT max("capturedAt") FROM effective) ORDER BY "receivedAt" DESC,id DESC`,
    tx.labelIssuance.findMany({ where: { unitId, purpose }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, contentFingerprint: true, state: true, createdAt: true, dispatchedAt: true, appliedAt: true, physicallyConfirmedAt: true } }),
  ]);
  if (!unit) throw new LabelError("Physical unit not found.", 404);
  const latest = observations[0];
  const conflicting = observations.some(item => item.type !== latest?.type || item.location !== latest?.location);
  const observed = latest ? { ...latest, certainty: "as_observed_not_live_presence", conflictingObservationIds: conflicting ? observations.map(item => item.id) : [] } : null;
  if (!workflow?.enabled || !workflow.publishedVersion) return { unitId, context, available: false, reason: "No enabled published label workflow.", lastObserved: observed, issued };
  const rendered = renderLabelVersion(workflow.publishedVersion, context.fields);
  const [same, unresolved] = await Promise.all([
    tx.labelIssuance.findFirst({ where: { unitId, purpose, contentFingerprint: rendered.contentFingerprint, state: { notIn: ["cancelled", "not_sent", "verified_not_printed"] } }, select: { id: true }, orderBy: { createdAt: "desc" } }),
    tx.labelIssuance.findFirst({ where: { unitId, purpose, state: { in: ["dispatching", "unknown"] } }, select: { id: true }, orderBy: { createdAt: "desc" } }),
  ]);
  return { unitId, context, available: true, versionId: workflow.publishedVersion.id, contentFingerprint: rendered.contentFingerprint, due: !same, blockedByUnknownIssuanceId: unresolved?.id ?? null, decision: rendered.decision, lastObserved: observed, lastIssued: issued[0] ?? null, issued };
  });
}
