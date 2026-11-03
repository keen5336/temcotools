import { getTemplateSelectionDefaults } from "@/lib/templates/service";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, IntegrationActionRecord, IntegrationActionVersion, ProviderConnection, ProviderAccessGrant } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { CAPABILITIES, AuthorizationError, CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal, type Principal } from "@/lib/auth/principal";
import { principalForOAuthGrant } from "@/lib/oauth/grants";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import { getDmpStatus } from "@/lib/api-relay/service";
import { boundedIntegrationPath, exactIntegrationOrigin, integrationActionHash, integrationContentHash, integrationPathMatches, mapActionRequest, validateActionInputs, validateActionOutput, validateIntegrationAction, type IntegrationActionDefinition } from "./definition";
import type { StoredContractApproval } from "./provider-policy";

const id = z.string().min(1).max(200), operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,150}$/), revision = z.number().int().positive();
const effect = z.enum(["read", "write", "print"]);
export const integrationListInput = z.object({}).strict();
export const integrationDraftInput = z.object({ operationId, id: id.optional(), expectedRevision: z.number().int().nonnegative(), definition: z.unknown() }).strict();
export const integrationValidateInput = z.object({ definition: z.unknown() }).strict();
export const integrationPreviewInput = z.object({ definition: z.unknown(), input: z.unknown(), output: z.unknown().optional() }).strict();
export const integrationPublishInput = z.object({ operationId, id, expectedRevision: revision, baseVersionId: id.optional() }).strict();
export const integrationQualifyInput = z.object({ operationId, id, expectedRevision: revision, qualification: z.object({ mode: z.enum(["synthetic", "live"]), evidenceReference: z.string().trim().min(5).max(1000), requestPathPrefix: z.string().min(1).max(1024), identityContractId: id, warehouseBindingContractId: id }).strict() }).strict();
export const integrationRollbackInput = z.object({ operationId, id, expectedRevision: revision, versionId: id }).strict();
export const integrationEnabledInput = z.object({ operationId, id, expectedRevision: revision, enabled: z.boolean() }).strict();
export const connectionRegisterInput = z.object({ operationId, integrationId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), deviceId: id, tabId: id, origin: z.string().max(300), pathname: z.string().max(512), actionVersionIds: z.array(id).min(1).max(32), expiresInMinutes: z.number().int().min(5).max(480).default(60) }).strict();
const granteeInput = z.discriminatedUnion("kind", [z.object({ kind: z.literal("session"), userId: id, sessionId: id }).strict(), z.object({ kind: z.literal("oauth"), grantId: id }).strict(), z.object({ kind: z.literal("warehouse_role"), roleId: id }).strict()]);
export const connectionGrantInput = z.object({ operationId, providerId: id, expectedProviderRevision: revision, grantee: granteeInput, actionVersionIds: z.array(id).min(1).max(32), effects: z.array(effect).min(1).max(3), deviceLinkId: id.optional(), expiresInMinutes: z.number().int().min(5).max(60).default(30) }).strict();
export const connectionRevokeInput = z.object({ operationId, providerId: id, grantId: id.optional() }).strict();
export const connectionLinkInput = z.object({ operationId, deviceIds: z.array(id).length(2).refine(ids => ids[0] !== ids[1], "Choose two distinct devices."), expiresInMinutes: z.number().int().min(5).max(43_200).default(1440) }).strict();
export const connectionUnlinkInput = z.object({ operationId, linkId: id }).strict();
export const connectionRouteInput = z.object({ operationId, linkId: id, expectedRevision: revision, deviceId: id, integrationId: id, effect, providerId: id, expectedProviderRevision: revision }).strict();
export const connectionSimulateInput = z.object({ actionVersionId: id, input: z.unknown(), output: z.unknown().optional() }).strict();
const error = (message: string, status = 400) => Object.assign(new Error(message), { status });
function siteOf(p: Principal) { if (!p.siteId || !p.sessionId) throw new AuthorizationError("Select an authorized warehouse and individual session."); return p.siteId; }
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
async function current(tx: Prisma.TransactionClient, p: Principal, capability: "account.self" | "integrations.manage" | "providers.manage" | "workflow.read" | "platform.manage" = "integrations.manage", recent = false) { const actor = await assertCurrentPrincipal(tx, p, capability, recent); siteOf(actor); return actor; }
async function audit(tx: Prisma.TransactionClient, p: Principal, action: string, detail: unknown) { await tx.identityAudit.create({ data: { siteId: siteOf(p), actorUserId: p.userId, sessionId: p.sessionId, action, reason: JSON.stringify(detail) } }); }
function handoff() { return { status: "requires_user_interaction" as const, actionUrl: `${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin}/management/connections`, instruction: "The human provider owner must open Connections in their own authenticated browser and confirm current password/authenticator. MCP cannot approve its own connection/device sharing." }; }
async function human(tx: Prisma.TransactionClient, p: Principal) { const actor = await current(tx, p, "account.self", !p.grantId); return actor.grantId ? null : actor; }
async function delegation(tx: Prisma.TransactionClient, p: Principal) {
  if (p.grantId) return p.capabilities;
  if (p.isPlatformAdmin) return CAPABILITIES;
  const m = await tx.warehouseMembership.findUnique({ where: { siteId_userId: { siteId: siteOf(p), userId: p.userId } }, include: { roles: { include: { role: true } } } });
  return m?.isActive ? m.roles.filter(r => r.role.isActive && (r.role.siteId === null || r.role.siteId === p.siteId)).flatMap(r => r.role.capabilities) : [];
}
async function allowedDefinition(tx: Prisma.TransactionClient, p: Principal, raw: unknown) { const definition = validateIntegrationAction(raw); if (!(await delegation(tx, p) as readonly string[]).includes(definition.requiredCapability)) throw new AuthorizationError("This action requires a capability outside your current delegation."); return definition; }
async function lockAction(tx: Prisma.TransactionClient, p: Principal, actionId: string, expectedRevision: number) {
  await tx.$queryRaw`SELECT id FROM "IntegrationActionRecord" WHERE id=${actionId} AND "siteId"=${siteOf(p)} FOR UPDATE`;
  const record = await tx.integrationActionRecord.findFirst({ where: { id: actionId, siteId: siteOf(p) } });
  if (!record) throw error("Action not found in this warehouse.", 404);
  if (record.revision !== expectedRevision) throw error("The action changed. Reload its current revision before saving.", 409);
  return record;
}
type ApprovedContract = StoredContractApproval & { requestContractHash: string };
const requestContractHash = (definition: IntegrationActionDefinition) => integrationContentHash({ request: definition.request, inputs: definition.inputs, output: definition.output });
function approvalOf(version: IntegrationActionVersion): ApprovedContract | null {
  const value = version.contractApproval as unknown as ApprovedContract | null;
  if (!value || value.state !== "approved" || !value.id || !value.reviewedByPlatformAdminId || !Number.isSafeInteger(value.reviewedAt) || !["synthetic", "live"].includes(value.mode) || !value.evidenceReference || !value.identityContractId || !value.warehouseBindingContractId || !/^[a-f0-9]{64}$/.test(value.requestContractHash ?? "")) return null;
  return value;
}
async function covered(definition: IntegrationActionDefinition, approval: ApprovedContract) {
  return approval.requestContractHash === await requestContractHash(definition) && approval.integrationId === definition.integrationId && approval.actionKey === definition.key && approval.adapterId === definition.adapterId && approval.adapterVersion === definition.adapterVersion && approval.origin === definition.origin && approval.pagePathPrefix === definition.pagePathPrefix && approval.effect === definition.effect && approval.method === definition.request.method && approval.requiredCapability === definition.requiredCapability && integrationPathMatches(definition.request.path.replace(/\{[^}]+\}/g, "input"), approval.requestPathPrefix);
}
async function versionAndPublish(tx: Prisma.TransactionClient, actor: Principal, record: IntegrationActionRecord, definition: IntegrationActionDefinition, approval: ApprovedContract) {
  if (!await covered(definition, approval)) throw new AuthorizationError("The immutable platform contract does not cover this mapping. Platform review is required for new origin, adapter, identity, endpoint boundary or semantic effect.");
  const previous = await tx.integrationActionVersion.findFirst({ where: { actionId: record.id }, orderBy: { version: "desc" } });
  const version = await tx.integrationActionVersion.create({ data: { actionId: record.id, version: (previous?.version ?? 0) + 1, definition: json(definition), contentHash: await integrationActionHash(definition), contractApproval: json(approval), createdByUserId: actor.userId } });
  const saved = await tx.integrationActionRecord.update({ where: { id: record.id, revision: record.revision }, data: { publishedVersionId: version.id, updatedByUserId: actor.userId, revision: { increment: 1 } } });
  await audit(tx, actor, "integration_action.published", { actionId: record.id, versionId: version.id, qualification: approval.mode, contractApprovalId: approval.id });
  return { record: saved, version, liveDispatchAvailable: false };
}
export async function listIntegrationActions(p: Principal) {
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), records = await tx.integrationActionRecord.findMany({ orderBy: { updatedAt: "desc" }, take: 100 });
    const versions = await tx.integrationActionVersion.findMany({ where: { actionId: { in: records.map(r => r.id) } }, orderBy: { version: "desc" }, take: 500 });
    return { siteId: actor.siteId, isPlatformAdmin: actor.isPlatformAdmin === true, actions: records.map(record => ({ ...record, versions: versions.filter(v => v.actionId === record.id) })), liveDispatchAvailable: false, limitation: "Approved versions can be pinned to explicitly activated providers after actual identity/warehouse contract qualification. Draft preview/simulation sends nothing; existing DMP named reads retain their independent relay and grants." };
  });
}
export async function saveIntegrationActionDraft(p: Principal, raw: unknown) {
  const data = integrationDraftInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p); const definition = await allowedDefinition(tx, actor, data.definition); return localCommandReceipt(tx, actor, "integrations.draft.save", data.operationId, data, async () => {
    const existing = data.id ? await lockAction(tx, actor, data.id, data.expectedRevision) : null;
    if (!existing && data.expectedRevision !== 0) throw error("New drafts start at revision zero.", 409);
    if (existing) await allowedDefinition(tx, actor, existing.draft);
    const record = existing ? await tx.integrationActionRecord.update({ where: { id: existing.id, revision: existing.revision }, data: { name: definition.name, draft: json(definition), updatedByUserId: actor.userId, revision: { increment: 1 } } }) : await tx.integrationActionRecord.create({ data: { name: definition.name, draft: json(definition), createdByUserId: actor.userId, updatedByUserId: actor.userId } });
    await audit(tx, actor, "integration_action.draft_saved", { actionId: record.id, revision: record.revision }); return record;
  }); });
}
export async function validateIntegrationActionDraft(p: Principal, raw: unknown) { const data = integrationValidateInput.parse(raw); return prisma.$transaction(async tx => { const actor = await current(tx, p), definition = await allowedDefinition(tx, actor, data.definition); return { valid: true, definition, contentHash: await integrationActionHash(definition), qualification: "draft_only", operationalEffect: false }; }); }
export async function previewIntegrationAction(p: Principal, raw: unknown) { const data = integrationPreviewInput.parse(raw); return prisma.$transaction(async tx => { const actor = await current(tx, p), definition = await allowedDefinition(tx, actor, data.definition); return { execution: "preview-only", warehouseBinding: "synthetic-preview-value", request: mapActionRequest(definition, data.input, "SYNTHETIC_PREVIEW_WAREHOUSE"), ...(data.output === undefined ? {} : { validatedOutput: validateActionOutput(definition, data.output) }), operationalEffect: false, sent: false }; }); }
export async function publishIntegrationAction(p: Principal, raw: unknown) {
  const data = integrationPublishInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "integrations.manage", true); return localCommandReceipt(tx, actor, "integrations.publish", data.operationId, data, async () => {
    const record = await lockAction(tx, actor, data.id, data.expectedRevision), definition = await allowedDefinition(tx, actor, record.draft);
    const previous = await tx.integrationActionVersion.findFirst({ where: { id: data.baseVersionId ?? record.publishedVersionId ?? "", actionId: record.id } });
    const approval = previous && approvalOf(previous); if (!approval) throw new AuthorizationError("A platform administrator must qualify this origin/adapter/identity contract first. Draft data cannot qualify itself.");
    return versionAndPublish(tx, actor, record, definition, approval);
  }); });
}
export async function qualifyIntegrationAction(p: Principal, raw: unknown) {
  const data = integrationQualifyInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "platform.manage", true); if (!actor.isPlatformAdmin) throw new AuthorizationError("Only a platform administrator can establish contract qualification."); return localCommandReceipt(tx, actor, "integrations.qualify", data.operationId, data, async () => {
    const record = await lockAction(tx, actor, data.id, data.expectedRevision), definition = validateIntegrationAction(record.draft), q = data.qualification;
    boundedIntegrationPath(q.requestPathPrefix);
    const approval: ApprovedContract = { requestContractHash: await requestContractHash(definition), id: randomUUID(), state: "approved", reviewedByPlatformAdminId: actor.userId, reviewedAt: Date.now(), mode: q.mode, evidenceReference: q.evidenceReference, identityContractId: q.identityContractId, warehouseBindingContractId: q.warehouseBindingContractId, requestPathPrefix: q.requestPathPrefix, integrationId: definition.integrationId, actionKey: definition.key, adapterId: definition.adapterId, adapterVersion: definition.adapterVersion, origin: definition.origin, pagePathPrefix: definition.pagePathPrefix, method: definition.request.method, effect: definition.effect, requiredCapability: definition.requiredCapability };
    return versionAndPublish(tx, actor, record, definition, approval);
  }); });
}
export async function rollbackIntegrationAction(p: Principal, raw: unknown) {
  const data = integrationRollbackInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "integrations.manage", true); return localCommandReceipt(tx, actor, "integrations.rollback", data.operationId, data, async () => {
    const record = await lockAction(tx, actor, data.id, data.expectedRevision), version = await tx.integrationActionVersion.findFirst({ where: { id: data.versionId, actionId: record.id } });
    if (!version || !approvalOf(version)) throw error("Choose an approved immutable version of this action.", 404); await allowedDefinition(tx, actor, version.definition);
    const saved = await tx.integrationActionRecord.update({ where: { id: record.id, revision: record.revision }, data: { publishedVersionId: version.id, updatedByUserId: actor.userId, revision: { increment: 1 } } }); await audit(tx, actor, "integration_action.rolled_back", { actionId: record.id, versionId: version.id }); return saved;
  }); });
}
export async function setIntegrationActionEnabled(p: Principal, raw: unknown) {
  const data = integrationEnabledInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "integrations.manage", true); return localCommandReceipt(tx, actor, "integrations.enabled", data.operationId, data, async () => { const record = await lockAction(tx, actor, data.id, data.expectedRevision); await allowedDefinition(tx, actor, record.draft); const saved = await tx.integrationActionRecord.update({ where: { id: record.id, revision: record.revision }, data: { enabled: data.enabled, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "integration_action.enabled", { actionId: record.id, enabled: data.enabled }); return saved; }); });
}
async function sessionPrincipal(tx: Prisma.TransactionClient, sessionId: string, siteId: string) {
  const session = await tx.userSession.findUnique({ where: { id: sessionId } });
  if (!session) return null; const claim = { userId: session.userId, sessionId: session.id, authVersion: session.authVersion, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() };
  if (!isLivePersistentSession(session, claim)) return null; const actor = await resolvePrincipal(claim, userId => tx.user.findUnique({ where: { id: userId }, select: CURRENT_USER_SELECT }), Date.now(), siteId);
  return actor?.siteId === siteId ? { ...actor, sessionId: session.id, expiresAt: session.expiresAt } : null;
}
async function actionVersions(tx: Prisma.TransactionClient, ids: readonly string[], integrationId: string) {
  const versions = await tx.integrationActionVersion.findMany({ where: { id: { in: [...new Set(ids)] } } });
  if (versions.length !== new Set(ids).size) throw new AuthorizationError("Choose published action versions from this warehouse.");
  for (const version of versions) { const record = await tx.integrationActionRecord.findFirst({ where: { id: version.actionId, enabled: true, publishedVersionId: version.id } }); const def = validateIntegrationAction(version.definition); if (!record || def.integrationId !== integrationId || !approvalOf(version)) throw new AuthorizationError("A selected action version is stale, disabled or not approved for this integration."); }
  return versions;
}
export async function registerProviderPlaceholder(p: Principal, raw: unknown) {
  const data = connectionRegisterInput.parse(raw); exactIntegrationOrigin(data.origin); boundedIntegrationPath(data.pathname);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "providers.manage"); return localCommandReceipt(tx, actor, "connections.register", data.operationId, data, async () => {
    const versions = await actionVersions(tx, data.actionVersionIds, data.integrationId);
    for (const version of versions) { const def = validateIntegrationAction(version.definition); if (def.origin !== data.origin || !integrationPathMatches(data.pathname, def.pagePathPrefix)) throw new AuthorizationError("The declared page is outside the approved action origin/path."); }
    const provider = await tx.providerConnection.create({ data: { integrationId: data.integrationId, ownerUserId: actor.userId, ownerSessionId: actor.sessionId!, deviceId: data.deviceId, tabId: data.tabId, origin: data.origin, pathname: data.pathname, transportState: "disconnected", authenticationState: "unqualified", allowedActionVersionIds: data.actionVersionIds, heartbeatAt: new Date(0), expiresAt: new Date(Date.now() + data.expiresInMinutes * 60_000), lastError: "Configuration only. No authenticated generic adapter is installed; use the existing DMP Connect workflow for established DMP reads." } });
    await audit(tx, actor, "provider.placeholder_registered", { providerId: provider.id }); return { provider, operationalEffect: false, liveDispatchAvailable: false };
  }); });
}
async function ownedProvider(tx: Prisma.TransactionClient, p: Principal, providerId: string, expectedRevision?: number, originalSession = false) {
  await tx.$queryRaw`SELECT id FROM "ProviderConnection" WHERE id=${providerId} FOR UPDATE`;
  const provider = await tx.providerConnection.findFirst({ where: { id: providerId, ownerUserId: p.userId, siteId: siteOf(p) } });
  if (!provider || (originalSession && provider.ownerSessionId !== p.sessionId)) throw new AuthorizationError("Open this provider's original owning session in its warehouse.");
  if (expectedRevision !== undefined && provider.revision !== expectedRevision) throw error("This provider changed. Reload before sharing or routing.", 409);
  return provider;
}
export async function grantProviderAccess(p: Principal, raw: unknown) {
  return prisma.$transaction(async tx => { const actor = await human(tx, p); if (!actor) return handoff(); const data = connectionGrantInput.parse(raw); return localCommandReceipt(tx, actor, "connections.grant", data.operationId, data, async () => {
    const provider = await ownedProvider(tx, actor, data.providerId, data.expectedProviderRevision, true);
    if (provider.revokedAt || provider.expiresAt.getTime() <= Date.now()) throw error("Reconnect the original provider before sharing.", 409);
    const versions = await actionVersions(tx, data.actionVersionIds, provider.integrationId);
    if (data.actionVersionIds.some(v => !provider.allowedActionVersionIds.includes(v))) throw new AuthorizationError("The provider does not advertise that exact action version.");
    for (const version of versions) { const def = validateIntegrationAction(version.definition); if (!actor.capabilities.includes(def.requiredCapability as typeof CAPABILITIES[number]) || !data.effects.includes(def.effect)) throw new AuthorizationError("Share only currently authorized named actions and their actual effect types."); }
    if (data.effects.some(e => !versions.some(v => validateIntegrationAction(v.definition).effect === e))) throw error("Each shared effect must name a corresponding action version.");
    let grantee: Prisma.InputJsonValue, receiverUserId: string | undefined, receiverExpires = Infinity;
    if (data.grantee.kind === "session") { const receiver = await sessionPrincipal(tx, data.grantee.sessionId, siteOf(actor)); if (!receiver || receiver.userId !== data.grantee.userId || versions.some(v => !receiver.capabilities.includes(validateIntegrationAction(v.definition).requiredCapability as typeof CAPABILITIES[number]))) throw new AuthorizationError("Choose a current authorized individual session in this warehouse."); grantee = { kind: "session", userId: receiver.userId, sessionId: receiver.sessionId! }; receiverUserId = receiver.userId; receiverExpires = receiver.expiresAt.getTime(); }
    else if (data.grantee.kind === "oauth") { const receiver = await principalForOAuthGrant(tx, data.grantee.grantId); if (receiver.siteId !== actor.siteId || versions.some(v => !receiver.capabilities.includes(validateIntegrationAction(v.definition).requiredCapability as typeof CAPABILITIES[number]))) throw new AuthorizationError("Choose a current explicitly consented client for this warehouse/action."); const grant = await tx.oAuthGrant.findUniqueOrThrow({ where: { id: data.grantee.grantId } }); grantee = { kind: "oauth", userId: receiver.userId, sessionId: receiver.sessionId!, grantId: grant.id }; receiverUserId = receiver.userId; receiverExpires = grant.expiresAt.getTime(); }
    else { const role = await tx.warehouseRole.findFirst({ where: { id: data.grantee.roleId, isActive: true, OR: [{ siteId: actor.siteId }, { siteId: null, isTemplate: true }] } }); if (!role || versions.some(v => !role.capabilities.includes(validateIntegrationAction(v.definition).requiredCapability))) throw new AuthorizationError("Choose an active warehouse role with these action capabilities."); grantee = { kind: "warehouse_role", roleId: role.id }; }
    if (data.deviceLinkId) { const link = await tx.connectedDeviceLink.findFirst({ where: { id: data.deviceLinkId, userId: actor.userId, approvedByUserId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } } }); if (!link || receiverUserId !== actor.userId || !link.deviceIds.includes(provider.deviceId)) throw new AuthorizationError("Use a current explicit same-person device link."); }
    const grant = await tx.providerAccessGrant.create({ data: { providerId: provider.id, issuerUserId: actor.userId, issuerSessionId: actor.sessionId!, grantee, actionVersionIds: data.actionVersionIds, effects: data.effects, deviceLinkId: data.deviceLinkId, expiresAt: new Date(Math.min(Date.now() + data.expiresInMinutes * 60_000, provider.expiresAt.getTime(), receiverExpires)) } }); await audit(tx, actor, "provider.grant_created", { providerId: provider.id, grantId: grant.id, actionVersionIds: grant.actionVersionIds, effects: grant.effects }); return { grant, liveDispatchAvailable: false };
  }); });
}
export async function revokeProviderAccess(p: Principal, raw: unknown) {
  return prisma.$transaction(async tx => { const actor = await human(tx, p); if (!actor) return handoff(); const data = connectionRevokeInput.parse(raw); return localCommandReceipt(tx, actor, "connections.grant.revoke", data.operationId, data, async () => { const provider = await ownedProvider(tx, actor, data.providerId); const at = new Date(); if (data.grantId) await tx.providerAccessGrant.updateMany({ where: { id: data.grantId, providerId: provider.id, issuerUserId: actor.userId, revokedAt: null }, data: { revokedAt: at } }); else { await tx.providerConnection.update({ where: { id: provider.id }, data: { revokedAt: at, revision: { increment: 1 } } }); await tx.providerAccessGrant.updateMany({ where: { providerId: provider.id, revokedAt: null }, data: { revokedAt: at } }); } await audit(tx, actor, "provider.access_revoked", { providerId: provider.id, grantId: data.grantId ?? null }); return { revoked: true }; }); });
}
export async function linkConnectedDevices(p: Principal, raw: unknown) {
  return prisma.$transaction(async tx => { const actor = await human(tx, p); if (!actor) return handoff(); const data = connectionLinkInput.parse(raw); return localCommandReceipt(tx, actor, "connections.device.link", data.operationId, data, async () => { const providers = await tx.providerConnection.findMany({ where: { ownerUserId: actor.userId, deviceId: { in: data.deviceIds }, revokedAt: null, expiresAt: { gt: new Date() } } }); if (data.deviceIds.some(device => !providers.some(provider => provider.deviceId === device))) throw new AuthorizationError("Register both of your devices in this warehouse first. A link is not an upstream login or action grant."); const link = await tx.connectedDeviceLink.create({ data: { userId: actor.userId, approvedByUserId: actor.userId, deviceIds: data.deviceIds, defaults: { revision: 1, routes: [] }, expiresAt: new Date(Date.now() + data.expiresInMinutes * 60_000) } }); await audit(tx, actor, "provider.devices_linked", { linkId: link.id }); return { link, grantsCreated: false }; }); });
}
export async function unlinkConnectedDevices(p: Principal, raw: unknown) {
  return prisma.$transaction(async tx => { const actor = await human(tx, p); if (!actor) return handoff(); const data = connectionUnlinkInput.parse(raw); return localCommandReceipt(tx, actor, "connections.device.unlink", data.operationId, data, async () => { const link = await tx.connectedDeviceLink.findFirst({ where: { id: data.linkId, userId: actor.userId } }); if (!link) throw error("Device link not found.", 404); const at = new Date(); await tx.connectedDeviceLink.update({ where: { id: link.id }, data: { revokedAt: at } }); await tx.providerAccessGrant.updateMany({ where: { deviceLinkId: link.id, revokedAt: null }, data: { revokedAt: at } }); await audit(tx, actor, "provider.devices_unlinked", { linkId: link.id }); return { revoked: true }; }); });
}
export async function saveDeviceProviderDefault(p: Principal, raw: unknown) {
  return prisma.$transaction(async tx => { const actor = await human(tx, p); if (!actor) return handoff(); const data = connectionRouteInput.parse(raw); return localCommandReceipt(tx, actor, "connections.device.default", data.operationId, data, async () => {
    await tx.$queryRaw`SELECT id FROM "ConnectedDeviceLink" WHERE id=${data.linkId} FOR UPDATE`; const link = await tx.connectedDeviceLink.findFirst({ where: { id: data.linkId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } } }); if (!link || !link.deviceIds.includes(data.deviceId)) throw new AuthorizationError("Use an active link containing your requesting device.");
    const provider = await ownedProvider(tx, actor, data.providerId, data.expectedProviderRevision); if (!link.deviceIds.includes(provider.deviceId) || provider.integrationId !== data.integrationId || provider.revokedAt || provider.expiresAt.getTime() <= Date.now()) throw new AuthorizationError("Choose the exact active provider on one of your linked devices.");
    const versions = await actionVersions(tx, provider.allowedActionVersionIds, provider.integrationId); if (!versions.some(v => validateIntegrationAction(v.definition).effect === data.effect)) throw new AuthorizationError("The provider does not support this effect type.");
    const previous = link.defaults as unknown as { revision: number; routes: Array<{ deviceId: string; integrationId: string; effect: string; providerId: string; providerRevision: number }> }; if (previous.revision !== data.expectedRevision) throw error("Routing defaults changed. Reload before saving.", 409);
    const route = { deviceId: data.deviceId, integrationId: data.integrationId, effect: data.effect, providerId: provider.id, providerRevision: provider.revision }; const defaults = { revision: previous.revision + 1, routes: [...previous.routes.filter(r => r.deviceId !== route.deviceId || r.integrationId !== route.integrationId || r.effect !== route.effect), route] };
    await tx.connectedDeviceLink.update({ where: { id: link.id }, data: { defaults } }); await audit(tx, actor, "provider.default_saved", { linkId: link.id, ...route }); return { linkId: link.id, defaults, createsAuthority: false, failover: false };
  }); });
}
async function grantMatches(tx: Prisma.TransactionClient, grant: ProviderAccessGrant, actor: Principal, provider: ProviderConnection) {
  if (grant.revokedAt || grant.expiresAt.getTime() <= Date.now() || grant.providerId !== provider.id || grant.siteId !== actor.siteId || grant.issuerUserId !== provider.ownerUserId || grant.issuerSessionId !== provider.ownerSessionId) return false;
  const owner = await sessionPrincipal(tx, provider.ownerSessionId, siteOf(actor)); if (!owner || owner.userId !== provider.ownerUserId) return false;
  const grantee = grant.grantee as unknown as { kind: string; userId?: string; sessionId?: string; grantId?: string; roleId?: string };
  if (grantee.kind === "session") { if (actor.grantId || grantee.userId !== actor.userId || grantee.sessionId !== actor.sessionId) return false; }
  else if (grantee.kind === "oauth") { if (actor.grantId !== `oauth:${grantee.grantId}` || grantee.userId !== actor.userId || grantee.sessionId !== actor.sessionId) return false; }
  else if (grantee.kind === "warehouse_role") { const membership = await tx.warehouseMembership.findUnique({ where: { siteId_userId: { siteId: siteOf(actor), userId: actor.userId } }, include: { roles: { include: { role: true } } } }); if (!membership?.isActive || !membership.roles.some(r => r.roleId === grantee.roleId && r.role.isActive && (r.role.siteId === null || r.role.siteId === actor.siteId))) return false; }
  else return false;
  if (grant.deviceLinkId) { const link = await tx.connectedDeviceLink.findFirst({ where: { id: grant.deviceLinkId, userId: actor.userId, approvedByUserId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } } }); if (!link || actor.userId !== provider.ownerUserId || !link.deviceIds.includes(provider.deviceId)) return false; }
  for (const versionId of grant.actionVersionIds.filter(v => provider.allowedActionVersionIds.includes(v))) { const v = await tx.integrationActionVersion.findUnique({ where: { id: versionId } }); if (!v) continue; const record = await tx.integrationActionRecord.findFirst({ where: { id: v.actionId, enabled: true, publishedVersionId: v.id } }); const def = validateIntegrationAction(v.definition); if (record && grant.effects.includes(def.effect) && actor.capabilities.includes(def.requiredCapability as typeof CAPABILITIES[number]) && owner.capabilities.includes(def.requiredCapability as typeof CAPABILITIES[number])) return true; }
  return false;
}
export async function getConnectionStatus(p: Principal) {
  const stored = await prisma.$transaction(async tx => {
    const actor = await current(tx, p, "account.self");
    const membership = await tx.warehouseMembership.findUnique({ where: { siteId_userId: { siteId: siteOf(actor), userId: actor.userId } }, include: { roles: { include: { role: true } } } });
    const roleIds = membership?.isActive ? membership.roles.filter(r => r.role.isActive && (r.role.siteId === null || r.role.siteId === actor.siteId)).map(r => r.roleId) : [];
    const allGrants = await tx.providerAccessGrant.findMany({ where: { revokedAt: null, expiresAt: { gt: new Date() }, OR: [{ issuerUserId: actor.userId }, { grantee: { path: ["userId"], equals: actor.userId } }, ...roleIds.map(roleId => ({ grantee: { path: ["roleId"], equals: roleId } }))] }, orderBy: { createdAt: "desc" }, take: 501 });
    const providers = await tx.providerConnection.findMany({ where: { OR: [{ ownerUserId: actor.userId }, { id: { in: allGrants.map(g => g.providerId) } }] }, orderBy: { createdAt: "desc" }, take: 201 });
    const visible: Array<ProviderConnection & { access: string; ready: boolean; readinessReason: string }> = [];
    for (const provider of providers.slice(0, 200)) { const own = provider.ownerUserId === actor.userId; let shared = false; if (!own) for (const grant of allGrants.filter(g => g.providerId === provider.id)) if (await grantMatches(tx, grant, actor, provider)) { shared = true; break; } if (!own && !shared) continue; const ownerActive = await sessionPrincipal(tx, provider.ownerSessionId, siteOf(actor)); visible.push({ ...provider, upstreamIdentity: null, upstreamWarehouse: null, access: own ? "owner_status_only" : "explicit_share", ready: false, readinessReason: provider.revokedAt ? "Provider revoked." : !ownerActive ? "The original owning session ended or lost warehouse access. Reconnect that device." : provider.expiresAt.getTime() <= Date.now() ? "Provider lease expired. Reconnect the original device." : "Configured provider only. Transport, actual identity, upstream warehouse and named-action readiness are not qualified; no live adapter is dispatched." }); }
    const links = await tx.connectedDeviceLink.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: "desc" }, take: 100 });
    const defaults = await getTemplateSelectionDefaults(tx, actor);
    return { defaults, siteId: actor.siteId, truncated: providers.length > 200 || allGrants.length > 500, canManage: actor.capabilities.includes("integrations.manage"), canRegister: actor.capabilities.includes("providers.manage"), isPlatformAdmin: actor.isPlatformAdmin === true, providers: visible, grants: allGrants.filter(g => visible.some(v => v.id === g.providerId && v.ownerUserId === actor.userId)), links, legacyEligible: actor.capabilities.includes("workflow.read") };
  });
  let dmp: unknown = null, dmpError: string | null = null;
  if (stored.legacyEligible) try { dmp = await getDmpStatus(p); } catch { dmpError = "Existing DMP relay status is unavailable. Open DMP connection setup and reconnect; no other provider was selected."; }
  let active: Array<{providerId:string; authenticated:boolean; actionReady:boolean; identity: {subject:string;warehouse:string}|null; lastHeartbeatAt:number; leaseExpiresAt:number; blockedReason:string|null}> = [], genericError: string | null = null;
  try { const { genericProviderControl } = await import("./dispatch"); const live = await genericProviderControl(p, "list"); active = Array.isArray(live.connections) ? live.connections : []; }
  catch { genericError = "Approved-provider transport is unavailable. Reconnect the original tab; no queued work was rerouted."; }
  const providers = stored.providers.map(provider => { const actual = active.find(c => c.providerId === provider.id); return actual ? { ...provider, transportState: "connected", authenticationState: actual.authenticated ? "verified" : "checking", upstreamIdentity: actual.identity ? {subject:actual.identity.subject} : null, upstreamWarehouse: actual.identity ? {warehouse:actual.identity.warehouse} : null, heartbeatAt: new Date(actual.lastHeartbeatAt), expiresAt: new Date(actual.leaseExpiresAt), ready: actual.actionReady, readinessReason: actual.blockedReason || (actual.actionReady ? "Actual identity and warehouse verified; dispatch still rechecks the exact named action and current grant." : "Transport connected; identity or named-action readiness is pending. No action was authorized by status alone.") } : { ...provider, ready:false, transportState:"disconnected", readinessReason: provider.revokedAt ? "Provider revoked." : provider.runtimeConfigurationId ? (genericError || "Original upstream tab is disconnected or its lease ended. Run Connect on that exact approved page.") : provider.readinessReason }; });
  return { ...stored, providers, dmp, dmpError, genericError, reconnectUrl: "/tools/api-relay", liveGenericDispatchAvailable: providers.some(p => p.ready) };

}
export async function simulateConfiguredAction(p: Principal, raw: unknown) {
  const data = connectionSimulateInput.parse(raw);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, "workflow.read"), version = await tx.integrationActionVersion.findUnique({ where: { id: data.actionVersionId } }); if (!version) throw error("Action version not found in this warehouse.", 404); const record = await tx.integrationActionRecord.findFirst({ where: { id: version.actionId, enabled: true, publishedVersionId: version.id } }); if (!record) throw error("The pinned action version is disabled or no longer published.", 409); const definition = validateIntegrationAction(version.definition); validateActionInputs(definition, data.input); if (!actor.capabilities.includes(definition.requiredCapability as typeof CAPABILITIES[number])) throw new AuthorizationError(); return { execution: "simulation-only", actionVersionId: version.id, qualification: approvalOf(version)?.mode ?? "unqualified", request: mapActionRequest(definition, data.input, "SYNTHETIC_PREVIEW_WAREHOUSE"), ...(data.output === undefined ? {} : { fixtureOutput: validateActionOutput(definition, data.output) }), sent: false, physicalEffect: false, liveUnavailableReason: "No generic live adapter dispatch is enabled. This validates a synthetic request/response only; existing DMP named reads use their established relay and grants." }; });
}

export async function listProviderActions(p: Principal) {
  return prisma.$transaction(async tx => {
    await current(tx, p, p.capabilities.includes("providers.manage") ? "providers.manage" : "integrations.manage");
    const records = await tx.integrationActionRecord.findMany({ where: { enabled: true, publishedVersionId: { not: null } }, orderBy: { name: "asc" }, take: 200 });
    const actions = [];
    for (const record of records) {
      const version = await tx.integrationActionVersion.findFirst({ where: { id: record.publishedVersionId!, actionId: record.id } });
      if (version) actions.push({ id: record.id, name: record.name, revision: record.revision, enabled: true, publishedVersionId: version.id, draft: version.definition, versions: [{ id: version.id, version: version.version, definition: version.definition, contractApproval: null }] });
    }
    return { actions, limitation: "Published action versions only. Registration does not establish an upstream connection.", isPlatformAdmin: false };
  });
}
