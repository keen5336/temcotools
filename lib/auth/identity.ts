import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  assertCapability, assertRecentAuthentication, AuthorizationError, CAPABILITIES,
  CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal,
  SESSION_IDLE_MS, SESSION_MAX_AGE_MS, type Capability, type Principal, type SessionClaim,
} from "./principal";
import { hashPassword, IdentityError, validatePassword, verifyPassword } from "./passwords";
import { assertOAuthGrant } from "@/lib/oauth/grants";

export { IdentityError } from "./passwords";
const publicUser = {
  id: true, username: true, displayName: true, role: true, isActive: true,
  lastLoginAt: true, createdAt: true, passwordChangedAt: true,
  roleBundles: { select: { bundle: { select: { id: true, name: true, capabilities: true } } } },
} as const;
const idSchema = z.string().min(1).max(200);
const usernameSchema = z.string().trim().min(1).max(80);
const NEUTRAL_RECOVERY = "If this account can recover, authorized office staff can arrange a one-use recovery code. No email has been sent.";
export type IdentityContext = { source: string };

function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function sourceHash(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new IdentityError("Identity service is unavailable.", 503);
  return createHmac("sha256", secret).update(value.slice(0, 300)).digest("hex");
}

async function audit(tx: Prisma.TransactionClient, action: string, data: {
  actorUserId?: string; targetUserId?: string; sessionId?: string; sourceHash?: string; reason?: string;
} = {}) {
  await tx.identityAudit.create({ data: { action, ...data } });
}

async function ensureRecoveryAdministrator(tx: Prisma.TransactionClient) {
  const administrators = await tx.user.findMany({
    where: { role: "admin", isActive: true, passwordHash: { not: null } },
    select: { roleBundles: { select: { bundle: { select: { capabilities: true } } } } },
  });
  if (!administrators.some((user) => user.roleBundles.some(({ bundle }) => bundle.capabilities.includes("users.manage")))) {
    throw new IdentityError("Keep an enrolled active system administrator with user-management access for recovery.");
  }
}

// Atomic persisted counters serialize repeated attempts across processes. Both
// account and source budgets apply; no caller-controlled source can bypass the
// account budget. Hashes, rather than raw addresses/usernames, are retained.
export async function consumeIdentityBudget(kind: "login" | "recover" | "redeem" | "reauth" | "mfa", subject: string, context: IdentityContext) {
  const at = new Date();
  const windowMs = kind === "recover" || kind === "redeem" ? 60 * 60_000 : 15 * 60_000;
  const limit = kind === "recover" ? 6 : 12;
  const buckets = [
    { key: sourceHash(`${kind}:subject:${subject.trim().toLowerCase()}`), max: limit },
    { key: sourceHash(`${kind}:source:${context.source}`), max: limit * 10 },
  ];
  let exceeded = false;
  await prisma.$transaction(async (tx) => {
    for (const bucket of buckets) {
      const rows = await tx.$queryRaw<{ attempts: number }[]>`
        INSERT INTO "AuthRateLimit" (key, "windowStart", attempts) VALUES (${bucket.key}, ${at}, 1)
        ON CONFLICT (key) DO UPDATE SET
          attempts = CASE WHEN "AuthRateLimit"."windowStart" <= ${new Date(at.getTime() - windowMs)} THEN 1 ELSE "AuthRateLimit".attempts + 1 END,
          "windowStart" = CASE WHEN "AuthRateLimit"."windowStart" <= ${new Date(at.getTime() - windowMs)} THEN ${at} ELSE "AuthRateLimit"."windowStart" END
        RETURNING attempts
      `;
      if (rows[0].attempts > bucket.max) exceeded = true;
    }
  });
  if (exceeded) throw new IdentityError("Too many attempts. Wait before trying again.", 429);
}

