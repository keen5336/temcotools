import { z } from "zod";
import { prisma } from "@/lib/db";
import type { SessionData } from "@/lib/session";
import { AuthError } from "./policy";
import { assertActor, legacyEnabled, lockAuthWrites } from "./sessions";
import { authAudit, ensureAnotherAdmin } from "./identity";

const selectUser = { id: true, username: true, displayName: true, role: true, isActive: true, lastLoginAt: true, createdAt: true, authVersion: true, passwordEnrolledAt: true, passwordChangedAt: true, legacyDisabledAt: true } as const;
export async function listManagedUsers(actor: SessionData, search = "") {
  return prisma.$transaction(async tx => {
    await assertActor(tx, actor, true);
    const users = await tx.user.findMany({ where: search ? { OR: [{ username: { contains: search.slice(0,80), mode: "insensitive" } }, { displayName: { contains: search.slice(0,80), mode: "insensitive" } }] } : {}, select: { ...selectUser, _count: { select: { authSessions: { where: { kind: "password", revokedAt: null, expiresAt: { gt: new Date() } } } } } }, orderBy: { createdAt: "desc" } });
    return { users, legacyLoginEnabled: await legacyEnabled(tx) };
  });
}
export async function createManagedUser(actor: SessionData, input: unknown) {
  const parsed = z.object({ username: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(100), role: z.enum(["user","manager","admin"]).default("user") }).strict().safeParse(input);
  if (!parsed.success) throw new AuthError("Provide a username, display name and valid role. New accounts use setup codes, not PINs.");
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); await assertActor(tx, actor, true, true);
    if (await tx.user.findUnique({ where: { username: parsed.data.username } })) throw new AuthError("Username already exists.", 409);
    const user = await tx.user.create({ data: { ...parsed.data, pinHash: "disabled:enrollment", legacyDisabledAt: new Date() }, select: selectUser });
    await authAudit(tx, "user_created", actor.userId, user.id, actor.sessionId); return user;
  });
}
export async function updateManagedUser(actor: SessionData, id: string, input: unknown) {
  const parsed = z.object({ expectedAuthVersion: z.number().int().positive(), username: z.string().trim().min(1).max(80).optional(), displayName: z.string().trim().min(1).max(100).optional(), role: z.enum(["user","manager","admin"]).optional(), isActive: z.boolean().optional(), revokeSessions: z.boolean().optional() }).strict().safeParse(input);
  if (!parsed.success) throw new AuthError("Provide current account version and valid fields. PIN sign-in cannot be restored; use setup or recovery codes.");
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); await assertActor(tx, actor, true, true);
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) throw new AuthError("User not found.", 404);
    if (target.authVersion !== parsed.data.expectedAuthVersion) throw new AuthError("This account changed. Reload before editing it.", 409);
    const data = parsed.data;
    if (target.role === "admin" && target.isActive && target.passwordHash && (data.isActive === false || (data.role && data.role !== "admin"))) await ensureAnotherAdmin(tx, id);
    if (data.username && await tx.user.findFirst({ where: { username: data.username, id: { not: id } } })) throw new AuthError("Username already exists.", 409);
    const invalidate = data.revokeSessions || (data.role !== undefined && data.role !== target.role) || (data.isActive !== undefined && data.isActive !== target.isActive) || (data.username !== undefined && data.username !== target.username);
    const user = await tx.user.update({ where: { id }, data: { ...(data.username ? { username: data.username } : {}), ...(data.displayName ? { displayName: data.displayName } : {}), ...(data.role ? { role: data.role } : {}), ...(data.isActive === undefined ? {} : { isActive: data.isActive }), ...(invalidate ? { authVersion: { increment: 1 } } : {}) }, select: selectUser });
    if (invalidate) {
      const at = new Date();
      await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: at } });
      await tx.accountCode.updateMany({ where: { userId: id, consumedAt: null }, data: { consumedAt: at } });
    }
    await authAudit(tx, "user_updated", actor.userId, id, actor.sessionId); return user;
  });
}
export async function setLegacyLoginPolicy(actor: SessionData, enabled: boolean) {
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); await assertActor(tx, actor, true, true);
    await tx.authPolicy.update({ where: { id: "global" }, data: { legacyLoginEnabled: enabled } });
    if (!enabled) await tx.authSession.updateMany({ where: { kind: "enrollment", revokedAt: null }, data: { revokedAt: new Date() } });
    await authAudit(tx, enabled ? "legacy_setup_enabled" : "legacy_setup_disabled", actor.userId, undefined, actor.sessionId);
    return { legacyLoginEnabled: enabled };
  });
}
