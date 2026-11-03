import { CAPABILITIES, type Capability } from "@/lib/auth/principal";

export interface OAuthConfig { issuerUrl: URL; resourceUrl: URL; appUrl: URL }
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function configuredUrl(raw: string | undefined, name: string) {
  if (!raw) throw new Error(`${name} must be explicitly configured.`);
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))) throw new Error(`${name} requires HTTPS, without credentials/query/fragment (HTTP loopback is allowed for tests).`);
  return url;
}
export function oauthConfig(input: { issuerUrl?: string; resourceUrl?: string; appUrl?: string } = {}): OAuthConfig {
  const issuerUrl = configuredUrl(input.issuerUrl ?? process.env.MCP_ISSUER_URL, "MCP_ISSUER_URL");
  const resourceUrl = configuredUrl(input.resourceUrl ?? process.env.MCP_RESOURCE_URL, "MCP_RESOURCE_URL");
  const appUrl = configuredUrl(input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL");
  if (issuerUrl.pathname !== "/" || appUrl.pathname !== "/") throw new Error("OAuth issuer and application URLs must name the origin root.");
  if (resourceUrl.origin !== issuerUrl.origin || resourceUrl.pathname !== "/mcp") throw new Error("MCP resource must be the issuer origin's /mcp endpoint.");
  if (appUrl.origin !== issuerUrl.origin && !(LOOPBACK.has(appUrl.hostname) && LOOPBACK.has(issuerUrl.hostname))) throw new Error("Production OAuth consent uses the same application origin.");
  return { issuerUrl, resourceUrl, appUrl };
}

export const PRIVILEGED_OAUTH_SCOPES: readonly Capability[] = ["users.manage", "payloads.manage", "labels.manage", "files.manage", "diagnostics.use", "inventory.identify", "inventory.custody", "office.decide", "office.authorize_rtv", "dispatch.allocate", "dispatch.signoff", "account.self"];
export function isPrivilegedOAuthScope(scopes: readonly string[]) { return scopes.some((scope) => PRIVILEGED_OAUTH_SCOPES.includes(scope as Capability)); }
export function knownOAuthScopes(scopes: readonly string[]): scopes is Capability[] {
  return scopes.length > 0 && scopes.length <= CAPABILITIES.length && scopes.every((scope) => CAPABILITIES.includes(scope as Capability)) && new Set(scopes).size === scopes.length;
}

export function safeOAuthRedirect(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.hostname.includes("*") || (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))) throw new Error("Redirect URI must be exact HTTPS or an HTTP loopback callback, without credentials or fragments.");
  if (["code", "state", "error"].some((key) => url.searchParams.has(key))) throw new Error("Redirect URI cannot contain OAuth response parameters.");
  return url.href;
}