export async function assertCurrentPrincipal(
  tx: Prisma.TransactionClient, principal: Principal, capability?: Capability, recent = false,
): Promise<Principal> {
  if (!principal.sessionId) throw new AuthorizationError("A current individual session is required.");
  const actor = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE id = ${principal.userId} AND "authVersion" = ${principal.authVersion} AND "isActive" = true FOR SHARE
  `;
  if (!actor.length) throw new AuthorizationError("Your access changed. Sign in again.");
  const sessionRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "UserSession" WHERE id = ${principal.sessionId} AND "userId" = ${principal.userId} FOR SHARE
  `;
  if (!sessionRows.length) throw new AuthorizationError("Your session ended. Sign in again.");
  const user = await tx.user.findUnique({ where: { id: principal.userId }, select: CURRENT_USER_SELECT });
  const session = await tx.userSession.findUnique({ where: { id: principal.sessionId } });
  const claim = session && {
    userId: session.userId, authVersion: session.authVersion, sessionId: session.id,
    issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime(),
  };
  if (!session || !claim || !isLivePersistentSession(session, claim)) throw new AuthorizationError("Your session ended or is locked. Sign in again.");
  const current = await resolvePrincipal(claim, async () => user);
  if (!current) throw new AuthorizationError("Your access changed. Sign in again.");
  let result: Principal = {
    ...current, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(),
    mfaVerifiedAt: session.mfaVerifiedAt?.getTime(),
    grantId: principal.grantId,
    capabilities: current.capabilities.filter((cap) => principal.capabilities.includes(cap)),
  };
  if (principal.grantId?.startsWith("oauth:")) {
    result = await assertOAuthGrant(tx, result);
  } else if (principal.grantId) {
    await tx.$queryRaw`SELECT id FROM "AppAccessGrant" WHERE id = ${principal.grantId} FOR SHARE`;
    const grant = await tx.appAccessGrant.findUnique({ where: { id: principal.grantId } });
    if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= Date.now() || grant.userId !== result.userId || grant.sessionId !== result.sessionId || grant.authVersion !== result.authVersion || grant.audience !== "temcotools-mcp") throw new AuthorizationError("Your client grant expired or was revoked.");
    result = { ...result, capabilities: result.capabilities.filter((cap) => grant.scopes.includes(cap)) };
  }
  if (capability) assertCapability(result, capability);
  if (recent) assertRecentAuthentication(result);
  return result;
}

export async function signInWithPassword(input: unknown, context: IdentityContext) {
  const data = z.object({ username: usernameSchema, password: z.string().max(2048), deviceLabel: z.string().trim().min(1).max(80).default("Browser") }).parse(input);
  await consumeIdentityBudget("login", data.username, context);
  const user = await prisma.user.findUnique({ where: { username: data.username } });
  const valid = await verifyPassword(data.password, user?.passwordHash);
  if (!valid || !user?.isActive) {
    await prisma.$transaction((tx) => audit(tx, "sign_in_failed", { targetUserId: user?.id, sourceHash: sourceHash(context.source) }));
    throw new IdentityError("Invalid username or password. Existing PIN accounts need assisted password enrollment.", 401);
  }
  const at = new Date();
  return prisma.$transaction(async (tx) => {
    const accepted = await tx.user.updateMany({ where: { id: user.id, isActive: true, authVersion: user.authVersion, passwordHash: user.passwordHash }, data: { lastLoginAt: at } });
    if (!accepted.count) throw new IdentityError("Sign-in state changed. Try again.", 401);
    const session = await tx.userSession.create({ data: {
      id: randomUUID(), userId: user.id, authVersion: user.authVersion, createdAt: at,
      lastActivityAt: at, lastStrongAuthenticatedAt: at, expiresAt: new Date(at.getTime() + SESSION_MAX_AGE_MS), deviceLabel: data.deviceLabel,
    } });
    await audit(tx, "sign_in", { actorUserId: user.id, targetUserId: user.id, sessionId: session.id, sourceHash: sourceHash(context.source) });
    return { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role }, claim: {
      userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: at.getTime(), expiresAt: session.expiresAt.getTime(),
    } satisfies SessionClaim };
  });
}

