import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Capability, type Principal } from "@/lib/auth/principal";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import { validateWorkflowDefinition, assertWorkflowJson, stableWorkflowJson } from "@/lib/workflows/definition";
import { labelVersionHash } from "@/lib/labels/model";
import { applyTemplateOverrides, defaultsOverrides, TEMPLATE_KINDS, TemplateError, templateContentHash, validatePlatformTemplate, type PlatformTemplatePayload } from "./model";

const id = z.string().min(1).max(200), revision = z.number().int().nonnegative(), operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,150}$/), note = z.string().trim().min(5).max(500);
export const templateListInput = z.object({ kind: z.enum(TEMPLATE_KINDS).optional() }).strict();
export const templateGetInput = z.object({ id }).strict();
export const templateSaveInput = z.object({ operationId, id: id.optional(), expectedRevision: revision, name: z.string().trim().min(1).max(160), payload: z.unknown() }).strict();
export const templatePublishInput = z.object({ operationId, id, expectedRevision: revision.min(1), note, reviewedNoPrivateData: z.literal(true) }).strict();
export const templateRollbackInput = z.object({ operationId, id, expectedRevision: revision.min(1), versionId: id, note }).strict();
export const templateEnabledInput = z.object({ operationId, id, expectedRevision: revision.min(1), enabled: z.boolean(), note }).strict();
export const templatePreviewInput = z.object({ id, versionId: id, overrides: z.unknown().default({}) }).strict();
export const templateAdoptInput = templatePreviewInput.extend({ operationId, expectedRevision: revision, expectedConsumerRevision: revision.optional(), replaceExisting: z.boolean().default(false), note });
export const templateDetachInput = z.object({ operationId, id, expectedRevision: revision.min(1), note }).strict();
const asJson = (value: unknown): Prisma.InputJsonValue => { assertWorkflowJson(value, 512 * 1024); return value as Prisma.InputJsonValue; };
function siteOf(p: Principal) { if (!p.siteId || !p.sessionId) throw new AuthorizationError("Select an authorized warehouse and individual session."); return p.siteId; }
function platform(p: Principal) { return p.isPlatformAdmin === true && p.capabilities.includes("platform.manage"); }
function kindCapability(kind: PlatformTemplatePayload["kind"]): Capability { return kind === "workflow" ? "workflows.manage" : kind === "label_workflow" ? "labels.manage" : "sites.configure"; }
async function readActor(tx: Prisma.TransactionClient, p: Principal) { const current = await assertCurrentPrincipal(tx, p); siteOf(current); if (!["workflow.read", "labels.read", "workflows.manage", "labels.manage", "sites.configure", "platform.manage"].some(cap => (current.capabilities as readonly string[]).includes(cap))) throw new AuthorizationError(); return current; }
async function admin(tx: Prisma.TransactionClient, p: Principal) { const actor = await assertCurrentPrincipal(tx, p, "platform.manage", true); siteOf(actor); if (!platform(actor)) throw new AuthorizationError("Only a platform administrator can change protected default templates."); return actor; }
async function audit(tx: Prisma.TransactionClient, p: Principal, action: string, detail: unknown) { await tx.identityAudit.create({ data: { siteId: siteOf(p), actorUserId: p.userId, sessionId: p.sessionId, action: `templates.${action}`, reason: JSON.stringify(detail) } }); }
async function lockedRecord(tx: Prisma.TransactionClient, p: Principal, templateId: string, expected: number) {
  await tx.$queryRaw`SELECT id FROM "PlatformTemplateRecord" WHERE id=${templateId} FOR UPDATE`;
  const record = await tx.platformTemplateRecord.findUnique({ where: { id: templateId } }); if (!record) throw new TemplateError("Template not found.", 404); if (record.revision !== expected) throw new TemplateError("The platform template changed. Reload before saving.", 409); return record;
}
async function publishedSource(tx: Prisma.TransactionClient, p: Principal, templateId: string, versionId: string) {
  await tx.$queryRaw`SELECT id FROM "PlatformTemplateRecord" WHERE id=${templateId} FOR SHARE`;
  const record = await tx.platformTemplateRecord.findUnique({ where: { id: templateId } });
  const binding = await tx.siteTemplateBinding.findFirst({ where: { templateId, siteId: siteOf(p), enabled: true } });
  if (!record?.enabled || (!platform(p) && record.publishedVersionId !== versionId && binding?.versionId !== versionId)) throw new TemplateError("Choose the current enabled publication or your already-pinned source version.", 404);
  const version = await tx.platformTemplateVersion.findFirst({ where: { id: versionId, templateId } });
  if (!version || templateContentHash(version.payload) !== version.contentHash) throw new TemplateError("Published template version not found or changed.", 409);
  const payload = validatePlatformTemplate(version.payload); if (payload.kind !== record.kind) throw new TemplateError("Template kind/version mismatch.", 409);
  return { record, version, payload, binding };
}
export async function listPlatformTemplates(p: Principal, input: unknown = {}) {
  const data = templateListInput.parse(input); return prisma.$transaction(async tx => {
    const actor = await readActor(tx, p), canManagePlatform = platform(actor), records = await tx.platformTemplateRecord.findMany({ where: { ...(data.kind ? { kind: data.kind } : {}), ...(canManagePlatform ? {} : { enabled: true, publishedVersionId: { not: null } }) }, select: { id: true, kind: true, name: true, enabled: true, revision: true, publishedVersionId: true, updatedAt: true }, orderBy: { name: "asc" }, take: 100 });
    const bindings = await tx.siteTemplateBinding.findMany({ where: { siteId: siteOf(actor) }, orderBy: { createdAt: "desc" }, take: 100 });
    const published = canManagePlatform ? [] : await tx.platformTemplateVersion.findMany({ where: { id: { in: records.flatMap(record => record.publishedVersionId ? [record.publishedVersionId] : []) } }, select: { id: true, payload: true } });
    const visibleRecords = canManagePlatform ? records : records.map(record => { const source = published.find(version => version.id === record.publishedVersionId)?.payload as { title?: string } | undefined; return { ...record, name: source?.title ?? "Published platform template" }; });
    return { siteId: siteOf(actor), canManagePlatform, canAdopt: { workflow: actor.capabilities.includes("workflows.manage"), label_workflow: actor.capabilities.includes("labels.manage"), site_defaults: actor.capabilities.includes("sites.configure") }, templates: visibleRecords, bindings, site: await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteOf(actor) }, select: { revision: true, configuration: true } }), localPrinters: actor.capabilities.includes("sites.configure") || actor.capabilities.includes("labels.manage") ? await tx.labelPrinter.findMany({ where: { siteId: siteOf(actor), isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [] };
  });
}
export async function getPlatformTemplate(p: Principal, input: unknown) {
  const data = templateGetInput.parse(input); return prisma.$transaction(async tx => {
    const actor = await readActor(tx, p), record = await tx.platformTemplateRecord.findUnique({ where: { id: data.id } }); if (!record || (!platform(actor) && (!record.enabled || !record.publishedVersionId))) throw new TemplateError("Published template not found.", 404);
    const binding = await tx.siteTemplateBinding.findFirst({ where: { siteId: siteOf(actor), templateId: record.id } });
    const versions = await tx.platformTemplateVersion.findMany({ where: { templateId: record.id, ...(platform(actor) ? {} : { id: { in: [...new Set([record.publishedVersionId, binding?.versionId].filter((value): value is string => Boolean(value)))] } }) }, orderBy: { version: "desc" }, take: 100 });
    const currentTitle = versions.find(version => version.id === record.publishedVersionId)?.payload as { title?: string } | undefined;
    return { id: record.id, kind: record.kind, name: platform(actor) ? record.name : currentTitle?.title ?? "Published platform template", enabled: record.enabled, revision: record.revision, publishedVersionId: record.publishedVersionId, draft: platform(actor) ? record.draft : null, versions, binding, canManagePlatform: platform(actor) };
  });
}
export async function savePlatformTemplate(p: Principal, input: unknown) {
  const data = templateSaveInput.parse(input), payload = validatePlatformTemplate(data.payload); return prisma.$transaction(async tx => { const actor = await admin(tx, p); return localCommandReceipt(tx, actor, "templates.save", data.operationId, data, async () => {
    const previous = data.id ? await lockedRecord(tx, actor, data.id, data.expectedRevision) : null; if (!previous && data.expectedRevision !== 0) throw new TemplateError("New templates start at revision zero.", 409); if (previous && previous.kind !== payload.kind) throw new TemplateError("A platform template's kind is permanent.", 409);
    if (previous && payload.kind === "label_workflow") { const prior = validatePlatformTemplate(previous.draft); if (prior.kind !== "label_workflow" || prior.definition.purpose !== payload.definition.purpose) throw new TemplateError("A platform label template's purpose is permanent. Create a separate template for another purpose.", 409); }
    const fields = { name: data.name, draft: asJson(payload), updatedByUserId: actor.userId };
    const record = previous ? await tx.platformTemplateRecord.update({ where: { id: previous.id, revision: previous.revision }, data: { ...fields, revision: { increment: 1 } } }) : await tx.platformTemplateRecord.create({ data: { ...fields, kind: payload.kind, createdByUserId: actor.userId } });
    await audit(tx, actor, "draft_saved", { templateId: record.id, revision: record.revision }); return record;
  }); });
}
export async function publishPlatformTemplate(p: Principal, input: unknown) {
  const data = templatePublishInput.parse(input); return prisma.$transaction(async tx => { const actor = await admin(tx, p); return localCommandReceipt(tx, actor, "templates.publish", data.operationId, data, async () => {
    const record = await lockedRecord(tx, actor, data.id, data.expectedRevision), payload = validatePlatformTemplate({ ...(record.draft as Record<string, unknown>), title: record.name }), previous = await tx.platformTemplateVersion.findFirst({ where: { templateId: record.id }, orderBy: { version: "desc" } });
    const version = await tx.platformTemplateVersion.create({ data: { templateId: record.id, version: (previous?.version ?? 0) + 1, payload: asJson(payload), contentHash: templateContentHash(payload), createdByUserId: actor.userId } });
    const saved = await tx.platformTemplateRecord.update({ where: { id: record.id, revision: record.revision }, data: { publishedVersionId: version.id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "published", { templateId: record.id, versionId: version.id, note: data.note }); return { record: saved, version };
  }); });
}
export async function rollbackPlatformTemplate(p: Principal, input: unknown) {
  const data = templateRollbackInput.parse(input); return prisma.$transaction(async tx => { const actor = await admin(tx, p); return localCommandReceipt(tx, actor, "templates.rollback", data.operationId, data, async () => {
    await lockedRecord(tx, actor, data.id, data.expectedRevision); const version = await tx.platformTemplateVersion.findFirst({ where: { id: data.versionId, templateId: data.id } }); if (!version || templateContentHash(version.payload) !== version.contentHash) throw new TemplateError("Choose an immutable version of this template.", 404);
    const saved = await tx.platformTemplateRecord.update({ where: { id: data.id }, data: { publishedVersionId: version.id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "rolled_back", { templateId: data.id, versionId: version.id, note: data.note }); return saved;
  }); });
}
export async function setPlatformTemplateEnabled(p: Principal, input: unknown) {
  const data = templateEnabledInput.parse(input); return prisma.$transaction(async tx => { const actor = await admin(tx, p); return localCommandReceipt(tx, actor, "templates.enabled", data.operationId, data, async () => { await lockedRecord(tx, actor, data.id, data.expectedRevision); const saved = await tx.platformTemplateRecord.update({ where: { id: data.id }, data: { enabled: data.enabled, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "availability_changed", { templateId: data.id, enabled: data.enabled, note: data.note }); return saved; }); });
}
export async function previewSiteTemplate(p: Principal, input: unknown) {
  const data = templatePreviewInput.parse(input); return prisma.$transaction(async tx => {
    const actor = await readActor(tx, p), source = await publishedSource(tx, actor, data.id, data.versionId), applied = applyTemplateOverrides(source.payload, data.overrides), siteId = siteOf(actor);
    let consumerRevision = 0, consumerExists = false;
    if (source.payload.kind === "site_defaults") { consumerRevision = (await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteId }, select: { revision: true } })).revision; consumerExists = true; }
    else if (source.payload.kind === "label_workflow") { const existing = await tx.labelWorkflow.findFirst({ where: { siteId, purpose: source.payload.definition.purpose }, select: { revision: true } }); consumerRevision = existing?.revision ?? 0; consumerExists = Boolean(existing); }
    else { const reference = source.binding ? materialized(source.binding.materialized).workflowId : `template-workflow-${templateContentHash([siteId, source.record.id]).slice(0, 40)}`, existing = await tx.workflowDefinitionRecord.findFirst({ where: { id: reference, siteId }, select: { revision: true } }); consumerRevision = existing?.revision ?? 0; consumerExists = Boolean(existing); }
    return { siteId, sourceVersionId: source.version.id, sourceHash: source.version.contentHash, ...applied, consumerRevision, consumerExists, canAdopt: actor.capabilities.includes(kindCapability(source.payload.kind)), operationalEffect: false };
  });
}

type Materialized = { kind: PlatformTemplatePayload["kind"]; consumerRevision: number; workflowId?: string; workflowVersionId?: string; purpose?: string; labelVersionId?: string; managedKeys?: string[]; connectionRules?: unknown; sourceHash: string; effectiveHash: string };
function materialized(value: unknown): Materialized { const found = value as Materialized; if (!found || !TEMPLATE_KINDS.includes(found.kind) || !Number.isSafeInteger(found.consumerRevision)) throw new TemplateError("The existing template binding requires review.", 409); return found; }
async function materialize(tx: Prisma.TransactionClient, actor: Principal, templateId: string, sourceHash: string, payload: PlatformTemplatePayload, overrides: unknown, previous: Materialized | null, expectedConsumerRevision: number | undefined, replaceExisting: boolean): Promise<Materialized> {
  const siteId = siteOf(actor), effectiveHash = templateContentHash(payload);
  if (payload.kind === "workflow") {
    const workflowId = previous?.workflowId ?? `template-workflow-${templateContentHash([siteId, templateId]).slice(0, 40)}`;
    await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${workflowId} AND "siteId"=${siteId} FOR UPDATE`;
    const record = await tx.workflowDefinitionRecord.findFirst({ where: { id: workflowId, siteId } });
    if ((!previous && record) || (record?.revision ?? 0) !== (expectedConsumerRevision ?? previous?.consumerRevision ?? 0)) throw new TemplateError("The materialized workflow changed. Reload its current revision.", 409);
    const latest = record ? await tx.workflowDefinitionVersion.findFirst({ where: { definitionId: workflowId, siteId }, orderBy: { version: "desc" } }) : null;
    const versionId = randomUUID(), versionNumber = (latest?.version ?? 0) + 1, definition = validateWorkflowDefinition({ ...payload.definition, id: workflowId, versionId, version: versionNumber });
    const workflow = record ? await tx.workflowDefinitionRecord.update({ where: { id: workflowId, revision: record.revision }, data: { name: definition.name, draft: asJson(definition), revision: { increment: 1 }, updatedByUserId: actor.userId } }) : await tx.workflowDefinitionRecord.create({ data: { id: workflowId, siteId, name: definition.name, draft: asJson(definition), createdByUserId: actor.userId, updatedByUserId: actor.userId } });
    await tx.workflowDefinitionVersion.create({ data: { id: versionId, siteId, definitionId: workflowId, version: versionNumber, definition: asJson(definition), contentHash: templateContentHash(definition), createdByUserId: actor.userId } });
    const saved = await tx.workflowDefinitionRecord.update({ where: { id: workflowId }, data: { publishedVersionId: versionId, revision: { increment: 1 }, updatedByUserId: actor.userId } });
    await audit(tx, actor, "workflow_materialized", { templateId, workflowId: workflow.id, versionId, sourceHash });
    return { kind: payload.kind, consumerRevision: saved.revision, workflowId, workflowVersionId: versionId, sourceHash, effectiveHash };
  }
  if (payload.kind === "label_workflow") {
    const draft = payload.definition;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-workflow:${draft.purpose}`}, 810))`;
    const other = await tx.siteTemplateBinding.findFirst({ where: { siteId, enabled: true, templateId: { not: templateId }, materialized: { path: ["purpose"], equals: draft.purpose } } });
    if (other) throw new TemplateError("Another active platform template owns this label purpose. Review its binding before replacing it.", 409);
    await tx.$queryRaw`SELECT purpose FROM "LabelWorkflow" WHERE purpose=${draft.purpose} AND "siteId"=${siteId} FOR UPDATE`;
    const current = await tx.labelWorkflow.findFirst({ where: { purpose: draft.purpose, siteId } });
    if ((!previous && current && !replaceExisting) || (current?.revision ?? 0) !== (expectedConsumerRevision ?? previous?.consumerRevision ?? 0)) throw new TemplateError("Review the current local label revision and explicitly allow replacement before adoption.", 409);
    const fields = { name: draft.name, draftZpl: draft.zpl, requiredFields: draft.requiredFields, rules: asJson(draft.rules), widthMm: draft.widthMm, heightMm: draft.heightMm, dpi: draft.dpi, updatedByUserId: actor.userId };
    const workflow = current ? await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId, purpose: draft.purpose }, revision: current.revision }, data: { ...fields, revision: { increment: 1 } } }) : await tx.labelWorkflow.create({ data: { siteId, purpose: draft.purpose, ...fields } });
    const latest = await tx.labelWorkflowVersion.findFirst({ where: { siteId, purpose: draft.purpose }, orderBy: { version: "desc" } });
    const version = await tx.labelWorkflowVersion.create({ data: { ...draft, siteId, rules: asJson(draft.rules), version: (latest?.version ?? 0) + 1, contentHash: labelVersionHash(draft), publishedByUserId: actor.userId, note: `Platform template ${templateId}; pinned source ${sourceHash}` } });
    const saved = await tx.labelWorkflow.update({ where: { siteId_purpose: { siteId, purpose: draft.purpose }, revision: workflow.revision }, data: { publishedVersionId: version.id, revision: { increment: 1 }, updatedByUserId: actor.userId } });
    await tx.labelWorkflowAudit.create({ data: { siteId, purpose: draft.purpose, actorUserId: actor.userId, action: "platform_template_adopted", revision: saved.revision, versionId: version.id, note: `Pinned ${templateId}; source ${sourceHash}` } });
    return { kind: payload.kind, consumerRevision: saved.revision, purpose: workflow.purpose, labelVersionId: version.id, sourceHash, effectiveHash };
  }
  await tx.$queryRaw`SELECT id FROM "WarehouseSite" WHERE id=${siteId} FOR UPDATE`;
  const site = await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteId } });
  if (site.revision !== (expectedConsumerRevision ?? previous?.consumerRevision)) throw new TemplateError("Review the current warehouse configuration revision before applying defaults.", 409);
  const existing = await tx.siteTemplateBinding.findFirst({ where: { siteId, enabled: true, templateId: { not: templateId }, materialized: { path: ["kind"], equals: "site_defaults" } } });
  if (existing) throw new TemplateError("This warehouse already has active defaults from another template.", 409);
  const local = defaultsOverrides.parse(overrides), old = site.configuration as Record<string, Prisma.JsonValue>, configuration: Record<string, Prisma.JsonValue> = { ...old, locations: payload.defaults.locations };
  const managedKeys = ["locations"];
  if (payload.defaults.timezone) { configuration.timezone = payload.defaults.timezone; managedKeys.push("timezone"); }
  if (Object.hasOwn(local, "defaultPrinterId")) { configuration.defaultPrinterId = local.defaultPrinterId ?? null; managedKeys.push("defaultPrinterId"); }
  else if (payload.defaults.printerName) { const printers = await tx.labelPrinter.findMany({ where: { siteId, name: payload.defaults.printerName, isActive: true }, select: { id: true }, take: 2 }); configuration.defaultPrinterId = printers.length === 1 ? printers[0].id : null; managedKeys.push("defaultPrinterId"); }
  if (configuration.defaultPrinterId && !await tx.labelPrinter.findFirst({ where: { id: String(configuration.defaultPrinterId), siteId, isActive: true } })) throw new AuthorizationError("Choose an active managed printer from this warehouse; no cross-site printer is inherited.");
  if (Object.hasOwn(local, "defaultWorkflowId")) { configuration.defaultWorkflowId = local.defaultWorkflowId ?? null; managedKeys.push("defaultWorkflowId"); }
  else if (payload.defaults.defaultWorkflowPurpose) { configuration.defaultWorkflowId = payload.defaults.defaultWorkflowPurpose; managedKeys.push("defaultWorkflowId"); }
  if (configuration.defaultWorkflowId && !await tx.labelWorkflow.findFirst({ where: { siteId, purpose: String(configuration.defaultWorkflowId), enabled: true, publishedVersionId: { not: null } } })) throw new TemplateError("The selected legacy label-workflow purpose is not published in this warehouse.", 409);
  if (!previous && !replaceExisting && managedKeys.some(key => old[key] !== undefined && stableWorkflowJson(old[key]) !== stableWorkflowJson(configuration[key]))) throw new TemplateError("Applying these defaults would replace existing local values. Review and explicitly allow replacement.", 409);
  const saved = await tx.warehouseSite.update({ where: { id: siteId, revision: site.revision }, data: { configuration: asJson(configuration), revision: { increment: 1 } } });
  return { kind: payload.kind, consumerRevision: saved.revision, managedKeys, connectionRules: payload.defaults.connectionRules, sourceHash, effectiveHash };
}
export async function adoptSiteTemplate(p: Principal, input: unknown) {
  const data = templateAdoptInput.parse(input); return prisma.$transaction(async tx => {
    const initial = await readActor(tx, p), source = await publishedSource(tx, initial, data.id, data.versionId), actor = await assertCurrentPrincipal(tx, initial, kindCapability(source.payload.kind), true), siteId = siteOf(actor);
    return localCommandReceipt(tx, actor, "templates.adopt", data.operationId, data, async () => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`template-binding:${siteId}:${data.id}`},0))`;
      const previous = await tx.siteTemplateBinding.findFirst({ where: { templateId: data.id, siteId } }); if ((previous?.revision ?? 0) !== data.expectedRevision) throw new TemplateError("This site override changed. Reload its current revision.", 409);
      const applied = applyTemplateOverrides(source.payload, data.overrides), consumer = await materialize(tx, actor, source.record.id, source.version.contentHash, applied.effective, applied.overrides, previous ? materialized(previous.materialized) : null, data.expectedConsumerRevision, data.replaceExisting);
      const values = { versionId: source.version.id, overrides: asJson(applied.overrides), materialized: asJson(consumer), enabled: true, updatedByUserId: actor.userId };
      const binding = previous ? await tx.siteTemplateBinding.update({ where: { id: previous.id, revision: previous.revision }, data: { ...values, revision: { increment: 1 } } }) : await tx.siteTemplateBinding.create({ data: { ...values, siteId, templateId: source.record.id, createdByUserId: actor.userId } });
      await audit(tx, actor, "adopted", { templateId: source.record.id, sourceVersionId: source.version.id, bindingId: binding.id, revision: binding.revision, effectiveHash: consumer.effectiveHash, note: data.note }); return binding;
    });
  });
}
export async function detachSiteTemplate(p: Principal, input: unknown) {
  const data = templateDetachInput.parse(input); return prisma.$transaction(async tx => {
    const actor = await readActor(tx, p); await tx.$queryRaw`SELECT id FROM "SiteTemplateBinding" WHERE id=${data.id} AND "siteId"=${siteOf(actor)} FOR UPDATE`;
    const binding = await tx.siteTemplateBinding.findFirst({ where: { id: data.id, siteId: siteOf(actor) } }); if (!binding) throw new TemplateError("Site binding not found.", 404);
    const version = await tx.platformTemplateVersion.findUniqueOrThrow({ where: { id: binding.versionId } }), payload = validatePlatformTemplate(version.payload);
    const current = await assertCurrentPrincipal(tx, actor, platform(actor) ? "platform.manage" : kindCapability(payload.kind), true);
    if (!platform(current) && !payload.policy.allowDetach) throw new AuthorizationError("This protected platform binding cannot be detached by a site manager.");
    return localCommandReceipt(tx, current, "templates.detach", data.operationId, data, async () => { if (binding.revision !== data.expectedRevision) throw new TemplateError("The binding changed. Reload before detaching.", 409); const saved = await tx.siteTemplateBinding.update({ where: { id: binding.id, revision: binding.revision }, data: { enabled: false, revision: { increment: 1 }, updatedByUserId: current.userId } }); await audit(tx, current, "detached", { bindingId: binding.id, note: data.note, retainedConsumer: true }); return saved; });
  });
}

