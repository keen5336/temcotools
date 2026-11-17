import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SessionData } from "@/lib/session";
import { AuthError, ENROLLMENT_MS, RECENT_AUTH_MS, SESSION_MS } from "./policy";

export const anonymousSession = (): SessionData => ({ userId: "", username: "", displayName: "", role: "user", isActive: false });
export async function legacyEnabled(tx: Pick<Prisma.TransactionClient, "authPolicy"> = prisma) {
  return (await tx.authPolicy.findUnique({ where: { id: "global" } }))?.legacyLoginEnabled === true;
}
export function legacyEligible(user: { passwordEnrolledAt: Date | null; legacyDisabledAt: Date | null; passwordHash: string | null; pinHash: string }) {
  return !user.passwordEnrolledAt && !user.legacyDisabledAt && !user.passwordHash && /^\$2[aby]\$/.test(user.pinHash);
}
export async function createAuthSession(tx: Prisma.TransactionClient, user: { id: string; authVersion: number }, kind: "password" | "enrollment", deviceName: string) {
  const now = new Date();
  return tx.authSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, kind, deviceName, expiresAt: new Date(now.getTime() + (kind === "password" ? SESSION_MS : ENROLLMENT_MS)), reauthenticatedAt: kind === "password" ? now : null } });
}
export async function livePasswordSession(sessionId: string, userId?: string, tx: Pick<Prisma.TransactionClient, "authSession"> = prisma) {
  const row = await tx.authSession.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!row || row.kind !== "password" || (userId && row.userId !== userId) || row.revokedAt || row.expiresAt <= new Date() || !row.user.isActive || row.authVersion !== row.user.authVersion || !row.user.passwordHash || !row.user.passwordEnrolledAt) return null;
  return row;
}
export async function resolveSession(raw: Partial<SessionData>): Promise<SessionData> {
  const anonymous = anonymousSession();
  if (typeof raw.sessionId === "string" && typeof raw.userId === "string") {
    const row = await prisma.authSession.findUnique({ where: { id: raw.sessionId }, include: { user: true } });
    if (!row || row.userId !== raw.userId || row.authVersion !== raw.authVersion || row.authVersion !== row.user.authVersion || row.revokedAt || row.expiresAt <= new Date() || !row.user.isActive) return anonymous;
    if (row.kind === "password" && row.user.passwordHash && row.user.passwordEnrolledAt) return { userId: row.userId, username: row.user.username, displayName: row.user.displayName, role: row.user.role, isActive: true, sessionId: row.id, authVersion: row.authVersion, apiRelaySessionId: row.id, expiresAt: row.expiresAt.getTime(), reauthenticatedAt: row.reauthenticatedAt?.getTime() };
    if (row.kind === "enrollment" && legacyEligible(row.user) && await legacyEnabled()) return { ...anonymous, upgradeRequired: true, upgradeUsername: row.user.username };
    return anonymous;
  }
  // A pre-migration cookie is an enrollment hint only. Its cached role/active
  // claims can never authorize a tool, API, code issuance or administration.
  if (typeof raw.userId === "string" && raw.userId) {
    const user = await prisma.user.findUnique({ where: { id: raw.userId } });
    if (user?.isActive && legacyEligible(user) && await legacyEnabled()) return { ...anonymous, upgradeRequired: true, upgradeUsername: user.username };
  }
  return anonymous;
}
export function assertRecentSession(session: SessionData) {
  if (!session.userId || !session.sessionId || !session.reauthenticatedAt || Date.now() - session.reauthenticatedAt > RECENT_AUTH_MS) throw new AuthError("Confirm your password in Account security before this change.", 403, "REAUTH_REQUIRED");
}
export async function lockAuthWrites(tx: Prisma.TransactionClient) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110120)`; }
export async function assertActor(tx: Prisma.TransactionClient, actor: SessionData, admin = false, recent = false) {
  if (!actor.userId || !actor.sessionId) throw new AuthError("Sign in with your updated account.", 401);
  // Identity operations use a consistent lock order and serialize writes for
  // one actor; concurrent reauthentication/revocation cannot upgrade shared
  // locks in opposite order or authorize against a stale session.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actor.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "AuthSession" WHERE id=${actor.sessionId} FOR UPDATE`;
  const row = await livePasswordSession(actor.sessionId, actor.userId, tx);
  if (!row || row.authVersion !== actor.authVersion) throw new AuthError("Your session ended. Sign in again.", 401);
  if (admin && row.user.role !== "admin") throw new AuthError("Administrator access is required.", 403);
  if (recent && (!row.reauthenticatedAt || Date.now() - row.reauthenticatedAt.getTime() > RECENT_AUTH_MS)) throw new AuthError("Confirm your password in Account security before this change.", 403, "REAUTH_REQUIRED");
  return row;
}
