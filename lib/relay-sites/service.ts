import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, assertRecentAuthentication, AuthorizationError, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { payloadIdSchema, type PublishedPayloadVersion } from "@/lib/payloads/model";
import { chooseSiteProfile, exactSiteOrigin, exactSitePath, siteLocationInput, siteProfileBindingInput, siteProfileId, siteProfilesOverlap, sitePurpose, SiteProfileError, validateSiteLocation, type SiteProfileBinding } from "./types";
import { assertSiteProfileSourceContract } from "./contract";

const auditNote = z.string().trim().min(1).max(500);
const profileFields = { id: siteProfileId, name: z.string().trim().min(1).max(100), origin: z.string().max(300), pathPrefix: z.string().max(512).default("/"), purpose: sitePurpose, payloadId: payloadIdSchema, enabled: z.boolean().default(false), note: auditNote };
export const siteProfilesListInput = z.object({ afterId: siteProfileId.optional(), includeRemoved: z.boolean().default(false) }).strict();
export const siteProfileSaveInput = z.object({ ...profileFields, expectedRevision: z.number().int().positive().nullable().describe("null only for creation; the exact current revision is mandatory for updates."), restoreRemoved: z.boolean().default(false) }).strict();
export const siteProfileEnabledInput = z.object({ id: siteProfileId, expectedRevision: z.number().int().positive(), enabled: z.boolean(), note: auditNote }).strict();
export const siteProfileRemoveInput = z.object({ id: siteProfileId, expectedRevision: z.number().int().positive(), note: auditNote }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const value = schema.safeParse(input); if (!value.success) throw new SiteProfileError("Provide the exact profile fields, current revision and an audit note."); return value.data; }
function admin(principal: Principal, recent = false) { assertCapability(principal, "payloads.manage"); if (principal.role !== "admin") throw new AuthorizationError("Site mappings are restricted to system administrators."); if (recent) assertRecentAuthentication(principal); }
async function currentAdmin(tx: Prisma.TransactionClient, principal: Principal, recent = false) { const current = await assertCurrentPrincipal(tx, principal, "payloads.manage", recent); admin(current); return current; }
async function profileLock(tx: Prisma.TransactionClient) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110118)`; }
async function target(tx: Prisma.TransactionClient, id: string, expectedRevision: number) {
  await tx.$queryRaw`SELECT id FROM "SiteProfile" WHERE id=${id} FOR UPDATE`;
  const profile = await tx.siteProfile.findUnique({ where: { id } });
  if (!profile) throw new SiteProfileError("Site profile not found.", 404);
  if (profile.revision !== expectedRevision) throw new SiteProfileError("This mapping changed. Reload its current revision before saving.", 409);
  return profile;
}
async function audit(tx: Prisma.TransactionClient, actor: Principal, profile: { id: string; revision: number }, action: string, note: string) {
  await tx.identityAudit.create({ data: { actorUserId: actor.userId, sessionId: actor.sessionId, action, reason: `Site profile ${profile.id} revision ${profile.revision}: ${note}` } });
}
async function validPayload(tx: Prisma.TransactionClient, input: { payloadId: string; purpose: string; origin: string; enabled: boolean }) {
  const payload = await tx.payload.findUnique({ where: { id: input.payloadId }, select: { id: true, enabled: true, publishedVersion: { select: { purpose: true, targetOrigins: true, protocolVersion: true, source: true } } } });
  if (!payload) throw new SiteProfileError("Choose an existing managed payload; source stays in the payload manager.", 404);
  if (input.enabled && (!payload.enabled || !payload.publishedVersion || payload.publishedVersion.purpose !== input.purpose || !payload.publishedVersion.targetOrigins.includes(input.origin) || payload.publishedVersion.protocolVersion !== 1)) throw new SiteProfileError("Enable only an available published version with matching system purpose and exact target origin.", 409);
  if (input.enabled && payload.publishedVersion) assertSiteProfileSourceContract(input.purpose, payload.publishedVersion.source);
}
export async function listSiteProfiles(principal: Principal, input: unknown = {}) {
  admin(principal); const parsed = parse(siteProfilesListInput, input);
  return prisma.$transaction(async tx => {
    await currentAdmin(tx, principal);
    const rows = await tx.siteProfile.findMany({ where: { ...(parsed.includeRemoved ? {} : { removedAt: null }), ...(parsed.afterId ? { id: { gt: parsed.afterId } } : {}) }, orderBy: { id: "asc" }, take: 51 });
    const payloads = await tx.payload.findMany({ select: { id: true, name: true, purpose: true, enabled: true, publishedVersion: { select: { purpose: true, targetOrigins: true, version: true } } }, orderBy: { id: "asc" }, take: 201 });
    return { profiles: rows.slice(0, 50), nextAfterId: rows.length > 50 ? rows[49].id : null, payloads: payloads.slice(0, 200), payloadSelectionIncomplete: payloads.length > 200 };
  });
}
export async function saveSiteProfile(principal: Principal, input: unknown) {
  admin(principal, true); const parsed = parse(siteProfileSaveInput, input);
  const origin = exactSiteOrigin(parsed.origin), pathPrefix = exactSitePath(parsed.pathPrefix || "/", true);
  return prisma.$transaction(async tx => {
    const actor = await currentAdmin(tx, principal, true); await profileLock(tx);
    const existing = parsed.expectedRevision === null ? await tx.siteProfile.findUnique({ where: { id: parsed.id } }) : await target(tx, parsed.id, parsed.expectedRevision);
    if (parsed.expectedRevision === null && existing) throw new SiteProfileError("That stable profile ID already exists. Load its current revision.", 409);
    if (existing?.removedAt && !parsed.restoreRemoved) throw new SiteProfileError("This removed mapping is a safety tombstone. Explicitly restore it before changing or enabling it.", 409);
    const others = await tx.siteProfile.findMany({ where: { origin, id: { not: parsed.id } }, take: 65, select: { origin: true, pathPrefix: true } });
    if (others.length >= 64 || others.some(profile => siteProfilesOverlap(profile, { origin, pathPrefix }))) throw new SiteProfileError("This origin/path overlaps another mapping, including disabled/removed mappings. Edit or explicitly restore that mapping; no priority/fallback is inferred.", 409, "site_overlap");
    await validPayload(tx, { ...parsed, origin });
    const data = { name: parsed.name, origin, pathPrefix, purpose: parsed.purpose, payloadId: parsed.payloadId, enabled: parsed.enabled, removedAt: null, updatedByUserId: actor.userId };
    const saved = existing ? await tx.siteProfile.update({ where: { id: parsed.id }, data: { ...data, revision: { increment: 1 } } }) : await tx.siteProfile.create({ data: { ...data, id: parsed.id, createdByUserId: actor.userId } });
    await audit(tx, actor, saved, existing ? existing.removedAt ? "site_profile_restored" : "site_profile_saved" : "site_profile_created", parsed.note);
    return saved;
  });
}
export async function setSiteProfileEnabled(principal: Principal, input: unknown) {
  admin(principal, true); const parsed = parse(siteProfileEnabledInput, input);
  return prisma.$transaction(async tx => {
    const actor = await currentAdmin(tx, principal, true); await profileLock(tx); const current = await target(tx, parsed.id, parsed.expectedRevision);
    if (current.removedAt) throw new SiteProfileError("Explicitly restore the removed mapping before enabling it.", 409);
    await validPayload(tx, { ...current, enabled: parsed.enabled });
    const saved = await tx.siteProfile.update({ where: { id: current.id }, data: { enabled: parsed.enabled, revision: { increment: 1 }, updatedByUserId: actor.userId } });
    await audit(tx, actor, saved, parsed.enabled ? "site_profile_enabled" : "site_profile_disabled", parsed.note); return saved;
  });
}
export async function removeSiteProfile(principal: Principal, input: unknown) {
  admin(principal, true); const parsed = parse(siteProfileRemoveInput, input);
  return prisma.$transaction(async tx => {
    const actor = await currentAdmin(tx, principal, true); await profileLock(tx); const current = await target(tx, parsed.id, parsed.expectedRevision);
    const saved = await tx.siteProfile.update({ where: { id: current.id }, data: { enabled: false, removedAt: new Date(), revision: { increment: 1 }, updatedByUserId: actor.userId } });
    await audit(tx, actor, saved, "site_profile_removed", parsed.note); return saved;
  });
}
const profileVersion = { id: true, payloadId: true, version: true, contentHash: true, purpose: true, targetOrigins: true, source: true, protocolVersion: true, operationNames: true } as const;
export async function resolveSitePayload(input: unknown) {
  const location = validateSiteLocation(input);
  const profiles = await prisma.siteProfile.findMany({ where: { origin: location.origin }, take: 65 });
  const profile = chooseSiteProfile(profiles, location);
  const payload = await prisma.payload.findUnique({ where: { id: profile.payloadId }, select: { enabled: true, publishedVersion: { select: profileVersion } } });
  const version = payload?.publishedVersion;
  if (!payload?.enabled || !version || version.purpose !== profile.purpose || !version.targetOrigins.includes(location.origin) || version.protocolVersion !== 1) throw new SiteProfileError("The mapped adapter has no available matching published version. No builtin or other adapter was selected.", 404, "site_unpublished");
  assertSiteProfileSourceContract(profile.purpose, version.source);
  const profileBinding: SiteProfileBinding = { profileId: profile.id, revision: profile.revision, origin: profile.origin, pathname: location.pathname, pathPrefix: profile.pathPrefix, payloadId: version.payloadId, versionId: version.id, contentHash: version.contentHash };
  return { profileBinding, version: version as PublishedPayloadVersion };
}
export async function verifySiteProfileBinding(input: unknown, reference: { payloadId: string; versionId: string; contentHash: string }, origin: string, requiredPurpose: string) {
  const parsed = siteProfileBindingInput.safeParse(input);
  if (!parsed.success) throw new SiteProfileError("Invalid site-profile binding. Reload Connect Temco.", 403);
  const binding = parsed.data, location = validateSiteLocation({ origin: binding.origin, pathname: binding.pathname });
  const profiles = await prisma.siteProfile.findMany({ where: { origin: location.origin }, take: 65 });
  const current = chooseSiteProfile(profiles, location);
  if (binding.origin !== origin || current.id !== binding.profileId || current.revision !== binding.revision || current.pathPrefix !== binding.pathPrefix || current.purpose !== requiredPurpose || current.payloadId !== reference.payloadId || binding.payloadId !== reference.payloadId || binding.versionId !== reference.versionId || binding.contentHash !== reference.contentHash) throw new SiteProfileError("Site mapping or pinned adapter changed/was disabled. Reconnect; queued work was not dispatched.", 403, "site_binding_changed");
  const payload = await prisma.payload.findUnique({ where: { id: current.payloadId }, select: { enabled: true, publishedVersion: { select: { purpose: true, targetOrigins: true, protocolVersion: true, source: true } } } });
  if (!payload?.enabled || payload.publishedVersion?.purpose !== requiredPurpose || !payload.publishedVersion.targetOrigins.includes(origin) || payload.publishedVersion.protocolVersion !== 1) throw new SiteProfileError("The current published adapter no longer permits this system/origin. Queued work was not dispatched.", 403, "site_adapter_changed");
  assertSiteProfileSourceContract(requiredPurpose, payload.publishedVersion.source);
  return binding;
}
export { siteLocationInput };
