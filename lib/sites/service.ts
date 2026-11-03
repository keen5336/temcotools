import { assertTemplateSiteConfiguration } from "@/lib/templates/service";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { CAPABILITIES, AuthorizationError, type Principal } from "@/lib/auth/principal";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import type { Prisma } from "@prisma/client";

const id = z.string().trim().min(1).max(200);
const operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,150}$/);
const forbidden = new Set(["platform.manage", "users.manage", "payloads.manage", "account.self"]);
export const switchSiteInput = z.object({ siteId: id });
export const createSiteInput = z.object({ operationId, slug: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/), name: z.string().trim().min(1).max(100) });
export const siteConfigurationInput = z.object({ operationId, expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100), configuration: z.object({ timezone: z.string().max(80).optional(), locations: z.array(z.string().trim().min(1).max(100)).max(200).default([]), defaultWorkflowId: id.nullable().optional(), defaultPrinterId: id.nullable().optional() }).strict() });
export const saveMembershipInput = z.object({ operationId, userId: id, expectedRevision: z.number().int().nonnegative(), isActive: z.boolean(), roleIds: z.array(id).max(20) });
export const saveSiteRoleInput = z.object({ operationId, id: id.optional(), expectedRevision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), isActive: z.boolean().default(true), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length) });
const conflict = () => Object.assign(new Error("This warehouse configuration changed. Reload before saving."), { status: 409 });
function siteOf(p: Principal) { if (!p.siteId) throw new AuthorizationError("Select an authorized warehouse."); return p.siteId; }
async function audit(tx: Prisma.TransactionClient, p: Principal, action: string, reason: string) {
  await tx.identityAudit.create({ data: { siteId: siteOf(p), actorUserId: p.userId, sessionId: p.sessionId, action, reason } });
}
async function delegation(tx: Prisma.TransactionClient, p: Principal) {
  // The pilot effect mask still governs execution. It does not erase a human
  // manager's stored delegation when editing a warehouse role for later use.
  if (p.grantId) return p.capabilities;
  if (p.isPlatformAdmin) return CAPABILITIES;
  const membership = await tx.warehouseMembership.findUnique({ where: { siteId_userId: { siteId: siteOf(p), userId: p.userId } }, include: { roles: { include: { role: true } } } });
  return membership?.isActive ? membership.roles.filter(r => r.role.isActive && (r.role.siteId === null || r.role.siteId === p.siteId)).flatMap(r => r.role.capabilities) : [];
}
async function delegable(tx: Prisma.TransactionClient, p: Principal, capabilities: readonly string[]) {
  const allowed = await delegation(tx, p);
  if (capabilities.some(cap => forbidden.has(cap) || !allowed.includes(cap as typeof CAPABILITIES[number]))) throw new AuthorizationError("Warehouse roles cannot grant platform control or access beyond your current delegation.");
}
export async function listMySites(p: Principal) {
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "account.self");
    return { activeSiteId: current.siteId ?? null, isPlatformAdmin: current.isPlatformAdmin === true, sites: await tx.warehouseSite.findMany({ where: { isActive: true, ...(current.isPlatformAdmin ? {} : { memberships: { some: { userId: current.userId, isActive: true } } }) }, select: { id: true, name: true, slug: true, revision: true }, orderBy: { name: "asc" } }) };
  });
}
export async function switchSite(p: Principal, input: unknown) {
  const data = switchSiteInput.parse(input);
  if (p.grantId) throw new AuthorizationError("Client grants stay pinned to their original warehouse. Connect a separately scoped grant for another warehouse.");
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "account.self");
    const site = await tx.warehouseSite.findFirst({ where: { id: data.siteId, isActive: true, ...(current.isPlatformAdmin ? {} : { memberships: { some: { userId: current.userId, isActive: true } } }) }, select: { id: true, name: true } });
    if (!site) throw new AuthorizationError("You do not have active access to this warehouse.");
    await tx.userSession.update({ where: { id: current.sessionId }, data: { activeSiteId: site.id } });
    return { site, reload: true, message: "New pages use this warehouse. Existing pages, client grants and runs retain their original warehouse." };
  });
}
export async function createSite(p: Principal, input: unknown) {
  const data = createSiteInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "platform.manage", true);
    if (!current.isPlatformAdmin) throw new AuthorizationError();
    return localCommandReceipt(tx, current, "sites.create", data.operationId, data, async () => {
      const site = await tx.warehouseSite.create({ data: { slug: data.slug, name: data.name } });
      await audit(tx, current, "site_created", site.id);
      return site;
    });
  });
}
export async function getSiteAdministration(p: Principal) {
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "sites.configure"), siteId = siteOf(current);
    const site = await tx.warehouseSite.findUniqueOrThrow({ where: { id: siteId } });
    const roles = await tx.warehouseRole.findMany({ where: { OR: [{ siteId }, { siteId: null, isTemplate: true }] }, orderBy: { name: "asc" } });
    const members = await tx.warehouseMembership.findMany({ where: { siteId }, select: { id: true, userId: true, revision: true, isActive: true, user: { select: { username: true, displayName: true, isPlatformAdmin: true } }, roles: { select: { roleId: true } } }, orderBy: { createdAt: "asc" } });
    return { site, roles, members, delegableCapabilities: (await delegation(tx, current)).filter(cap => !forbidden.has(cap)), canManageMembers: current.capabilities.includes("sites.members.manage"), isPlatformAdmin: current.isPlatformAdmin === true };
  });
}
export async function saveSiteConfiguration(p: Principal, input: unknown) {
  const data = siteConfigurationInput.parse(input);
  if (data.configuration.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: data.configuration.timezone }).format(); } catch { throw new Error("Choose a valid IANA timezone."); } }
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "sites.configure", true), siteId = siteOf(current);
    return localCommandReceipt(tx, current, "sites.configuration.save", data.operationId, data, async () => {
      await tx.$queryRaw`SELECT id FROM "WarehouseSite" WHERE id=${siteId} FOR UPDATE`;
      await assertTemplateSiteConfiguration(tx, current, data.configuration);
      // A default is a reference, never authority to access another site's device/run.
      if (data.configuration.defaultPrinterId && !await tx.labelPrinter.findUnique({ where: { id: data.configuration.defaultPrinterId } })) throw new AuthorizationError("Choose a printer from this warehouse.");
      if (data.configuration.defaultWorkflowId && !await tx.labelWorkflow.findFirst({ where: { purpose: data.configuration.defaultWorkflowId } })) throw new AuthorizationError("Choose a workflow from this warehouse.");
      const saved = await tx.warehouseSite.updateMany({ where: { id: siteId, revision: data.expectedRevision }, data: { name: data.name, configuration: data.configuration, revision: { increment: 1 } } });
      if (!saved.count) throw conflict();
      await audit(tx, current, "site_configuration_saved", `revision ${data.expectedRevision + 1}`);
      return tx.warehouseSite.findUniqueOrThrow({ where: { id: siteId } });
    });
  });
}
export async function saveMembership(p: Principal, input: unknown) {
  const data = saveMembershipInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "sites.members.manage", true), siteId = siteOf(current);
    return localCommandReceipt(tx, current, "sites.membership.save", data.operationId, data, async () => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`site-membership:${siteId}:${data.userId}`},0))`;
      const target = await tx.user.findUnique({ where: { id: data.userId }, select: { id: true, isActive: true, isPlatformAdmin: true } });
      // Local managers identify an existing person by exact username; they never enumerate other sites' people.
      if (!target?.isActive) throw new AuthorizationError("Choose an existing active person.");
      if (target.isPlatformAdmin && !current.isPlatformAdmin) throw new AuthorizationError("Platform administrator membership is protected.");
      await tx.$queryRaw`SELECT id FROM "WarehouseMembership" WHERE "siteId"=${siteId} AND "userId"=${data.userId} FOR UPDATE`;
      const existing = await tx.warehouseMembership.findUnique({ where: { siteId_userId: { siteId, userId: data.userId } }, include: { roles: { include: { role: true } } } });
      if ((existing?.revision ?? 0) !== data.expectedRevision) throw conflict();
      // Cannot remove or replace a stronger local role through a narrow client.
      if (existing) await delegable(tx, current, existing.roles.flatMap(link => link.role.capabilities));
      const ids = [...new Set(data.roleIds)];
      const roles = await tx.warehouseRole.findMany({ where: { id: { in: ids }, isActive: true, OR: [{ siteId }, { siteId: null, isTemplate: true }] } });
      if (roles.length !== ids.length) throw new AuthorizationError("Choose active roles available to this warehouse.");
      await delegable(tx, current, roles.flatMap(role => role.capabilities));
      const member = existing ? await tx.warehouseMembership.update({ where: { id: existing.id }, data: { isActive: data.isActive, revision: { increment: 1 } } }) : await tx.warehouseMembership.create({ data: { siteId, userId: data.userId, isActive: data.isActive } });
      await tx.warehouseMembershipRole.deleteMany({ where: { membershipId: member.id } });
      await tx.warehouseMembershipRole.createMany({ data: ids.map(roleId => ({ membershipId: member.id, roleId })) });
      await audit(tx, current, "site_membership_saved", `${member.id}; revision ${member.revision}`);
      return member;
    });
  });
}
export const findSitePersonInput = z.object({ username: z.string().trim().min(1).max(100) });
export async function findSitePerson(p: Principal, input: unknown) {
  const data = findSitePersonInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "sites.members.manage");
    const user = await tx.user.findFirst({ where: { username: { equals: data.username, mode: "insensitive" }, isActive: true, ...(current.isPlatformAdmin ? {} : { isPlatformAdmin: false }) }, select: { id: true, username: true, displayName: true } });
    return { user };
  });
}
export async function saveSiteRole(p: Principal, input: unknown) {
  const data = saveSiteRoleInput.parse(input);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, p, "sites.members.manage", true), siteId = siteOf(current);
    return localCommandReceipt(tx, current, "sites.role.save", data.operationId, data, async () => {
      await delegable(tx, current, data.capabilities);
      const existing = data.id ? await tx.warehouseRole.findFirst({ where: { id: data.id, siteId, isTemplate: false } }) : null;
      if (data.id && !existing) throw new AuthorizationError("Platform templates and other warehouse roles are protected. Create a local role.");
      if ((existing?.revision ?? 0) !== data.expectedRevision) throw conflict();
      if (existing) { await delegable(tx, current, existing.capabilities); await tx.$queryRaw`SELECT id FROM "WarehouseRole" WHERE id=${existing.id} FOR UPDATE`; }
      const values = { name: data.name, capabilities: [...new Set(data.capabilities)], isActive: data.isActive };
      const role = existing ? await tx.warehouseRole.update({ where: { id: existing.id, revision: data.expectedRevision }, data: { ...values, revision: { increment: 1 } } }) : await tx.warehouseRole.create({ data: { ...values, siteId } });
      await audit(tx, current, "site_role_saved", `${role.id}; revision ${role.revision}`);
      return role;
    });
  });
}