export async function requestRecovery(input: unknown, context: IdentityContext) {
  const { username } = z.object({ username: usernameSchema }).parse(input);
  try { await consumeIdentityBudget("recover", username, context); }
  catch (error) { if (!(error instanceof IdentityError && error.status === 429)) throw error; return { message: NEUTRAL_RECOVERY }; }
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  await prisma.$transaction((tx) => audit(tx, "recovery_requested", { targetUserId: user?.id, sourceHash: sourceHash(context.source) }));
  return { message: NEUTRAL_RECOVERY };
}

export async function issueRecovery(principal: Principal, input: unknown) {
  const data = z.object({ userId: idSchema, purpose: z.enum(["enroll", "reset"]), reason: z.string().trim().min(5).max(300) }).parse(input);
  const token = `${data.purpose}_${randomBytes(32).toString("base64url")}`;
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "users.manage", true);
    await assertManageableAccess(tx, current, {targetUserId:data.userId});
    const user = await tx.user.findUnique({ where: { id: data.userId }, select: { id: true, isActive: true, authVersion: true, passwordHash: true } });
    if (!user?.isActive) throw new IdentityError("Choose an active account.");
    if (data.purpose === "enroll" && user.passwordHash) throw new IdentityError("This account is enrolled. Use password reset.");
    const at = new Date();
    await tx.identityRecoveryToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
    const saved = await tx.identityRecoveryToken.create({ data: {
      tokenHash: hashToken(token), userId: user.id, authVersion: user.authVersion, purpose: data.purpose,
      expiresAt: new Date(at.getTime() + 30 * 60_000), issuedById: principal.userId,
    }, select: { id: true, expiresAt: true, purpose: true } });
    await audit(tx, "recovery_issued", { actorUserId: principal.userId, targetUserId: user.id, sessionId: principal.sessionId, reason: data.reason });
    return { ...saved, token };
  });
}

export async function redeemRecovery(input: unknown, context: IdentityContext) {
  const data = z.object({ token: z.string().min(1).max(100), password: z.string().max(2048) }).parse(input);
  await consumeIdentityBudget("redeem", hashToken(data.token), context);
  if (!/^(enroll|reset)_[A-Za-z0-9_-]{43}$/.test(data.token)) throw new IdentityError("Recovery code is invalid or expired.");
  validatePassword(data.password);
  const passwordHash = await hashPassword(data.password);
  return prisma.$transaction(async (tx) => {
    const token = await tx.identityRecoveryToken.findUnique({ where: { tokenHash: hashToken(data.token) } });
    const at = new Date();
    if (!token || token.consumedAt || token.expiresAt <= at || !data.token.startsWith(`${token.purpose}_`)) throw new IdentityError("Recovery code is invalid or expired.");
    const user = await tx.user.findUnique({ where: { id: token.userId } });
    if (!user?.isActive || user.authVersion !== token.authVersion) throw new IdentityError("Recovery code is invalid or expired.");
    validatePassword(data.password, user.username);
    const consumed = await tx.identityRecoveryToken.updateMany({ where: { id: token.id, consumedAt: null, expiresAt: { gt: at } }, data: { consumedAt: at } });
    if (!consumed.count) throw new IdentityError("Recovery code is invalid or expired.");
    const changed = await tx.user.updateMany({ where: { id: user.id, isActive: true, authVersion: token.authVersion }, data: { passwordHash, passwordChangedAt: at, authVersion: { increment: 1 } } });
    if (!changed.count) throw new IdentityError("Recovery code is invalid or expired.");
    await tx.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
    await tx.identityRecoveryToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
    await audit(tx, "password_recovered", { targetUserId: user.id, sourceHash: sourceHash(context.source) });
    return { ok: true, message: "Password set. Sign in with your new password." };
  });
}

