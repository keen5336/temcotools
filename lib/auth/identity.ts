import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { SessionData } from "@/lib/session";
import { authBudget, type AuthContext } from "./context";
import { hashPassword, validatePassword, verifyPassword } from "./passwords";
import { AuthError, ENROLLMENT_MS } from "./policy";
import { assertActor, createAuthSession, legacyEligible, legacyEnabled, livePasswordSession, lockAuthWrites } from "./sessions";

const username = z.string().trim().min(1).max(80);
const deviceName = z.string().trim().min(1).max(80).default("My device");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const invalidLogin = () => new AuthError("Sign-in failed. Check your credentials or ask an administrator for an account setup/recovery code.", 401);
// A synthetic, fixed bcrypt hash gives unknown and disabled PIN accounts the
// same comparison work. It is not an application credential.
const dummyPin = bcrypt.hash("synthetic-unused-legacy-pin", 12);
export async function authAudit(tx: Prisma.TransactionClient, action: string, actorUserId?: string, targetUserId?: string, sessionId?: string, reason?: string) {
  await tx.authAudit.create({ data: { action, actorUserId, targetUserId, sessionId, reason } });
}
export async function signInPassword(input: unknown, context: AuthContext) {
  const data = z.object({ username, password: z.string().max(2048), deviceName }).strict().safeParse(input);
  if (!data.success) throw invalidLogin();
  await authBudget("login", data.data.username, context);
  const user = await prisma.user.findUnique({ where: { username: data.data.username } });
  const valid = await verifyPassword(data.data.password, user?.passwordHash);
  if (!valid || !user?.isActive || !user.passwordEnrolledAt) {
    await authAudit(prisma, "password_login_failed", undefined, user?.id); throw invalidLogin();
  }
  return prisma.$transaction(async tx => {
    const accepted = await tx.user.updateMany({ where: { id: user.id, authVersion: user.authVersion, isActive: true, passwordHash: user.passwordHash }, data: { lastLoginAt: new Date() } });
    if (!accepted.count) throw invalidLogin();
    const session = await createAuthSession(tx, user, "password", data.data.deviceName);
    await authAudit(tx, "password_login", user.id, user.id, session.id); return session;
  });
}
export async function signInLegacy(input: unknown, context: AuthContext) {
  const result = z.object({ username, pin: z.string().max(64), deviceName }).strict().safeParse(input);
  if (!result.success) throw invalidLogin();
  const data = result.data; await authBudget("login", data.username, context);
  const user = await prisma.user.findUnique({ where: { username: data.username } });
  const eligible = user?.isActive && legacyEligible(user) && await legacyEnabled();
  const valid = await bcrypt.compare(data.pin, eligible ? user!.pinHash : await dummyPin);
  if (!eligible || !valid) { await authAudit(prisma, "legacy_login_failed", undefined, user?.id); throw invalidLogin(); }
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx);
    const current = await tx.user.findUnique({ where: { id: user!.id } });
    if (!current?.isActive || !legacyEligible(current) || !await legacyEnabled(tx) || current.pinHash !== user!.pinHash) throw invalidLogin();
    const session = await createAuthSession(tx, current, "enrollment", data.deviceName);
    await authAudit(tx, "legacy_setup_started", current.id, current.id, session.id); return session;
  });
}
export async function completeAccountUpdate(input: unknown, context: AuthContext) {
  const result = z.object({ username, code: z.string().trim().min(1).max(100), password: z.string().max(2048), deviceName }).strict().safeParse(input);
  if (!result.success) throw new AuthError("Provide your username, setup code and new password.");
  const data = result.data; await authBudget("redeem", data.username, context);
  validatePassword(data.password, data.username);
  const tokenHash = hashToken(data.code);
  const candidate = await prisma.accountCode.findUnique({ where: { tokenHash }, include: { user: true } });
  const invalid = () => new AuthError("The setup/recovery code is invalid or expired. If an earlier update may have completed, try your new password.", 400);
  if (!candidate || candidate.consumedAt || candidate.expiresAt <= new Date() || candidate.user.username !== data.username || !candidate.user.isActive || candidate.user.authVersion !== candidate.authVersion) throw invalid();
  const passwordHash = await hashPassword(data.password);
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx);
    const code = await tx.accountCode.findUnique({ where: { tokenHash }, include: { user: true } });
    const at = new Date();
    if (!code || code.consumedAt || code.expiresAt <= at || !code.user.isActive || code.user.username !== data.username || code.user.authVersion !== code.authVersion || (code.purpose === "enroll" && code.user.passwordEnrolledAt)) throw invalid();
    const consumed = await tx.accountCode.updateMany({ where: { id: code.id, consumedAt: null, expiresAt: { gt: at } }, data: { consumedAt: at } });
    if (!consumed.count) throw invalid();
    const user = await tx.user.update({ where: { id: code.userId }, data: { passwordHash, passwordEnrolledAt: code.user.passwordEnrolledAt || at, passwordChangedAt: at, legacyDisabledAt: code.user.legacyDisabledAt || at, pinHash: "disabled:password", authVersion: { increment: 1 }, lastLoginAt: at } });
    await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
    await tx.accountCode.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
    const session = await createAuthSession(tx, user, "password", data.deviceName);
    await authAudit(tx, code.purpose === "enroll" ? "account_enrolled" : "account_recovered", user.id, user.id, session.id);
    return session;
  });
}
async function verifyCurrentPassword(actor: SessionData, password: unknown, context: AuthContext) {
  await authBudget("reauth", actor.userId, context);
  const row = actor.sessionId ? await livePasswordSession(actor.sessionId, actor.userId) : null;
  if (!row || !await verifyPassword(password, row.user.passwordHash)) throw new AuthError("Password confirmation failed.", 401);
  return prisma.$transaction(async tx => {
    await assertActor(tx, actor);
    await authAudit(tx, "password_confirmed_for_change", row.userId, row.userId, row.id); return { ok: true };
  });
}
export async function changeOwnPassword(actor: SessionData, input: unknown, context: AuthContext) {
  const result = z.object({ currentPassword: z.string().max(2048), password: z.string().max(2048), deviceName }).strict().safeParse(input);
  if (!result.success) throw new AuthError("Provide your current and new passwords.");
  await verifyCurrentPassword(actor, result.data.currentPassword, context);
  validatePassword(result.data.password, actor.username);
  const passwordHash = await hashPassword(result.data.password);
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); const current = await assertActor(tx, actor);
    const at = new Date();
    const user = await tx.user.update({ where: { id: actor.userId }, data: { passwordHash, passwordChangedAt: at, legacyDisabledAt: current.user.legacyDisabledAt || at, pinHash: "disabled:password", authVersion: { increment: 1 } } });
    await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
    await tx.accountCode.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
    const session = await createAuthSession(tx, user, "password", result.data.deviceName);
    await authAudit(tx, "password_changed", user.id, user.id, session.id); return session;
  });
}
export async function revokeAuthSession(sessionId?: string, userId?: string) {
  if (!sessionId || !userId) return;
  await prisma.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
export async function accountSecurity(actor: SessionData) {
  return prisma.$transaction(async tx => {
    await assertActor(tx, actor);
    const sessions = await tx.authSession.findMany({ where: { userId: actor.userId, kind: { in: ["password", "mcp"] }, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { id: true, kind: true, deviceName: true, createdAt: true, lastUsedAt: true, expiresAt: true } });
    return { currentSessionId: actor.sessionId, sessions };
  });
}
export async function revokeOwnDevices(actor: SessionData, sessionId: string | null) {
  return prisma.$transaction(async tx => {
    await assertActor(tx, actor);
    const result = await tx.authSession.updateMany({ where: { userId: actor.userId, ...(sessionId ? { id: sessionId } : { id: { not: actor.sessionId } }), revokedAt: null }, data: { revokedAt: new Date() } });
    await authAudit(tx, "sessions_revoked", actor.userId, actor.userId, actor.sessionId);
    return { ok: true, count: result.count, current: sessionId === actor.sessionId };
  });
}

export async function ensureAnotherAdmin(tx: Prisma.TransactionClient, targetId: string) {
  const other = await tx.user.count({ where: { id: { not: targetId }, role: "admin", isActive: true, passwordHash: { not: null }, passwordEnrolledAt: { not: null } } });
  if (!other) throw new AuthError("Keep another active administrator with an updated login before removing or resetting this administrator. Offline operator recovery is available separately.", 409);
}
export async function issueCodeInTransaction(tx: Prisma.TransactionClient, userId: string, purpose: "enroll" | "reset", operationId: string, issuedById: string | null, reason: string) {
  const previous = await tx.accountCode.findUnique({ where: { operationId } });
  if (previous) {
    if (previous.userId !== userId || previous.purpose !== purpose || previous.issuedById !== issuedById) throw new AuthError("This request identifier belongs to another operation.", 409);
    return { id: previous.id, purpose, expiresAt: previous.expiresAt, code: null, alreadyIssued: true };
  }
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.isActive) throw new AuthError("Choose an active account.", 404);
  if (purpose === "enroll" && user.passwordEnrolledAt) throw new AuthError("This account is already upgraded. Use password recovery.", 409);
  const at = new Date(); let version = user.authVersion;
  if (purpose === "reset") {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: null, legacyDisabledAt: user.legacyDisabledAt || at, pinHash: "disabled:recovery", authVersion: { increment: 1 } } });
    version++;
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
  }
  await tx.accountCode.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: at } });
  const token = `${purpose}_${randomBytes(32).toString("base64url")}`;
  const saved = await tx.accountCode.create({ data: { userId, purpose, tokenHash: hashToken(token), authVersion: version, operationId, issuedById, expiresAt: new Date(at.getTime() + ENROLLMENT_MS) }, select: { id: true, purpose: true, expiresAt: true } });
  await authAudit(tx, purpose === "enroll" ? "enrollment_code_issued" : "recovery_code_issued", issuedById || undefined, userId, undefined, reason);
  return { ...saved, code: token, alreadyIssued: false };
}
export async function issueAccountCode(actor: SessionData, input: unknown) {
  const result = z.object({ userId: z.string().min(1).max(200), purpose: z.enum(["enroll", "reset"]), operationId: z.uuid(), reason: z.string().trim().min(5).max(300) }).strict().safeParse(input);
  if (!result.success) throw new AuthError("Select an account, code purpose and reason.");
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); await assertActor(tx, actor, true);
    const target = await tx.user.findUnique({ where: { id: result.data.userId } });
    if (target?.role === "admin" && target.isActive && target.passwordHash && result.data.purpose === "reset") await ensureAnotherAdmin(tx, target.id);
    return issueCodeInTransaction(tx, result.data.userId, result.data.purpose, result.data.operationId, actor.userId, result.data.reason);
  });
}
// This entry point is used only by the offline operator CLI, never an HTTP API.
export async function issueOperatorCode(userId: string, purpose: "enroll" | "reset", reason: string, deliver?: (code: string, expiresAt: Date) => Promise<void>) {
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx);
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target?.isActive || target.role !== "admin") throw new AuthError("Operator bootstrap/recovery is restricted to an existing active administrator.");
    const result = await issueCodeInTransaction(tx, userId, purpose, randomUUID(), null, reason);
    // File custody must succeed before committing a bootstrap/reset. A failed
    // or uncertain commit can leave only an unusable code, never a lost reset.
    if (deliver && result.code) await deliver(result.code, result.expiresAt);
    return result;
  });
}
