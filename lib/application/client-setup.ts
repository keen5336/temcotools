import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Capability, Principal } from "@/lib/auth/principal";
import { oauthConfig } from "@/lib/oauth/config";
import { listOAuthGrants } from "@/lib/oauth/service";
import { listAccessGrants } from "./grants";

export const connectedClientSetupInput = z.object({}).strict();
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
type UrlSettings = { issuerUrl?: string; resourceUrl?: string; appUrl?: string };
export function describeMcpConnection(settings: UrlSettings) {
  const unavailable = { mcpUrl: null, issuerUrl: null, appUrl: null };
  if (!settings.issuerUrl || !settings.resourceUrl || !settings.appUrl) return { ...unavailable, status: "unconfigured" as const, notice: "Remote MCP URLs are not fully configured. Ask a system administrator for the intended OAuth endpoint. Private stdio grants remain separate." };
  try {
    const config = oauthConfig(settings), local = loopback.has(config.resourceUrl.hostname);
    return { status: local ? "loopback" as const : "configured_unverified" as const, mcpUrl: config.resourceUrl.href, issuerUrl: config.issuerUrl.href, appUrl: config.appUrl.href,
      notice: local ? "This endpoint uses loopback. It addresses the device running the client; another phone or a cloud-hosted client cannot reach this computer through its own localhost address." : "This is the configured OAuth MCP endpoint. Configuration does not establish that a phone, LAN or cloud client can reach it; reachability and deployment have not been checked here." };
  } catch {
    // Invalid configuration can contain credentials. Never return raw settings
    // or URL parser errors to a browser/MCP caller.
    return { ...unavailable, status: "invalid_configuration" as const, notice: "Remote MCP URL configuration is invalid. A system administrator must correct the issuer, resource and application URLs. No endpoint or credentials are displayed." };
  }
}
function safeStoredResource(raw: string) {
  try { const url = new URL(raw); return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/mcp" && (url.protocol === "https:" || url.protocol === "http:" && loopback.has(url.hostname)) ? url.href : null; }
  catch { return null; }
}
export async function getConnectedClientSetup(principal: Principal, raw: unknown = {}) {
  connectedClientSetupInput.parse(raw);
  const current = await prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, "account.self"));
  const [stdioGrants, remote] = await Promise.all([listAccessGrants(current), listOAuthGrants(current)]);
  return { actorUserId: current.userId, asOf: new Date().toISOString(), connection: describeMcpConnection({ issuerUrl: process.env.MCP_ISSUER_URL, resourceUrl: process.env.MCP_RESOURCE_URL, appUrl: process.env.NEXT_PUBLIC_APP_URL }),
    availableReadScopes: (["inventory.read", "workflow.read"] as Capability[]).filter(scope => current.capabilities.includes(scope)),
    stdioGrants, oauthGrants: remote.map(grant => ({ id: grant.id, clientName: grant.client.name, clientId: grant.clientId, resource: safeStoredResource(grant.resource), scopes: grant.scopes, createdAt: grant.createdAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt })),
    limitation: "Each list contains up to 100 most recent recorded permissions, not live connection health. Grants also stop working when their issuing session ends, locks or idles out, or current permissions change. No camera or LAN printer is supplied by a server connection." };
}
export type ConnectedClientSetup = Awaited<ReturnType<typeof getConnectedClientSetup>>;
