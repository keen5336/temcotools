import { randomUUID, createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma, McpClient, McpGrant } from "@prisma/client";
import type { SessionData } from "@/lib/session";
import { assertActor, liveAccountSession, lockAuthWrites } from "@/lib/auth/sessions";
import { AuthError, SESSION_MS } from "@/lib/auth/policy";
import { authAudit } from "@/lib/auth/identity";
import { ACCESS_MS, CODE_MS, equalHash, mcpConfig, OAuthError, opaque, parseScopes, redirectMatches, requireResource, safeRedirect, tokenHash } from "./config";
import { resolveClient } from "./clients";

export async function beginAuthorization(params: URLSearchParams) {
  for (const key of ["client_id", "redirect_uri", "resource", "state", "scope", "response_type", "code_challenge", "code_challenge_method"]) if (params.getAll(key).length > 1) throw new OAuthError("invalid_request", "Duplicate OAuth parameter.");
  const client = await resolveClient(params.get("client_id") || "");
  const redirectUri = safeRedirect(params.get("redirect_uri") || "");
  if (!client.redirectUris.some(uri => redirectMatches(uri, redirectUri))) throw new OAuthError("invalid_redirect_uri", "Callback is not registered for this client.");
  requireResource(params.get("resource"));
  if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") || "")) throw new OAuthError("invalid_request", "Authorization code with S256 PKCE is required.");
  const state = params.get("state"); if (state && state.length > 2048) throw new OAuthError("invalid_request", "State is too long.");
  const scopes = parseScopes(params.get("scope"));
  const request = await prisma.mcpAuthorization.create({ data: { id: randomUUID(), clientId: client.id, redirectUri, state, scopes, challenge: params.get("code_challenge")!, resource: mcpConfig().resource, expiresAt: new Date(Date.now() + CODE_MS) } });
  return { requestId: request.id, url: `/account/mcp/authorize?requestId=${request.id}` };
}
export async function consentView(actor: SessionData, id: string) {
  return prisma.$transaction(async tx => {
    const current = await assertActor(tx, actor, true);
    if (current.kind !== "password") throw new OAuthError("access_denied", "Approve connections in a signed-in browser.", 403);
    const request = await tx.mcpAuthorization.findUnique({ where: { id }, include: { client: true } });
    if (!request || request.expiresAt <= new Date() || request.decidedAt) throw new OAuthError("invalid_request", "This authorization request expired or was already used. Start again from your MCP client.");
    if (request.browserSessionId && request.browserSessionId !== actor.sessionId) throw new OAuthError("access_denied", "This request belongs to another browser session. Start again from your MCP client.", 403);
    const bound = await tx.mcpAuthorization.updateMany({ where: { id, decidedAt: null, OR: [{ browserSessionId: null }, { browserSessionId: actor.sessionId }] }, data: { browserSessionId: actor.sessionId, userId: actor.userId, authVersion: actor.authVersion } });
    if (!bound.count) throw new OAuthError("access_denied", "The browser session changed.", 403);
    return { requestId: id, clientName: request.client.name, clientId: request.client.id, redirectUri: request.redirectUri, resource: request.resource, scopes: request.scopes, expiresAt: request.expiresAt, username: actor.username };
  });
}
export async function decideConsent(actor: SessionData, id: string, allow: boolean, scopes: string[]) {
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx); const current = await assertActor(tx, actor, true);
    if (current.kind !== "password") throw new OAuthError("access_denied", "Approve MCP access in your browser.", 403);
    const request = await tx.mcpAuthorization.findUnique({ where: { id }, include: { client: true } });
    if (!request || request.expiresAt <= new Date() || request.decidedAt || request.browserSessionId !== actor.sessionId || request.userId !== actor.userId || request.authVersion !== actor.authVersion) throw new OAuthError("invalid_request", "This browser authorization expired, changed or was already used.");
    const target = new URL(request.redirectUri); target.searchParams.set("iss", mcpConfig().issuer);
    if (request.state !== null) target.searchParams.set("state", request.state);
    if (!allow) {
      await tx.mcpAuthorization.update({ where: { id }, data: { decidedAt: new Date() } });
      target.searchParams.set("error", "access_denied"); return { redirectTo: target.href };
    }
    if (!scopes.length) throw new OAuthError("invalid_scope", "Select the requested permissions to approve.");
    const accepted = parseScopes(scopes.join(" "));
    if (accepted.some(scope => !request.scopes.includes(scope))) throw new OAuthError("invalid_scope", "Approve only the permissions requested by this client.");
    const code = opaque("tc_code");
    await tx.mcpAuthorization.update({ where: { id }, data: { decidedAt: new Date(), scopes: accepted, codeHash: tokenHash(code), expiresAt: new Date(Date.now() + CODE_MS) } });
    await authAudit(tx, "mcp_connection_approved", actor.userId, actor.userId, actor.sessionId, `Client ${request.clientId}`);
    target.searchParams.set("code", code); return { redirectTo: target.href };
  });
}
function validGrant(grant: McpGrant) { return !grant.revokedAt && grant.expiresAt > new Date() && grant.resource === mcpConfig().resource; }
async function issuePair(tx: Prisma.TransactionClient, grant: McpGrant) {
  const access = opaque("tc_at"), refresh = opaque("tc_rt"), at = new Date();
  const accessExpiry = new Date(Math.min(at.getTime() + ACCESS_MS, grant.expiresAt.getTime()));
  await tx.mcpToken.createMany({ data: [{ id: randomUUID(), tokenHash: tokenHash(access), grantId: grant.id, kind: "access", generation: grant.generation, expiresAt: accessExpiry }, { id: randomUUID(), tokenHash: tokenHash(refresh), grantId: grant.id, kind: "refresh", generation: grant.generation, expiresAt: grant.expiresAt }] });
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.max(0, Math.floor((accessExpiry.getTime() - at.getTime()) / 1000)), scope: grant.scopes.join(" "), resource: grant.resource };
}
export async function exchangeCode(client: McpClient, params: URLSearchParams) {
  requireResource(params.get("resource"));
  const code = params.get("code") || "", verifier = params.get("code_verifier") || "";
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || code.length > 200) throw new OAuthError("invalid_grant", "Invalid authorization code or PKCE verifier.");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return prisma.$transaction(async tx => {
    await lockAuthWrites(tx);
    const request = await tx.mcpAuthorization.findUnique({ where: { codeHash: tokenHash(code) } });
    if (!request || !request.decidedAt || request.consumedAt || request.expiresAt <= new Date() || request.clientId !== client.id || request.resource !== mcpConfig().resource || request.redirectUri !== params.get("redirect_uri") || !equalHash(request.challenge, challenge) || !request.userId || !request.browserSessionId) throw new OAuthError("invalid_grant", "Invalid, expired or already-used authorization code.");
    const browser = await assertActor(tx, { userId: request.userId, sessionId: request.browserSessionId, authVersion: request.authVersion } as SessionData, true).catch(error => {
      if (error instanceof AuthError && error.status < 500) throw new OAuthError("invalid_grant", "The approving administrator session ended. Start authorization again.");
      throw error;
    });
    if (browser.kind !== "password") throw new OAuthError("invalid_grant", "Approve access in a browser.");
    const at = new Date(), expiresAt = new Date(at.getTime() + SESSION_MS);
    const session = await tx.authSession.create({ data: { id: randomUUID(), userId: browser.userId, authVersion: browser.user.authVersion, kind: "mcp", deviceName: `MCP · ${client.name}`.slice(0, 100), expiresAt, lastUsedAt: at } });
    const grant = await tx.mcpGrant.create({ data: { id: randomUUID(), clientId: client.id, userId: browser.userId, sessionId: session.id, approvedBySessionId: browser.id, authVersion: browser.user.authVersion, scopes: request.scopes, resource: request.resource, expiresAt } });
    await tx.mcpAuthorization.update({ where: { id: request.id }, data: { consumedAt: at } });
    await authAudit(tx, "mcp_device_connected", browser.userId, browser.userId, session.id, `Client ${client.id}`);
    return issuePair(tx, grant);
  });
}
export async function refreshTokens(client: McpClient, params: URLSearchParams) {
  requireResource(params.get("resource")); const raw = params.get("refresh_token") || "";
  if (raw.length > 200) throw new OAuthError("invalid_grant", "Invalid refresh token.");
  const outcome = await prisma.$transaction(async tx => {
    await lockAuthWrites(tx);
    const token = await tx.mcpToken.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { grant: true } });
    if (!token || token.kind !== "refresh" || token.grant.clientId !== client.id) return { error: "Invalid refresh token." } as const;
    const grant = token.grant;
    if (token.usedAt || token.generation !== grant.generation) {
      const at = new Date(); await tx.mcpGrant.update({ where: { id: grant.id }, data: { revokedAt: at } }); await tx.authSession.update({ where: { id: grant.sessionId }, data: { revokedAt: at } });
      await authAudit(tx, "mcp_refresh_replay_revoked", grant.userId, grant.userId, grant.sessionId);
      return { error: "This refresh token was already used. The connection was signed out; reconnect from your MCP client." } as const;
    }
    const session = await liveAccountSession(grant.sessionId, grant.userId, tx);
    if (!validGrant(grant) || token.expiresAt <= new Date() || !session || session.kind !== "mcp" || session.authVersion !== grant.authVersion) return { error: "This MCP connection ended. Connect again." } as const;
    const requested = params.get("scope");
    const scopes = requested ? parseScopes(requested) : grant.scopes;
    if (scopes.some(scope => !grant.scopes.includes(scope))) return { error: "Refresh cannot add permissions." } as const;
    await tx.mcpToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    const advanced = await tx.mcpGrant.update({ where: { id: grant.id }, data: { generation: { increment: 1 }, scopes } });
    return { tokens: await issuePair(tx, advanced) } as const;
  });
  if ("error" in outcome) throw new OAuthError("invalid_grant", outcome.error!);
  return outcome.tokens;
}
export async function authenticateAccessToken(raw: string) {
  if (!raw || raw.length > 200) throw new OAuthError("invalid_token", "Sign in to connect this MCP client.", 401);
  const token = await prisma.mcpToken.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { grant: { include: { client: true } } } });
  if (!token || token.kind !== "access" || token.expiresAt <= new Date() || !validGrant(token.grant) || token.generation !== token.grant.generation) throw new OAuthError("invalid_token", "MCP access expired or was revoked.", 401);
  const grant = token.grant, session = await liveAccountSession(grant.sessionId, grant.userId);
  if (!session || session.kind !== "mcp" || session.authVersion !== grant.authVersion || session.user.role !== "admin") throw new OAuthError("invalid_token", "Administrator MCP access was revoked.", 401);
  if (session.lastUsedAt.getTime() < Date.now() - 300_000) await prisma.authSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastUsedAt: new Date() } });
  const actor: SessionData = { userId: session.userId, username: session.user.username, displayName: session.user.displayName, role: "admin", isActive: true, sessionId: session.id, authVersion: session.authVersion, apiRelaySessionId: session.id, expiresAt: session.expiresAt.getTime() };
  return { actor, grant, client: grant.client };
}
export async function revokeToken(client: McpClient, raw: string) {
  const token = raw.length <= 200 ? await prisma.mcpToken.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { grant: true } }) : null;
  if (!token || token.grant.clientId !== client.id) return;
  await prisma.$transaction(async tx => {
    await lockAuthWrites(tx); const at = new Date();
    await tx.mcpGrant.update({ where: { id: token.grantId }, data: { revokedAt: at } });
    await tx.authSession.update({ where: { id: token.grant.sessionId }, data: { revokedAt: at } });
    await authAudit(tx, "mcp_connection_revoked", token.grant.userId, token.grant.userId, token.grant.sessionId);
  });
}
