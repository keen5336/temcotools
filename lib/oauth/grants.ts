import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { prisma } from "@/lib/db";
import { assertCapability, AuthorizationError, CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal, type Capability, type Principal } from "@/lib/auth/principal";
import { oauthConfig, type OAuthConfig } from "./config";

export const hashOAuthCredential = (token: string) => createHash("sha256").update(token).digest("hex");

// Independent of identity.ts to let its shared writer guard call this without
// recursion. Every granted authority is recomputed from current storage.
export async function principalForOAuthGrant(tx: Prisma.TransactionClient, id: string, config: OAuthConfig = oauthConfig()): Promise<Principal> {
  const initial = await tx.oAuthGrant.findUnique({ where: { id } });
  if (!initial) throw new AuthorizationError("OAuth grant is unavailable.");
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${initial.userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "UserSession" WHERE id = ${initial.sessionId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "OAuthGrant" WHERE id = ${id} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "OAuthClient" WHERE id = ${initial.clientId} FOR SHARE`;
  const grant = await tx.oAuthGrant.findUnique({ where: { id } });
  const client = await tx.oAuthClient.findUnique({ where: { id: initial.clientId } });
  const user = await tx.user.findUnique({ where: { id: initial.userId }, select: CURRENT_USER_SELECT });
  const session = await tx.userSession.findUnique({ where: { id: initial.sessionId } });
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= Date.now() || !client || client.disabledAt || !user || !session
    || grant.issuer !== config.issuerUrl.href || grant.resource !== config.resourceUrl.href
    || grant.clientId !== client.id || grant.userId !== user.id || grant.sessionId !== session.id || session.userId !== user.id || grant.authVersion !== user.authVersion) throw new AuthorizationError("OAuth grant expired or was revoked.");
  const claim = { userId: session.userId, sessionId: session.id, authVersion: session.authVersion, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() };
  if (!isLivePersistentSession(session, claim)) throw new AuthorizationError("The consenting user session ended or was locked.");
  const current = await resolvePrincipal(claim, async () => user);
  if (!current) throw new AuthorizationError("The consenting user's current access changed.");
  return { ...current, sessionId: session.id, grantId: `oauth:${grant.id}`, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime(), capabilities: current.capabilities.filter((cap) => grant.scopes.includes(cap)) };
}

export async function assertOAuthGrant(tx: Prisma.TransactionClient, principal: Principal, capability?: Capability): Promise<Principal> {
  if (!principal.grantId?.startsWith("oauth:")) throw new AuthorizationError("An OAuth grant is required.");
  const current = await principalForOAuthGrant(tx, principal.grantId.slice(6));
  if (current.userId !== principal.userId || current.sessionId !== principal.sessionId || current.authVersion !== principal.authVersion) throw new AuthorizationError("OAuth grant owner changed.");
  const result = { ...current, capabilities: current.capabilities.filter((cap) => principal.capabilities.includes(cap)) };
  if (capability) assertCapability(result, capability);
  return result;
}

export async function authenticateOAuthAccessToken(token: string, config: OAuthConfig = oauthConfig()): Promise<Principal> {
  if (!/^tc_at_[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError("A current OAuth access token is required.");
  try {
    return await prisma.$transaction(async (tx) => {
      const access = await tx.oAuthToken.findUnique({ where: { tokenHash: hashOAuthCredential(token) } });
      if (!access || access.kind !== "access" || access.expiresAt.getTime() <= Date.now()) throw new InvalidTokenError("OAuth access token expired or was revoked.");
      const current = await principalForOAuthGrant(tx, access.grantId, config);
      return { ...current, capabilities: current.capabilities.filter((cap) => access.scopes.includes(cap)) };
    });
  } catch { throw new InvalidTokenError("OAuth access token expired, was revoked or has the wrong audience."); }
}
