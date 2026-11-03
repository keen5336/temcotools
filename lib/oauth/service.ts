import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Response } from "express";
import { z } from "zod";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokenRevocationRequest, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { AccessDeniedError, InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertRecentAuthentication, AuthorizationError, CAPABILITIES, type Principal } from "@/lib/auth/principal";
import { isPrivilegedOAuthScope, knownOAuthScopes, oauthConfig, safeOAuthRedirect, type OAuthConfig } from "./config";
import { authenticateOAuthAccessToken, hashOAuthCredential, principalForOAuthGrant } from "./grants";

export { authenticateOAuthAccessToken, assertOAuthGrant, principalForOAuthGrant } from "./grants";
const opaque = (kind: string) => `tc_${kind}_${randomBytes(32).toString("base64url")}`;
const idSchema = z.string().min(1).max(200);

function requireResource(resource: URL | undefined, config: OAuthConfig) {
  if (!resource || resource.href !== config.resourceUrl.href) throw new InvalidTargetError("Use the configured TemcoTools MCP resource.");
}
function requireRedirect(client: OAuthClientInformationFull, redirectUri: string) {
  try { safeOAuthRedirect(redirectUri); } catch { throw new InvalidRequestError("Unsafe redirect URI."); }
  if (!client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))) throw new InvalidRequestError("Unregistered redirect URI.");
}
async function audit(tx: Prisma.TransactionClient, action: string, userId: string, sessionId: string, clientId: string) {
  await tx.identityAudit.create({ data: { action, actorUserId: userId, targetUserId: userId, sessionId, reason: `OAuth client ${clientId}` } });
}
async function grantMutex(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'temco:oauth-grant:' + id}, 0))`;
}
async function activeGrant(tx: Prisma.TransactionClient, id: string, config: OAuthConfig) {
  try { return await principalForOAuthGrant(tx, id, config); }
  catch (error) { if (error instanceof AuthorizationError) throw new InvalidGrantError("The consenting user, client or session is no longer active."); throw error; }
}
async function issueTokens(tx: Prisma.TransactionClient, grant: { id: string; expiresAt: Date; refreshGeneration: number }, scopes: string[]): Promise<OAuthTokens> {
  const at = new Date();
  const expiresAt = new Date(Math.min(at.getTime() + 10 * 60_000, grant.expiresAt.getTime()));
  const accessToken = opaque("at"), refreshToken = opaque("rt");
  await tx.oAuthToken.createMany({ data: [
    { tokenHash: hashOAuthCredential(accessToken), grantId: grant.id, kind: "access", generation: grant.refreshGeneration, scopes, expiresAt },
    { tokenHash: hashOAuthCredential(refreshToken), grantId: grant.id, kind: "refresh", generation: grant.refreshGeneration, scopes, expiresAt: grant.expiresAt },
  ] });
  return { access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, expires_in: Math.max(0, Math.floor((expiresAt.getTime() - at.getTime()) / 1000)), scope: scopes.join(" ") };
}

export class TemcoOAuthProvider implements OAuthServerProvider {
  constructor(readonly config: OAuthConfig = oauthConfig()) {}
  readonly clientsStore = {
    getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> => {
      const client = await prisma.oAuthClient.findUnique({ where: { id: clientId } });
      if (!client || client.disabledAt) return undefined;
      return OAuthClientInformationFullSchema.parse(client.metadata);
    },
    registerClient: async (input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): Promise<OAuthClientInformationFull> => {
      if (input.token_endpoint_auth_method !== "none" || input.client_secret) throw new InvalidClientMetadataError("Register a public PKCE client with token_endpoint_auth_method=none.");
      if (!input.client_name?.trim() || input.client_name.length > 80 || input.redirect_uris.length < 1 || input.redirect_uris.length > 5) throw new InvalidClientMetadataError("Provide a named client and one to five exact redirect URIs.");
      try { input.redirect_uris.forEach(safeOAuthRedirect); } catch { throw new InvalidClientMetadataError("Redirect URIs require exact HTTPS or HTTP loopback callbacks."); }
      if (input.grant_types?.some((grant) => !["authorization_code", "refresh_token"].includes(grant)) || input.response_types?.some((response) => response !== "code")) throw new InvalidClientMetadataError("Only authorization-code PKCE and refresh grants are supported.");
      if (input.scope && !knownOAuthScopes(input.scope.split(" "))) throw new InvalidClientMetadataError("Unknown or duplicate scopes.");
      const metadata: OAuthClientInformationFull = { ...input, redirect_uris: input.redirect_uris.map(safeOAuthRedirect), client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none", client_secret: undefined, client_secret_expires_at: undefined, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
      await prisma.oAuthClient.create({ data: { id: metadata.client_id, name: input.client_name.trim(), metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue } });
      return metadata;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    requireResource(params.resource, this.config);
    requireRedirect(client, params.redirectUri);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 2048) throw new InvalidRequestError("A valid S256 PKCE challenge and bounded state are required.");
    const scopes = params.scopes?.length ? params.scopes : ["inventory.read", "workflow.read"];
    if (!knownOAuthScopes(scopes)) throw new InvalidScopeError("Unknown or duplicate application scopes.");
    if (client.scope && scopes.some((scope) => !client.scope!.split(" ").includes(scope))) throw new InvalidScopeError("Requested scope exceeds registered client scope.");
    const current = await this.clientsStore.getClient(client.client_id);
    if (!current) throw new AccessDeniedError("Client is disabled.");
    const request = await prisma.oAuthAuthorizationRequest.create({ data: {
      id: opaque("req"), clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge,
      resource: this.config.resourceUrl.href, scopes, state: params.state, expiresAt: new Date(Date.now() + 10 * 60_000),
    } });
    const next = new URL("/account/authorize", this.config.appUrl);
    next.searchParams.set("request", request.id);
    response.redirect(302, next.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const record = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashOAuthCredential(code) } });
    if (!record || record.clientId !== client.client_id || record.consumedAt || record.expiresAt.getTime() <= Date.now() || record.resource !== this.config.resourceUrl.href) throw new InvalidGrantError("Authorization code expired or was already used.");
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    requireResource(resource, this.config);
    const found = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashOAuthCredential(code) } });
    if (!found || found.clientId !== client.client_id || !redirectUri || redirectUri !== found.redirectUri) throw new InvalidGrantError("Authorization code or redirect URI is invalid.");
    requireRedirect(client, redirectUri);
    return prisma.$transaction(async (tx) => {
      await grantMutex(tx, found.grantId);
      await activeGrant(tx, found.grantId, this.config);
      const used = await tx.oAuthAuthorizationCode.updateMany({ where: { id: found.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
      if (!used.count) throw new InvalidGrantError("Authorization code expired or was already used.");
      const grant = await tx.oAuthGrant.findUniqueOrThrow({ where: { id: found.grantId } });
      const tokens = await issueTokens(tx, grant, grant.scopes);
      await audit(tx, "oauth_code_exchanged", grant.userId, grant.sessionId, grant.clientId);
      return tokens;
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    requireResource(resource, this.config);
    const found = await prisma.oAuthToken.findUnique({ where: { tokenHash: hashOAuthCredential(token) } });
    if (!found || found.kind !== "refresh") throw new InvalidGrantError("Refresh token is invalid.");
    const outcome = await prisma.$transaction(async (tx) => {
      await grantMutex(tx, found.grantId);
      const grant = await tx.oAuthGrant.findUnique({ where: { id: found.grantId } });
      if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("Refresh token belongs to another client.");
      await activeGrant(tx, grant.id, this.config);
      const current = await tx.oAuthToken.findUniqueOrThrow({ where: { id: found.id } });
      if (current.consumedAt || current.generation !== grant.refreshGeneration) {
        await tx.oAuthGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedReason: "refresh_token_reuse" } });
        await audit(tx, "oauth_refresh_reuse", grant.userId, grant.sessionId, grant.clientId);
        return { reuse: true as const };
      }
      if (current.expiresAt.getTime() <= Date.now()) throw new InvalidGrantError("Refresh token expired.");
      const selected = scopes ?? current.scopes;
      if (!knownOAuthScopes(selected) || selected.some((scope) => !current.scopes.includes(scope) || !grant.scopes.includes(scope))) throw new InvalidScopeError("Refresh scopes cannot exceed the current grant.");
      await tx.oAuthToken.update({ where: { id: current.id }, data: { consumedAt: new Date() } });
      const rotated = await tx.oAuthGrant.update({ where: { id: grant.id }, data: { refreshGeneration: { increment: 1 }, scopes: selected } });
      const tokens = await issueTokens(tx, rotated, selected);
      await audit(tx, "oauth_token_refreshed", grant.userId, grant.sessionId, grant.clientId);
      return { tokens };
    });
    // Reuse revocation must commit before returning an OAuth error.
    if ("reuse" in outcome) throw new InvalidGrantError("Refresh token was already used; its grant has been revoked. Authorize again.");
    return outcome.tokens;
  }

  async verifyAccessToken(token: string) {
    const principal = await authenticateOAuthAccessToken(token, this.config);
    const stored = await prisma.oAuthToken.findUniqueOrThrow({ where: { tokenHash: hashOAuthCredential(token) } });
    const grant = await prisma.oAuthGrant.findUniqueOrThrow({ where: { id: stored.grantId } });
    return { token, clientId: grant.clientId, scopes: [...principal.capabilities], expiresAt: Math.floor(stored.expiresAt.getTime() / 1000), resource: this.config.resourceUrl };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const token = await prisma.oAuthToken.findUnique({ where: { tokenHash: hashOAuthCredential(request.token) } });
    if (!token) return;
    await prisma.$transaction(async (tx) => {
      await grantMutex(tx, token.grantId);
      const grant = await tx.oAuthGrant.findUnique({ where: { id: token.grantId } });
      if (!grant || grant.clientId !== client.client_id || grant.revokedAt) return;
      await tx.oAuthGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedReason: "client_revocation" } });
      await audit(tx, "oauth_client_revoked", grant.userId, grant.sessionId, grant.clientId);
    });
  }
}

function requireHumanSession(principal: Principal) {
  if (principal.grantId) throw new AuthorizationError("Open the authorization page in your signed-in browser; a delegated client cannot approve itself.");
}

export async function getOAuthConsent(principal: Principal, requestId: string) {
  requireHumanSession(principal);
  idSchema.parse(requestId);
  return prisma.$transaction(async (tx) => {
    const current = await assertCurrentPrincipal(tx, principal);
    await tx.$queryRaw`SELECT id FROM "OAuthAuthorizationRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.oAuthAuthorizationRequest.findUnique({ where: { id: requestId }, include: { client: true } });
    if (!request || request.expiresAt.getTime() <= Date.now() || request.resolvedAt || request.client.disabledAt) throw new AuthorizationError("Authorization request expired or was resolved. Start again in the client.");
    if (request.boundUserId && (request.boundUserId !== current.userId || request.boundSessionId !== current.sessionId || (request.siteId !== null && request.siteId !== current.siteId))) throw new AuthorizationError("Authorization request belongs to another signed-in session. Start again.");
    if (!request.boundUserId) await tx.oAuthAuthorizationRequest.update({ where: { id: request.id }, data: { boundUserId: current.userId, boundSessionId: current.sessionId, siteId: current.siteId } });
    return { requestId: request.id, clientName: request.client.name, clientId: request.clientId, redirectUri: request.redirectUri, resource: request.resource, scopes: request.scopes,
      allowedScopes: request.scopes.filter((scope) => current.capabilities.includes(scope as typeof CAPABILITIES[number])),
      user: { userId: current.userId, username: current.username, displayName: current.displayName }, expiresAt: request.expiresAt,
      requiresPrivilegedProof: isPrivilegedOAuthScope(request.scopes),
    };
  });
}

