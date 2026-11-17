import { lookup } from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { equalHash, OAuthError, opaque, safeRedirect, tokenHash } from "./config";

const metadata = z.object({ client_name: z.string().trim().min(1).max(100).default("Unnamed MCP client"), redirect_uris: z.array(z.string().max(2048)).min(1).max(10), token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic", "private_key_jwt"]).default("none"), token_endpoint_auth_methods_supported: z.array(z.string().max(100)).min(1).max(10).optional(), grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).default(["authorization_code", "refresh_token"]), response_types: z.array(z.literal("code")).default(["code"]), client_id: z.string().max(2048).optional() });
export function clientMetadata(input: unknown) {
  const parsed = metadata.safeParse(input);
  if (!parsed.success) throw new OAuthError("invalid_client_metadata", "Provide a client name, exact callback URLs, and supported OAuth methods.");
  const value = parsed.data;
  if (!value.grant_types.includes("authorization_code") || !value.response_types.includes("code")) throw new OAuthError("invalid_client_metadata", "Authorization-code OAuth is required.");
  return { ...value, redirect_uris: [...new Set(value.redirect_uris.map(safeRedirect))] };
}
export function publicMetadataAddress(raw: string) {
  try { const address = ipaddr.parse(raw); return address.range() === "unicast" && !(address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()); } catch { return false; }
}
export function metadataCacheMs(value = "") {
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(value)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(value);
  return maxAge ? Math.min(Number(maxAge[1]) * 1000, 3600_000) : 300_000;
}
export function publicClientMetadata(input: unknown, id: string) {
  const value = clientMetadata(input);
  // CIMD's plural field lists supported methods; the legacy singular field is
  // only a preference. ChatGPT advertises both none and private_key_jwt.
  const methods = value.token_endpoint_auth_methods_supported || [value.token_endpoint_auth_method];
  if (value.client_id !== id || !methods.includes("none")) throw new OAuthError("invalid_client_metadata", "Client metadata must match its URL and support public-client PKCE.");
  return { ...value, token_endpoint_auth_method: "none" as const };
}
async function fetchMetadata(id: string) {
  const url = new URL(id);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || url.pathname === "/" || id.length > 2048 || /(^|\.)(localhost|local|internal)$/.test(url.hostname)) throw new OAuthError("invalid_client", "Unsafe client metadata URL.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(item => !publicMetadataAddress(item.address))) throw new OAuthError("invalid_client", "Client metadata must resolve to public Internet addresses.");
  // Pin the validated IP for the connection; preserve the original TLS identity.
  // No redirects, proxy environment, private-address fallback or disabled TLS.
  const fetched = await new Promise<{ text: string; cacheMs: number }>((resolve, reject) => {
    const request = https.request({ hostname: addresses[0].address, port: 443, servername: url.hostname, rejectUnauthorized: true, method: "GET", path: url.pathname + url.search, headers: { Host: url.hostname, Accept: "application/json" } }, response => {
      if (response.statusCode !== 200 || !/application\/(?:[\w.+-]+\+)?json/i.test(response.headers["content-type"] || "")) { response.resume(); reject(new Error("metadata")); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 32768) { request.destroy(new Error("metadata")); return; } chunks.push(chunk); });
      response.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), cacheMs: metadataCacheMs(response.headers["cache-control"]) })); response.on("error", reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error("metadata")), 5000);
    request.on("close", () => clearTimeout(deadline));
    request.setTimeout(5000, () => request.destroy(new Error("metadata"))); request.on("error", reject); request.end();
  }).catch(() => { throw new OAuthError("invalid_client", "Client metadata could not be safely verified."); });
  let raw: unknown; try { raw = JSON.parse(fetched.text); } catch { throw new OAuthError("invalid_client_metadata", "Invalid client metadata JSON."); }
  const value = publicClientMetadata(raw, id);
  return { value, cacheMs: fetched.cacheMs };
}
export async function resolveClient(id: string) {
  if (!id || id.length > 2048) throw new OAuthError("invalid_client", "Unknown OAuth client.");
  const saved = await prisma.mcpClient.findUnique({ where: { id } });
  if (saved && (!saved.metadataUrl || saved.metadataUntil && saved.metadataUntil > new Date())) return saved;
  if (!id.startsWith("https://")) throw new OAuthError("invalid_client", "Register this OAuth client first.");
  const { value, cacheMs } = await fetchMetadata(id), metadataUntil = new Date(Date.now() + cacheMs);
  return prisma.mcpClient.upsert({ where: { id }, create: { id, name: value.client_name, redirectUris: value.redirect_uris, metadataUrl: id, metadataUntil }, update: { name: value.client_name, redirectUris: value.redirect_uris, metadataUntil } });
}
export async function registerClient(input: unknown) {
  const value = clientMetadata(input), id = randomUUID();
  if (value.token_endpoint_auth_method === "private_key_jwt") throw new OAuthError("invalid_client_metadata", "Use public-client PKCE, client_secret_post or client_secret_basic.");
  const secret = value.token_endpoint_auth_method === "none" ? null : opaque("tc_client");
  await prisma.mcpClient.create({ data: { id, name: value.client_name, redirectUris: value.redirect_uris, authMethod: value.token_endpoint_auth_method, secretHash: secret ? tokenHash(secret) : null } });
  return { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: value.client_name, redirect_uris: value.redirect_uris, token_endpoint_auth_method: value.token_endpoint_auth_method, grant_types: value.grant_types, response_types: ["code"], ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) };
}
export async function authenticateClient(id: string, secret: string | null, method: string) {
  const client = await resolveClient(id);
  if (client.authMethod === "none") { if (secret || method !== "none") throw new OAuthError("invalid_client", "This public client uses PKCE without a client secret.", 401); }
  else if (method !== client.authMethod || !secret || !client.secretHash || !equalHash(client.secretHash, tokenHash(secret))) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
  return client;
}