export async function reauthenticate(principal: Principal, input: unknown, context: IdentityContext) {
  const { password } = z.object({ password: z.string().max(2048) }).parse(input);
  await consumeIdentityBudget("reauth", principal.userId, context);
  const user = await prisma.user.findUnique({ where: { id: principal.userId }, select: { passwordHash: true } });
  if (!await verifyPassword(password, user?.passwordHash)) throw new IdentityError("Password confirmation failed.", 401);
  return prisma.$transaction(async (tx) => {
    const actor = await assertIdentityPrincipal(tx, principal, "account.self");
    const at = new Date();
    await tx.userSession.update({ where: { id: actor.sessionId }, data: { lastStrongAuthenticatedAt: at, lastActivityAt: at } });
    await audit(tx, "reauthenticated", { actorUserId: actor.userId, targetUserId: actor.userId, sessionId: actor.sessionId });
    return { strongAuthenticatedAt: at.getTime() };
  });
}

export async function changePassword(principal: Principal, input: unknown, context: IdentityContext) {
  const data = z.object({ currentPassword: z.string().max(2048), newPassword: z.string().max(2048) }).parse(input);
  await consumeIdentityBudget("reauth", principal.userId, context);
  validatePassword(data.newPassword, principal.username);
  const user = await prisma.user.findUnique({ where: { id: principal.userId }, select: { passwordHash: true } });
  if (!await verifyPassword(data.currentPassword, user?.passwordHash)) throw new IdentityError("Password confirmation failed.", 401);
  const passwordHash = await hashPassword(data.newPassword);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    const factor = await tx.userMfa.findUnique({ where: { userId: principal.userId }, select: { enabledAt: true } });
    if (factor?.enabledAt) assertRecentAuthentication(current);
    const at = new Date();
    await tx.user.update({ where: { id: principal.userId }, data: { passwordHash, passwordChangedAt: at, authVersion: { increment: 1 } } });
    await tx.userSession.updateMany({ where: { userId: principal.userId, revokedAt: null }, data: { revokedAt: at } });
    await tx.identityRecoveryToken.updateMany({ where: { userId: principal.userId, consumedAt: null }, data: { consumedAt: at } });
    await audit(tx, "password_changed", { actorUserId: principal.userId, targetUserId: principal.userId, sessionId: principal.sessionId });
    return { ok: true, signInRequired: true };
  });
}

export async function listSessions(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "account.self");
    const sessions = await tx.userSession.findMany({ where: { userId: principal.userId }, select: {
      id: true, deviceLabel: true, createdAt: true, lastActivityAt: true, expiresAt: true, revokedAt: true, lockedAt: true,
    }, orderBy: { createdAt: "desc" }, take: 50 });
    return { currentSessionId: principal.sessionId, sessions };
  });
}

export async function revokeSession(principal: Principal, input: unknown) {
  const { sessionId } = z.object({ sessionId: idSchema }).parse(input);
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "account.self");
    const revoked = await tx.userSession.updateMany({ where: { id: sessionId, userId: principal.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, "session_revoked", { actorUserId: principal.userId, targetUserId: principal.userId, sessionId });
    return { revoked: revoked.count > 0, current: sessionId === principal.sessionId };
  });
}

export async function revokeOtherSessions(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "account.self");
    const revoked = await tx.userSession.updateMany({
      where: { userId: principal.userId, id: { not: principal.sessionId }, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await audit(tx, "other_sessions_revoked", { actorUserId: principal.userId, targetUserId: principal.userId, sessionId: principal.sessionId });
    return { revokedCount: revoked.count };
  });
}

export async function lockSession(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "account.self");
    await tx.userSession.update({ where: { id: principal.sessionId }, data: { lockedAt: new Date() } });
    await audit(tx, "session_locked", { actorUserId: principal.userId, targetUserId: principal.userId, sessionId: principal.sessionId });
    return { locked: true };
  });
}

export async function recordActivity(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "account.self");
    await tx.userSession.update({ where: { id: principal.sessionId }, data: { lastActivityAt: new Date() } });
    return { ok: true };
  });
}

