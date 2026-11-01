import type { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { generateSecret, generateURI } from "otplib";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertRecentPasswordAuthentication, type Principal } from "./principal";
import { assertIdentityPrincipal, assertManageableAccess, consumeIdentityBudget, type IdentityContext } from "./identity";
import { assertCanRemoveRecoveryFactor } from "./recovery-guards";
import { IdentityError, verifyPassword } from "./passwords";
import { decryptMfaSecret, encryptMfaSecret, generateMfaRecoveryCodes, hashMfaRecoveryCode } from "./mfa-crypto";
import { verifyTotpStep } from "./totp";
export { verifyTotpStep } from "./totp";

const proofSchema = z.object({ password: z.string().max(2048), token: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().max(80).optional() })
  .refine((data) => Boolean(data.token) !== Boolean(data.recoveryCode), "Use one authenticator or recovery code.");
const invalidCode = () => new IdentityError("Authenticator or recovery code is invalid or already used. Wait for the next authenticator code if necessary.", 401);

async function confirmPassword(principal: Principal, password: string, context: IdentityContext) {
  await consumeIdentityBudget("mfa", principal.userId, context);
  const user = await prisma.user.findUnique({ where: { id: principal.userId }, select: { passwordHash: true } });
  if (!await verifyPassword(password, user?.passwordHash)) {
    await prisma.identityAudit.create({ data: { action: "mfa_password_failed", actorUserId: principal.userId, targetUserId: principal.userId, sessionId: principal.sessionId } });
    throw new IdentityError("Password confirmation failed.", 401);
  }
}

async function audit(tx: Prisma.TransactionClient, actor: Principal, action: string) {
  await tx.identityAudit.create({ data: { action, actorUserId: actor.userId, targetUserId: actor.userId, sessionId: actor.sessionId } });
}

async function consumeProof(tx: Prisma.TransactionClient, principal: Principal, proof: { token?: string; recoveryCode?: string }) {
  const factor = await tx.userMfa.findUnique({ where: { userId: principal.userId } });
  if (!factor?.enabledAt) throw new IdentityError("Enroll an authenticator in Account security first.", 409);
  if (proof.token) {
    const step = await verifyTotpStep(decryptMfaSecret(principal.userId, factor.encryptedSecret), proof.token, factor.lastUsedStep);
    const used = await tx.userMfa.updateMany({ where: { userId: principal.userId, enabledAt: { not: null }, lastUsedStep: { lt: step } }, data: { lastUsedStep: step } });
    if (!used.count) throw invalidCode();
    return "totp";
  }
  if (!proof.recoveryCode) throw invalidCode();
  const used = await tx.mfaRecoveryCode.updateMany({ where: { userId: principal.userId, codeHash: hashMfaRecoveryCode(principal.userId, proof.recoveryCode), consumedAt: null }, data: { consumedAt: new Date() } });
  if (!used.count) throw invalidCode();
  return "recovery";
}

async function replaceRecoveryCodes(tx: Prisma.TransactionClient, userId: string) {
  const recoveryCodes = generateMfaRecoveryCodes();
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.createMany({ data: recoveryCodes.map((code) => ({ userId, codeHash: hashMfaRecoveryCode(userId, code) })) });
  return recoveryCodes;
}

export async function getMfaStatus(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    const factor = await tx.userMfa.findUnique({ where: { userId: current.userId }, select: { enabledAt: true, pendingExpiresAt: true } });
    return { enabled: Boolean(factor?.enabledAt), enabledAt: factor?.enabledAt ?? null, pendingExpiresAt: factor?.pendingExpiresAt ?? null,
      remainingRecoveryCodes: await tx.mfaRecoveryCode.count({ where: { userId: current.userId, consumedAt: null } }),
      mfaVerifiedAt: current.mfaVerifiedAt ?? null, strongAuthenticatedAt: current.strongAuthenticatedAt ?? null,
    };
  });
}

export async function beginMfaEnrollment(principal: Principal, input: unknown, context: IdentityContext) {
  const { password } = z.object({ password: z.string().max(2048) }).parse(input);
  await confirmPassword(principal, password, context);
  const secret = generateSecret();
  const encryptedSecret = encryptMfaSecret(principal.userId, secret);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    const existing = await tx.userMfa.findUnique({ where: { userId: current.userId } });
    if (existing?.enabledAt) throw new IdentityError("An authenticator is already enrolled. Verify it before replacing or disabling it.", 409);
    const at = new Date();
    const expiresAt = new Date(at.getTime() + 10 * 60_000);
    await tx.userMfa.upsert({ where: { userId: current.userId }, create: { userId: current.userId, encryptedSecret, enrollmentSessionId: current.sessionId!, pendingExpiresAt: expiresAt },
      update: { encryptedSecret, enrollmentSessionId: current.sessionId!, pendingExpiresAt: expiresAt, lastUsedStep: -1 },
    });
    await tx.userSession.update({ where: { id: current.sessionId }, data: { lastStrongAuthenticatedAt: at, lastActivityAt: at, mfaVerifiedAt: null } });
    await audit(tx, current, "mfa_enrollment_started");
    return { secret, uri: generateURI({ issuer: "TemcoTools", label: current.username, secret, algorithm: "sha1", digits: 6, period: 30 }), expiresAt };
  });
}

