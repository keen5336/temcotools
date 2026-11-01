import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { ensureBuiltInLabelTemplates, LABEL_TEMPLATE_KINDS, validatePrinterEndpoint } from "@/lib/label-configuration";
import { LabelError } from "@/lib/labels/model";

const id = z.string().min(1).max(100), name = z.string().trim().min(1).max(120);
const version = z.string().datetime({ offset: true }).optional();
const printerFields = { name, endpoint: z.string().trim().refine(validatePrinterEndpoint, "Use an HTTP(S) printer endpoint without embedded credentials or fragments."), contentType: z.enum(["text/plain", "application/octet-stream"]).default("text/plain") };
const templateFields = { name, kind: z.enum(LABEL_TEMPLATE_KINDS), zpl: z.string().trim().min(1).max(128 * 1024).refine(value => value.includes("^XA") && value.includes("^XZ"), "A complete ZPL label is required.") };
export const operatorLabelConfigurationInput = z.object({ kind: z.enum(LABEL_TEMPLATE_KINDS) });
export const printerCreateInput = z.object(printerFields);
export const printerUpdateInput = z.object({ ...printerFields, id, isActive: z.boolean().default(true), expectedUpdatedAt: version, updatedAt: version });
export const printerEnabledInput = z.object({ id, enabled: z.boolean(), expectedUpdatedAt: version });
export const templateCreateInput = z.object({ ...templateFields, isDefault: z.boolean().default(false) });
export const templateUpdateInput = z.object({ ...templateFields, id, isActive: z.boolean().default(true), isDefault: z.boolean().default(false), expectedUpdatedAt: version, updatedAt: version });
export const templateDefaultInput = z.object({ id, expectedUpdatedAt: version });
export const templateEnabledInput = z.object({ id, enabled: z.boolean(), expectedUpdatedAt: version });
function checkVersion(current: { updatedAt: Date }, expected?: string) { if (expected && current.updatedAt.getTime() !== Date.parse(expected)) throw new LabelError("Configuration changed. Reload before saving.", 409); }
async function configurationAudit(tx: Prisma.TransactionClient, principal: Principal, action: string, resource: string) {
  await tx.identityAudit.create({ data: { action: `labels.configuration.${action}`, actorUserId: principal.userId, sessionId: principal.sessionId, reason: JSON.stringify({ resource, grantId: principal.grantId ?? null }) } });
}
async function lockKind(tx: Prisma.TransactionClient, kind: string) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-template:${kind}`}, 812))`; }
async function lockedPrinter(tx: Prisma.TransactionClient, printerId: string, expected?: string) {
  await tx.$queryRaw`SELECT id FROM "LabelPrinter" WHERE id=${printerId} FOR UPDATE`;
  const row = await tx.labelPrinter.findUnique({ where: { id: printerId } });
  if (!row) throw new LabelError("Printer not found.", 404);
  checkVersion(row, expected); return row;
}
async function lockedTemplate(tx: Prisma.TransactionClient, templateId: string, expected?: string) {
  await tx.$queryRaw`SELECT id FROM "LabelTemplate" WHERE id=${templateId} FOR UPDATE`;
  const row = await tx.labelTemplate.findUnique({ where: { id: templateId } });
  if (!row) throw new LabelError("Template not found.", 404);
  checkVersion(row, expected); return row;
}
export async function getManagedLabelConfiguration(principal: Principal) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "labels.manage"); await ensureBuiltInLabelTemplates(tx);
    const [printers, templates] = await Promise.all([tx.labelPrinter.findMany({ orderBy: { name: "asc" } }), tx.labelTemplate.findMany({ orderBy: [{ kind: "asc" }, { isDefault: "desc" }, { name: "asc" }] })]);
    return { printers, templates };
  });
}
export async function getOperatorLabelConfiguration(principal: Principal, input: unknown) {
  const { kind } = operatorLabelConfigurationInput.parse(input);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "labels.read"); await ensureBuiltInLabelTemplates(tx);
    const [printers, templates] = await Promise.all([tx.labelPrinter.findMany({ where: { isActive: true }, select: { id: true, name: true, endpoint: true, contentType: true }, orderBy: { name: "asc" } }), tx.labelTemplate.findMany({ where: { kind, isActive: true }, select: { id: true, name: true, zpl: true, isDefault: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] })]);
    return { printers, templates };
  });
}
export async function createPrinter(principal: Principal, input: unknown) {
  const data = printerCreateInput.parse(input);
  return prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true); const row = await tx.labelPrinter.create({ data: { ...data, createdByUserId: current.userId, updatedByUserId: current.userId } }); await configurationAudit(tx, current, "printer_created", row.id); return row; });
}
export async function updatePrinter(principal: Principal, input: unknown) {
  const data = printerUpdateInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true); await lockedPrinter(tx, data.id, data.expectedUpdatedAt ?? data.updatedAt);
    const row = await tx.labelPrinter.update({ where: { id: data.id }, data: { name: data.name, endpoint: data.endpoint, contentType: data.contentType, isActive: data.isActive, updatedByUserId: current.userId } }); await configurationAudit(tx, current, "printer_updated", row.id); return row;
  });
}
export async function setPrinterEnabled(principal: Principal, input: unknown) {
  const data = printerEnabledInput.parse(input);
  return prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true); await lockedPrinter(tx, data.id, data.expectedUpdatedAt); const row = await tx.labelPrinter.update({ where: { id: data.id }, data: { isActive: data.enabled, updatedByUserId: current.userId } }); await configurationAudit(tx, current, data.enabled ? "printer_enabled" : "printer_disabled", row.id); return row; });
}
export async function createTemplate(principal: Principal, input: unknown) {
  const data = templateCreateInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true); await lockKind(tx, data.kind);
    if (data.isDefault) await tx.labelTemplate.updateMany({ where: { kind: data.kind, isDefault: true }, data: { isDefault: false, updatedByUserId: current.userId } });
    const row = await tx.labelTemplate.create({ data: { ...data, createdByUserId: current.userId, updatedByUserId: current.userId } }); await configurationAudit(tx, current, "template_created", row.id); return row;
  });
}
export async function updateTemplate(principal: Principal, input: unknown) {
  const data = templateUpdateInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    // Consistent kind-lock order prevents cross-workflow moves from deadlocking.
    for (const kind of LABEL_TEMPLATE_KINDS) await lockKind(tx, kind);
    await lockedTemplate(tx, data.id, data.expectedUpdatedAt ?? data.updatedAt);
    if (data.isDefault && data.isActive) await tx.labelTemplate.updateMany({ where: { kind: data.kind, isDefault: true, NOT: { id: data.id } }, data: { isDefault: false, updatedByUserId: current.userId } });
    const row = await tx.labelTemplate.update({ where: { id: data.id }, data: { name: data.name, kind: data.kind, zpl: data.zpl, isActive: data.isActive, isDefault: data.isActive && data.isDefault, updatedByUserId: current.userId } }); await configurationAudit(tx, current, "template_updated", row.id); return row;
  });
}
export async function setDefaultTemplate(principal: Principal, input: unknown) {
  const data = templateDefaultInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    for (const kind of LABEL_TEMPLATE_KINDS) await lockKind(tx, kind);
    const original = await lockedTemplate(tx, data.id, data.expectedUpdatedAt);
    if (!original.isActive) throw new LabelError("Enable the template before making it the default.", 409);
    await tx.labelTemplate.updateMany({ where: { kind: original.kind, isDefault: true, NOT: { id: data.id } }, data: { isDefault: false, updatedByUserId: current.userId } });
    const row = await tx.labelTemplate.update({ where: { id: data.id }, data: { isDefault: true, updatedByUserId: current.userId } }); await configurationAudit(tx, current, "template_default_set", row.id); return row;
  });
}
export async function setTemplateEnabled(principal: Principal, input: unknown) {
  const data = templateEnabledInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "labels.manage", true);
    for (const kind of LABEL_TEMPLATE_KINDS) await lockKind(tx, kind);
    await lockedTemplate(tx, data.id, data.expectedUpdatedAt);
    const row = await tx.labelTemplate.update({ where: { id: data.id }, data: { isActive: data.enabled, ...(data.enabled ? {} : { isDefault: false }), updatedByUserId: current.userId } }); await configurationAudit(tx, current, data.enabled ? "template_enabled" : "template_disabled", row.id); return row;
  });
}