export async function decideOAuthConsent(principal: Principal, input: unknown, config: OAuthConfig = oauthConfig()) {
  requireHumanSession(principal);
  const data = z.object({ requestId: idSchema, decision: z.enum(["approve", "deny"]), scopes: z.array(z.string()).max(CAPABILITIES.length).default([]) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const current = await assertCurrentPrincipal(tx, principal);
    await tx.$queryRaw`SELECT id FROM "OAuthAuthorizationRequest" WHERE id = ${data.requestId} FOR UPDATE`;
    const request = await tx.oAuthAuthorizationRequest.findUnique({ where: { id: data.requestId }, include: { client: true } });
    if (!request || request.resolvedAt || request.expiresAt.getTime() <= Date.now() || request.client.disabledAt || request.boundUserId !== current.userId || request.boundSessionId !== current.sessionId || (request.siteId !== null && request.siteId !== current.siteId) || request.resource !== config.resourceUrl.href) throw new AuthorizationError("Authorization request changed, expired or belongs to another session.");
    const metadata = OAuthClientInformationFullSchema.parse(request.client.metadata);
    requireRedirect(metadata, request.redirectUri);
    const redirect = new URL(request.redirectUri);
    if (request.state !== null) redirect.searchParams.set("state", request.state);
    const at = new Date();
    if (data.decision === "deny") {
      await tx.oAuthAuthorizationRequest.update({ where: { id: request.id }, data: { resolvedAt: at, deniedAt: at } });
      redirect.searchParams.set("error", "access_denied");
      await audit(tx, "oauth_consent_denied", current.userId, current.sessionId!, request.clientId);
      return { redirectTo: redirect.href };
    }
    if (!knownOAuthScopes(data.scopes) || data.scopes.some((scope) => !request.scopes.includes(scope) || !current.capabilities.includes(scope as typeof CAPABILITIES[number]))) throw new AuthorizationError("Choose only requested scopes currently available to you.");
    if (isPrivilegedOAuthScope(data.scopes)) assertRecentAuthentication(current);
    const session = await tx.userSession.findUniqueOrThrow({ where: { id: current.sessionId } });
    const grant = await tx.oAuthGrant.create({ data: { requestId: request.id, clientId: request.clientId, userId: current.userId, sessionId: current.sessionId!, authVersion: current.authVersion, issuer: config.issuerUrl.href, resource: config.resourceUrl.href, siteId: request.siteId ?? current.siteId ?? session.activeSiteId, scopes: data.scopes, expiresAt: session.expiresAt } });
    const code = opaque("code");
    await tx.oAuthAuthorizationCode.create({ data: { codeHash: hashOAuthCredential(code), grantId: grant.id, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource, expiresAt: new Date(at.getTime() + 2 * 60_000) } });
    await tx.oAuthAuthorizationRequest.update({ where: { id: request.id }, data: { resolvedAt: at } });
    await audit(tx, "oauth_consent_approved", current.userId, current.sessionId!, request.clientId);
    redirect.searchParams.set("code", code);
    return { redirectTo: redirect.href };
  });
}

export async function listOAuthGrants(principal: Principal) {
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "account.self");
    return tx.oAuthGrant.findMany({ where: { userId: principal.userId }, select: { id: true, clientId: true, sessionId: true, resource: true, scopes: true, createdAt: true, expiresAt: true, revokedAt: true, revokedReason: true, client: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  });
}

export async function revokeOAuthGrant(principal: Principal, id: string) {
  idSchema.parse(id);
  return prisma.$transaction(async (tx) => {
    await grantMutex(tx, id);
    await assertCurrentPrincipal(tx, principal, "account.self");
    const grant = await tx.oAuthGrant.findUnique({ where: { id } });
    if (!grant || grant.userId !== principal.userId) return { revoked: false };
    const result = await tx.oAuthGrant.updateMany({ where: { id, userId: principal.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "user_revocation" } });
    if (result.count) await audit(tx, "oauth_user_revoked", principal.userId, principal.sessionId!, grant.clientId);
    return { revoked: result.count > 0 };
  });
}