export async function endSession(claim: SessionClaim) {
  if (!claim.userId || !claim.sessionId) return;
  await prisma.$transaction(async (tx) => {
    await tx.userSession.updateMany({ where: { id: claim.sessionId, userId: claim.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, "sign_out", { actorUserId: claim.userId, targetUserId: claim.userId, sessionId: claim.sessionId });
  });
}

export async function listIdentityUsers(principal: Principal, search = "") {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "users.manage");
    return tx.user.findMany({ where: search ? { OR: ["username", "displayName"].map((key) => ({ [key]: { contains: search.slice(0, 100), mode: "insensitive" as const } })) } : {}, select: publicUser, orderBy: { createdAt: "desc" }, take: 200 });
  });
}

async function assertManageableAccess(tx: Prisma.TransactionClient, actor: Principal, input: { targetUserId?: string; role?: string; bundleIds?: string[]; capabilities?: readonly string[] }) {
  const permitted = new Set(actor.capabilities);
  const check = (capabilities: readonly string[]) => {
    if (capabilities.some(capability => capability !== "account.self" && !permitted.has(capability as Capability))) {
      throw new AuthorizationError("This account/client grant cannot assign or recover access beyond its own scope. Use an explicitly broader authorized grant.");
    }
  };
  if (input.role === "admin" && actor.role !== "admin") throw new AuthorizationError("Only a system administrator can assign system-administrator identity.");
  if (input.targetUserId) {
    const target = await tx.user.findUnique({ where:{id:input.targetUserId},select:{role:true,roleBundles:{select:{bundle:{select:{capabilities:true}}}}} });
    if (target) {
      if (target.role === "admin" && actor.role !== "admin") throw new AuthorizationError("System-administrator identity requires system-administrator authority.");
      check(target.roleBundles.flatMap(link => link.bundle.capabilities));
    }
  }
  if (input.bundleIds) {
    const bundles = await tx.roleBundle.findMany({where:{id:{in:input.bundleIds}},select:{capabilities:true}});
    check(bundles.flatMap(bundle => bundle.capabilities));
  }
  if (input.capabilities) check(input.capabilities);
}

export async function createIdentityUser(principal: Principal, input: unknown) {
  const data = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(100), role: z.enum(["admin", "manager", "user"]).default("user") }).strict().parse(input);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "users.manage", true);
    await assertManageableAccess(tx, current, {role:data.role,bundleIds:[`legacy-${data.role}`]});
    const duplicate = await tx.user.findFirst({ where: { username: { equals: data.username, mode: "insensitive" } }, select: { id: true } });
    if (duplicate) throw new IdentityError("Username already exists.", 409);
    const user = await tx.user.create({ data: { ...data, pinHash: "disabled:v2", roleBundles: { create: { bundleId: `legacy-${data.role}` } } }, select: publicUser });
    await audit(tx, "user_created", { actorUserId: principal.userId, targetUserId: user.id, sessionId: principal.sessionId });
    return user;
  });
}