/** Trusted native-writer hooks: caller's current domain guard runs in the same transaction. */
export async function assertTemplateWorkflowWrite(tx: Prisma.TransactionClient, p: Principal, workflowId: string) {
  await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${workflowId} AND "siteId"=${siteOf(p)} FOR UPDATE`;
  const found = await tx.siteTemplateBinding.findFirst({ where: { siteId: siteOf(p), enabled: true, materialized: { path: ["workflowId"], equals: workflowId } }, select: { id: true } });
  if (found) throw new TemplateError("This workflow uses protected platform defaults. Edit its allowed site overrides in /management/templates; active run pins remain unchanged.", 403);
}
export async function assertTemplateLabelWrite(tx: Prisma.TransactionClient, p: Principal, purpose: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-workflow:${purpose}`}, 810))`;
  const found = await tx.siteTemplateBinding.findFirst({ where: { siteId: siteOf(p), enabled: true, materialized: { path: ["purpose"], equals: purpose } }, select: { id: true } });
  if (found) throw new TemplateError("This label purpose uses protected platform defaults. Edit its allowed site overrides in /management/templates.", 403);
}
export async function assertTemplateSiteConfiguration(tx: Prisma.TransactionClient, p: Principal, configuration: unknown) {
  await tx.$queryRaw`SELECT id FROM "WarehouseSite" WHERE id=${siteOf(p)} FOR UPDATE`;
  const bindings = await tx.siteTemplateBinding.findMany({ where: { siteId: siteOf(p), enabled: true, materialized: { path: ["kind"], equals: "site_defaults" } } }); if (!bindings.length) return;
  const site = await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteOf(p) } }), previous = site.configuration as Record<string, unknown>, next = configuration as Record<string, unknown>;
  for (const binding of bindings) for (const key of materialized(binding.materialized).managedKeys ?? []) if (stableWorkflowJson(previous[key] ?? null) !== stableWorkflowJson(next[key] ?? null)) throw new TemplateError("This setting uses protected platform defaults. Edit its permitted warehouse overrides in /management/templates.", 403);
}
export async function getTemplateSelectionDefaults(tx: Prisma.TransactionClient, p: Principal) {
  const current = await assertCurrentPrincipal(tx, p), siteId = siteOf(current), site = await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteId } }), configuration = site.configuration as Record<string, unknown>;
  const bindings = await tx.siteTemplateBinding.findMany({ where: { siteId, enabled: true, materialized: { path: ["kind"], equals: "site_defaults" } } });
  const configuredPrinterId = typeof configuration.defaultPrinterId === "string" ? configuration.defaultPrinterId : null;
  const printer = configuredPrinterId ? await tx.labelPrinter.findFirst({ where: { id: configuredPrinterId, siteId, isActive: true }, select: { id: true } }) : null;
  return { siteId, timezone: typeof configuration.timezone === "string" ? configuration.timezone : null, locations: Array.isArray(configuration.locations) ? configuration.locations : [], defaultPrinterId: printer?.id ?? null, defaultWorkflowId: typeof configuration.defaultWorkflowId === "string" ? configuration.defaultWorkflowId : null, connectionRules: bindings.length === 1 ? materialized(bindings[0].materialized).connectionRules ?? [] : [], bindingIds: bindings.map(binding => binding.id), createsAuthority: false, automaticFailover: false };
}
