import type { Prisma } from "@prisma/client";
import { generateSecret, generateURI } from "otplib";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertRecentPasswordAuthentication, type Principal } from "./principal";
import { assertIdentityPrincipal, consumeIdentityBudget, type IdentityContext } from "./identity";
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
    const current = await assertIdentityPrincipal(tx, principal);
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
    const current = await assertIdentityPrincipal(tx, principal);
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
    const current = await assertIdentityPrincipal(tx, principal);
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
    const current = await assertIdentityPrincipal(tx, principal);
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
    const current = await assertIdentityPrincipal(tx, principal);
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
    const current = await assertIdentityPrincipal(tx, principal);
    await consumeProof(tx, current, data);
    await tx.userMfa.delete({ where: { userId: current.userId } });
    await tx.userSession.updateMany({ where: { userId: current.userId }, data: { mfaVerifiedAt: null } });
    await tx.userSession.updateMany({ where: { userId: current.userId, id: { not: current.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, current, "mfa_disabled");
    return { enabled: false, message: "Authenticator disabled. Privileged actions require enrolling and verifying an authenticator again." };
  });
}