export async function updateIdentityUser(principal: Principal, input: unknown) {
  const data = z.object({ id: idSchema, username: usernameSchema.optional(), displayName: z.string().trim().min(1).max(100).optional(), role: z.enum(["admin", "manager", "user"]).optional(), isActive: z.boolean().optional(), revokeSessions: z.boolean().optional(), bundleIds: z.array(idSchema).max(20).optional() }).strict().parse(input);
  return prisma.$transaction(async (tx) => {
    // Serializes access administration and prevents crossed actor/target locks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110102)`;
    const current = await assertIdentityPrincipal(tx, principal, "users.manage", true);
    await assertManageableAccess(tx, current, {targetUserId:data.id,role:data.role,bundleIds:data.bundleIds??(data.role?[`legacy-${data.role}`]:undefined)});
    const target = await tx.user.findUnique({ where: { id: data.id } });
    if (!target) throw new IdentityError("User not found.", 404);
    if (data.username) {
      const duplicate = await tx.user.findFirst({ where: { username: { equals: data.username, mode: "insensitive" }, NOT: { id: data.id } }, select: { id: true } });
      if (duplicate) throw new IdentityError("Username already exists.", 409);
    }
    const bundleIds = data.bundleIds ?? (data.role ? [`legacy-${data.role}`] : undefined);
    if (bundleIds) {
      const ids = [...new Set(bundleIds)];
      if (await tx.roleBundle.count({ where: { id: { in: ids } } }) !== ids.length) throw new IdentityError("Choose existing role bundles.");
      await tx.userRoleBundle.deleteMany({ where: { userId: data.id } });
      await tx.userRoleBundle.createMany({ data: ids.map((bundleId) => ({ userId: data.id, bundleId })) });
    }
    const securityChanged = data.username !== undefined || data.role !== undefined || data.isActive !== undefined || data.bundleIds !== undefined || data.revokeSessions;
    const user = await tx.user.update({ where: { id: data.id }, data: {
      ...(data.username === undefined ? {} : { username: data.username }), ...(data.displayName === undefined ? {} : { displayName: data.displayName }),
      ...(data.role === undefined ? {} : { role: data.role }), ...(data.isActive === undefined ? {} : { isActive: data.isActive }),
      ...(securityChanged ? { authVersion: { increment: 1 } } : {}),
    }, select: publicUser });
    if (securityChanged) await tx.userSession.updateMany({ where: { userId: data.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await ensureRecoveryAdministrator(tx);
    await audit(tx, "user_updated", { actorUserId: principal.userId, targetUserId: data.id, sessionId: principal.sessionId, reason: securityChanged ? "Access changed; existing sessions revoked." : "Display details changed." });
    return user;
  });
}

export async function listRoleBundles(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "users.manage");
    return tx.roleBundle.findMany({ orderBy: { name: "asc" } });
  });
}

export async function saveRoleBundle(principal: Principal, input: unknown) {
  const data = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default(""), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length) }).parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110102)`;
    const current = await assertIdentityPrincipal(tx, principal, "users.manage", true);
    const existing = data.id ? await tx.roleBundle.findUnique({ where: { id: data.id } }) : null;
    if (data.id && !existing) throw new IdentityError("Bundle not found.", 404);
    if (existing?.isSystem) throw new IdentityError("Create a custom bundle instead of editing a system baseline.");
    const values = { name: data.name, description: data.description, capabilities: [...new Set(data.capabilities)] };
    await assertManageableAccess(tx, current, {bundleIds:data.id?[data.id]:undefined,capabilities:data.capabilities});
    const bundle = existing ? await tx.roleBundle.update({ where: { id: existing.id }, data: values }) : await tx.roleBundle.create({ data: values });
    if (existing) {
      const assignments = await tx.userRoleBundle.findMany({ where: { bundleId: existing.id }, select: { userId: true } });
      await tx.user.updateMany({ where: { id: { in: assignments.map((item) => item.userId) } }, data: { authVersion: { increment: 1 } } });
      await tx.userSession.updateMany({ where: { userId: { in: assignments.map((item) => item.userId) }, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await ensureRecoveryAdministrator(tx);
    await audit(tx, "bundle_saved", { actorUserId: principal.userId, sessionId: principal.sessionId, reason: `Bundle ${bundle.id}` });
    return bundle;
  });
}

export async function listIdentityAudit(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertIdentityPrincipal(tx, principal, "users.manage");
    return tx.identityAudit.findMany({ select: { id: true, action: true, actorUserId: true, targetUserId: true, sessionId: true, reason: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 });
  });
}

export const IDENTITY_IDLE_DESCRIPTION = `${SESSION_IDLE_MS / 60_000} minutes without an acknowledged user action`;

// Identity/session changes take the user row exclusively before session locks.
// This serializes factor/session replacement and avoids shared-lock upgrade
// races with simultaneous activity, revocation or authenticator enrollment.
export async function assertIdentityPrincipal(
  tx: Prisma.TransactionClient, principal: Principal, capability?: Capability, recent = false,
): Promise<Principal> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${principal.userId} FOR UPDATE`;
  return assertCurrentPrincipal(tx, principal, capability, recent);
}