export async function confirmMfaEnrollment(principal: Principal, input: unknown, context: IdentityContext) {
  const { token } = z.object({ token: z.string().regex(/^\d{6}$/) }).parse(input);
  await consumeIdentityBudget("mfa", principal.userId, context);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    assertRecentPasswordAuthentication(current);
    const factor = await tx.userMfa.findUnique({ where: { userId: current.userId } });
    if (!factor || factor.enabledAt || factor.enrollmentSessionId !== current.sessionId || !factor.pendingExpiresAt || factor.pendingExpiresAt <= new Date()) throw new IdentityError("Authenticator setup expired or belongs to another session. Start again.", 409);
    const step = await verifyTotpStep(decryptMfaSecret(current.userId, factor.encryptedSecret), token, factor.lastUsedStep);
    const at = new Date();
    const enabled = await tx.userMfa.updateMany({ where: { userId: current.userId, enabledAt: null, encryptedSecret: factor.encryptedSecret, enrollmentSessionId: current.sessionId, pendingExpiresAt: { gt: at } }, data: { enabledAt: at, pendingExpiresAt: null, lastUsedStep: step } });
    if (!enabled.count) throw new IdentityError("Authenticator setup changed. Start again.", 409);
    const recoveryCodes = await replaceRecoveryCodes(tx, current.userId);
    await tx.userSession.update({ where: { id: current.sessionId }, data: { mfaVerifiedAt: at, lastActivityAt: at } });
    await audit(tx, current, "mfa_enrolled");
    return { enabled: true, recoveryCodes, mfaVerifiedAt: at.getTime() };
  });
}

export async function verifyMfa(principal: Principal, input: unknown, context: IdentityContext) {
  const data = proofSchema.parse(input);
  await confirmPassword(principal, data.password, context);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    const method = await consumeProof(tx, current, data);
    const at = new Date();
    await tx.userSession.update({ where: { id: current.sessionId }, data: { mfaVerifiedAt: at, lastStrongAuthenticatedAt: at, lastActivityAt: at } });
    await audit(tx, current, method === "totp" ? "mfa_verified" : "mfa_recovery_verified");
    return { verified: true, mfaVerifiedAt: at.getTime(), strongAuthenticatedAt: at.getTime() };
  });
}

export async function regenerateMfaRecoveryCodes(principal: Principal, input: unknown, context: IdentityContext) {
  const data = proofSchema.parse(input);
  await confirmPassword(principal, data.password, context);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    await consumeProof(tx, current, data);
    const at = new Date();
    const recoveryCodes = await replaceRecoveryCodes(tx, current.userId);
    await tx.userSession.update({ where: { id: current.sessionId }, data: { mfaVerifiedAt: at, lastStrongAuthenticatedAt: at, lastActivityAt: at } });
    await audit(tx, current, "mfa_recovery_codes_regenerated");
    return { recoveryCodes };
  });
}

export async function disableMfa(principal: Principal, input: unknown, context: IdentityContext) {
  const data = proofSchema.parse(input);
  await confirmPassword(principal, data.password, context);
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "account.self");
    await consumeProof(tx, current, data);
    await assertCanRemoveRecoveryFactor(tx, current.userId);
    await tx.userMfa.delete({ where: { userId: current.userId } });
    await tx.userSession.updateMany({ where: { userId: current.userId }, data: { mfaVerifiedAt: null } });
    await tx.userSession.updateMany({ where: { userId: current.userId, id: { not: current.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, current, "mfa_disabled");
    return { enabled: false, message: "Authenticator disabled. Privileged actions require enrolling and verifying an authenticator again." };
  });
}

/** Private administrator-to-person recovery. No email or public factor bypass. */
export async function issueAssistedFactorReset(principal: Principal, input: unknown) {
  const data = z.object({ userId: z.string().min(1).max(200), reason: z.string().trim().min(5).max(300) }).strict().parse(input);
  const token = `reset_${randomBytes(32).toString("base64url")}`;
  return prisma.$transaction(async (tx) => {
    const current = await assertIdentityPrincipal(tx, principal, "users.manage", true);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${data.userId} FOR UPDATE`;
    await assertManageableAccess(tx, current, { targetUserId: data.userId });
    const target = await tx.user.findUnique({ where: { id: data.userId }, select: { id: true, isActive: true, authVersion: true } });
    if (!target?.isActive) throw new IdentityError("Choose an active account.");
    await assertCanRemoveRecoveryFactor(tx, target.id);
    const at = new Date(), expiresAt = new Date(at.getTime() + 30 * 60_000);
    await tx.user.update({ where: { id: target.id }, data: { passwordHash: null, passwordChangedAt: null, authVersion: { increment: 1 } } });
    await tx.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: at, mfaVerifiedAt: null } });
    await tx.appAccessGrant.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: at } });
    await tx.oAuthGrant.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: at, revokedReason: "Authorized assisted factor recovery." } });
    await tx.printingDevice.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: at } });
    await tx.identityRecoveryToken.updateMany({ where: { userId: target.id, consumedAt: null }, data: { consumedAt: at } });
    await tx.mfaRecoveryCode.updateMany({ where: { userId: target.id, consumedAt: null }, data: { consumedAt: at } });
    await tx.userMfa.updateMany({ where: { userId: target.id }, data: { enabledAt: null, pendingExpiresAt: at, enrollmentSessionId: "assisted-factor-recovery" } });
    const saved = await tx.identityRecoveryToken.create({ data: { userId: target.id, purpose: "reset", tokenHash: createHash("sha256").update(token).digest("hex"), authVersion: target.authVersion + 1, expiresAt, issuedById: current.userId }, select: { id: true, purpose: true, expiresAt: true } });
    await tx.identityAudit.create({ data: { action: "assisted_factor_reset_issued", actorUserId: current.userId, targetUserId: target.id, sessionId: current.sessionId, reason: data.reason } });
    return { ...saved, token, message: "Privately deliver this one-use code to the verified person. They set a new password and enroll a new authenticator. Previous credentials, factors, sessions and client grants were revoked; no email was sent." };
  });
}
