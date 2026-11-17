import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AuthError } from "@/lib/auth/policy";
export const MCP_SCOPES = ["temco.read", "temco.write", "offline_access"] as const;
export type McpScope = typeof MCP_SCOPES[number];
export const ACCESS_MS = 15 * 60_000;
export const CODE_MS = 10 * 60_000;
export class OAuthError extends AuthError {
  constructor(public oauthCode: string, message: string, status = 400) { super(message, status, oauthCode); }
}
export function mcpConfig() {
  const url = new URL(process.env.MCP_ISSUER_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new OAuthError("server_error", "Configure a canonical HTTPS app origin for MCP.", 503);
  return { issuer: url.origin, resource: `${url.origin}/mcp` };
}
export const opaque = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function equalHash(first: string, second: string) { const a = Buffer.from(first), b = Buffer.from(second); return a.length === b.length && timingSafeEqual(a, b); }
export function safeRedirect(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OAuthError("invalid_redirect_uri", "Provide an exact HTTPS or loopback callback."); }
  if (raw.length > 2048 || url.username || url.password || url.hash || url.hostname.includes("*") || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || ["code", "state", "error", "iss"].some(key => url.searchParams.has(key))) throw new OAuthError("invalid_redirect_uri", "Unsafe callback URL.");
  return url.href;
}
export function redirectMatches(registered: string, requested: string) {
  if (registered === requested) return true;
  const a = new URL(registered), b = new URL(requested);
  if (a.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(a.hostname) || a.hostname !== b.hostname || b.protocol !== "http:") return false;
  a.port = b.port; return a.href === b.href;
}
export function parseScopes(value: string | null | undefined) {
  const scopes = value?.trim() ? value.trim().split(/\s+/) : ["temco.read", "temco.write"];
  if (!scopes.length || scopes.length > MCP_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !MCP_SCOPES.includes(scope as McpScope)) || !scopes.includes("temco.read")) throw new OAuthError("invalid_scope", "Use temco.read and optionally temco.write / offline_access.");
  return scopes as McpScope[];
}
export function requireResource(value: string | null | undefined) { if (value !== mcpConfig().resource) throw new OAuthError("invalid_target", "Use this server's exact MCP resource URL."); }
export function safeReturnTo(value?: string | null) {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  const parsed = new URL(value, "https://temco.invalid");
  return parsed.origin === "https://temco.invalid" && parsed.pathname.startsWith("/account/mcp/") ? parsed.pathname + parsed.search : "/";
}
