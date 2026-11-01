import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCapability, assertRecentAuthentication, AuthorizationError, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { dmpConfig } from "@/lib/api-relay/config";
import { PayloadError, payloadContentHash, payloadIdSchema, sourceChanges, validatePayloadDraft, type PayloadDraft, type PublishedPayloadVersion } from "./model";
import { payloadPreviewDocument } from "./types";
import { MARS_LABEL_PAYLOAD_ID } from "@/lib/mars-label-bookmarklet";

const versionSummary = { id: true, version: true, contentHash: true, publishedAt: true, publishedByUserId: true, note: true } as const;
function admin(principal: Principal, recent = false) {
  assertCapability(principal, "payloads.manage");
  if (principal.role !== "admin") throw new AuthorizationError("Payload source administration is restricted to system administrators.");
  if (recent) assertRecentAuthentication(principal);
}
async function currentAdmin(tx: Prisma.TransactionClient, principal: Principal, recent = false) {
  const current = await assertCurrentPrincipal(tx, principal, "payloads.manage", recent);
  admin(current);
  return current;
}
function contract(payloadId: string, draft: PayloadDraft) {
  if (payloadId === "dmp-relay" && draft.purpose !== "dmp_relay") throw new PayloadError("The default DMP loader must keep its DMP relay purpose.");
  if (payloadId === MARS_LABEL_PAYLOAD_ID && draft.purpose !== "mars_label_helper") throw new PayloadError("The default MARS detail loader must keep its MARS helper purpose.");
  if (draft.purpose === "mars_label_helper" && draft.operationNames.length) throw new PayloadError("MARS label helpers do not grant upstream mutation operations.");
  if (draft.purpose === "dmp_relay") {
    const known = dmpConfig().operations;
    if (draft.operationNames.some(name => !Object.hasOwn(known, name))) throw new PayloadError("Declare only named operations already configured on the server.");
  }
}
function id(value: string) { const parsed = payloadIdSchema.safeParse(value); if (!parsed.success) throw new PayloadError("Invalid payload ID."); return parsed.data; }
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new PayloadError("A current revision is required."); return value; }
function note(value: unknown) { if (typeof value !== "string" || !value.trim() || value.trim().length > 500) throw new PayloadError("Enter an audit note of at most 500 characters."); return value.trim(); }
async function lockPayload(tx: Prisma.TransactionClient, payloadId: string, expectedRevision: number) {
  await tx.$queryRaw`SELECT id FROM "Payload" WHERE id = ${payloadId} FOR UPDATE`;
  const payload = await tx.payload.findUnique({ where: { id: payloadId } });
  if (!payload) throw new PayloadError("Payload not found.", 404);
  if (payload.revision !== expectedRevision) throw new PayloadError("This payload changed. Reload and review the current revision before saving.", 409);
  return payload;
}
export async function listPayloads(principal: Principal) {
  admin(principal);
  return prisma.payload.findMany({ select: { id: true, name: true, purpose: true, targetOrigins: true, enabled: true, revision: true, publishedVersionId: true, updatedAt: true, updatedByUserId: true }, orderBy: { name: "asc" } });
}
export async function getBuiltinPayloadSources(principal: Principal, fallbackOrigin?: string) {
  await prisma.$transaction(tx => currentAdmin(tx, principal));
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || process.env.API_RELAY_PUBLIC_ORIGIN || fallbackOrigin || "http://localhost:3000").origin;
  const { builtinDmpSource, builtinMarsLabelSource } = await import("./builtin");
  return { builtinDmp: builtinDmpSource(origin), builtinMarsLabel: builtinMarsLabelSource(origin) };
}
export async function getPayload(principal: Principal, payloadId: string) {
  admin(principal);
  const payload = await prisma.payload.findUnique({ where: { id: id(payloadId) }, include: { publishedVersion: true, versions: { select: versionSummary, orderBy: { version: "desc" }, take: 50 }, audits: { orderBy: { createdAt: "desc" }, take: 100 } } });
  if (!payload) throw new PayloadError("Payload not found.", 404);
  return { ...payload, changes: sourceChanges(payload.publishedVersion?.source ?? "", payload.draftSource) };
}
export async function getPayloadVersion(principal: Principal, payloadId: string, versionId: string) {
  admin(principal);
  if (typeof versionId !== "string" || !versionId || versionId.length > 100) throw new PayloadError("Invalid version ID.");
  const version = await prisma.payloadVersion.findFirst({ where: { id: versionId, payloadId: id(payloadId) } });
  if (!version) throw new PayloadError("Version not found.", 404);
  return version;
}
export async function listPayloadVersions(principal: Principal, payloadId: string, beforeVersion?: number) {
  admin(principal);
  if (beforeVersion !== undefined && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) throw new PayloadError("Invalid version cursor.");
  const versions = await prisma.payloadVersion.findMany({ where: { payloadId: id(payloadId), ...(beforeVersion === undefined ? {} : { version: { lt: beforeVersion } }) }, select: versionSummary, orderBy: { version: "desc" }, take: 51 });
  return { versions: versions.slice(0, 50), nextBeforeVersion: versions.length > 50 ? versions[49].version : null };
}
export function previewPayloadDraft(principal: Principal, input: unknown) {
  admin(principal);
  const draft = validatePayloadDraft(input);
  return { valid: true, contentHash: payloadContentHash(draft), previewHtml: payloadPreviewDocument(draft.source), limitations: "Syntax and synthetic DOM preview only. No external session, network or live relay authority; actual-device/upstream qualification remains separate." };
}
export async function createPayload(principal: Principal, input: PayloadDraft & { id: string; note: string }) {
  admin(principal, true);
  const payloadId = id(input.id), draft = validatePayloadDraft(input), auditNote = note(input.note);
  contract(payloadId, draft);
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal, true);
    if (await tx.payload.findUnique({ where: { id: payloadId }, select: { id: true } })) throw new PayloadError("That stable payload ID already exists.", 409);
    const payload = await tx.payload.create({ data: { id: payloadId, name: draft.name, purpose: draft.purpose, targetOrigins: draft.targetOrigins, draftSource: draft.source, protocolVersion: draft.protocolVersion, operationNames: draft.operationNames, createdByUserId: principal.userId, updatedByUserId: principal.userId } });
    await tx.payloadAudit.create({ data: { payloadId, actorUserId: principal.userId, action: "created", revision: payload.revision, note: auditNote } });
    return payload;
  });
}
export async function savePayloadDraft(principal: Principal, input: PayloadDraft & { id: string; expectedRevision: number; note: string }) {
  admin(principal);
  const payloadId = id(input.id), expectedRevision = revision(input.expectedRevision), draft = validatePayloadDraft(input), auditNote = note(input.note);
  contract(payloadId, draft);
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal);
    const current = await lockPayload(tx, payloadId, expectedRevision);
    if (current.purpose !== draft.purpose || JSON.stringify(current.targetOrigins) !== JSON.stringify(draft.targetOrigins) || current.protocolVersion !== draft.protocolVersion || JSON.stringify(current.operationNames) !== JSON.stringify(draft.operationNames)) {
      await currentAdmin(tx, principal, true);
    }
    const payload = await tx.payload.update({ where: { id: payloadId }, data: { name: draft.name, purpose: draft.purpose, targetOrigins: draft.targetOrigins, draftSource: draft.source, protocolVersion: draft.protocolVersion, operationNames: draft.operationNames, updatedByUserId: principal.userId, revision: { increment: 1 } } });
    await tx.payloadAudit.create({ data: { payloadId, actorUserId: principal.userId, action: "draft_saved", revision: payload.revision, note: auditNote } });
    return payload;
  });
}
export async function publishPayload(principal: Principal, input: { id: string; expectedRevision: number; note: string; reviewedNoSecrets: boolean }) {
  admin(principal, true);
  const payloadId = id(input.id), expectedRevision = revision(input.expectedRevision), auditNote = note(input.note);
  if (input.reviewedNoSecrets !== true) throw new PayloadError("Review the source for credentials/customer data before publication.");
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal, true);
    const current = await lockPayload(tx, payloadId, expectedRevision);
    const draft = validatePayloadDraft({ name: current.name, purpose: current.purpose, targetOrigins: current.targetOrigins, source: current.draftSource, protocolVersion: current.protocolVersion, operationNames: current.operationNames });
    contract(payloadId, draft);
    const latest = await tx.payloadVersion.findFirst({ where: { payloadId }, orderBy: { version: "desc" }, select: { version: true } });
    const published = await tx.payloadVersion.create({ data: { payloadId, version: (latest?.version ?? 0) + 1, purpose: draft.purpose, targetOrigins: draft.targetOrigins, source: draft.source, protocolVersion: draft.protocolVersion, operationNames: draft.operationNames, contentHash: payloadContentHash(draft), publishedByUserId: principal.userId, note: auditNote } });
    const payload = await tx.payload.update({ where: { id: payloadId }, data: { publishedVersionId: published.id, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.payloadAudit.create({ data: { payloadId, actorUserId: principal.userId, action: "published", revision: payload.revision, versionId: published.id, note: auditNote } });
    return { payload, published };
  });
}
export async function rollbackPayload(principal: Principal, input: { id: string; expectedRevision: number; versionId: string; note: string }) {
  admin(principal, true);
  const payloadId = id(input.id), expectedRevision = revision(input.expectedRevision), auditNote = note(input.note);
  if (typeof input.versionId !== "string" || !input.versionId || input.versionId.length > 100) throw new PayloadError("Choose a valid published version ID.");
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal, true);
    await lockPayload(tx, payloadId, expectedRevision);
    const version = await tx.payloadVersion.findFirst({ where: { id: input.versionId, payloadId } });
    if (!version) throw new PayloadError("Choose a published version of this payload.", 404);
    const payload = await tx.payload.update({ where: { id: payloadId }, data: { publishedVersionId: version.id, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.payloadAudit.create({ data: { payloadId, actorUserId: principal.userId, action: "rolled_back", revision: payload.revision, versionId: version.id, note: auditNote } });
    return payload;
  });
}
export async function setPayloadEnabled(principal: Principal, input: { id: string; expectedRevision: number; enabled: boolean; note: string }) {
  admin(principal, true);
  const payloadId = id(input.id), expectedRevision = revision(input.expectedRevision), auditNote = note(input.note);
  if (typeof input.enabled !== "boolean") throw new PayloadError("Choose enabled or disabled.");
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal, true);
    await lockPayload(tx, payloadId, expectedRevision);
    const payload = await tx.payload.update({ where: { id: payloadId }, data: { enabled: input.enabled, revision: { increment: 1 }, updatedByUserId: principal.userId } });
    await tx.payloadAudit.create({ data: { payloadId, actorUserId: principal.userId, action: input.enabled ? "enabled" : "disabled", revision: payload.revision, note: auditNote } });
    return payload;
  });
}
export type PublishedPayloadResolution = { state: "absent" | "unpublished" | "disabled" } | { state: "published"; version: PublishedPayloadVersion };
export async function resolvePublishedPayload(payloadId: string): Promise<PublishedPayloadResolution> {
  const payload = await prisma.payload.findUnique({ where: { id: id(payloadId) }, include: { publishedVersion: true } });
  if (!payload) return { state: "absent" };
  if (!payload.enabled) return { state: "disabled" };
  if (!payload.publishedVersion) return { state: "unpublished" };
  return { state: "published", version: payload.publishedVersion as PublishedPayloadVersion };
}
export async function getPublishedVersion(payloadId: string, versionId: string, hash: string): Promise<PublishedPayloadVersion> {
  if (typeof versionId !== "string" || !versionId || versionId.length > 100 || !/^[a-f0-9]{64}$/.test(hash)) throw new PayloadError("Published version not found.", 404);
  const payload = await prisma.payload.findUnique({ where: { id: id(payloadId) }, select: { enabled: true } });
  if (!payload?.enabled) throw new PayloadError("Payload is unavailable.", 404);
  const version = await prisma.payloadVersion.findFirst({ where: { id: versionId, payloadId, contentHash: hash } });
  if (!version) throw new PayloadError("Published version not found.", 404);
  return version as PublishedPayloadVersion;
}
