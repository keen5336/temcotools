import { authBudget, authContext, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { OAuthError, mcpConfig } from "./config";
import { authenticateClient, registerClient } from "./clients";
import { beginAuthorization, exchangeCode, refreshTokens, revokeToken } from "./oauth";
import { AuthError } from "@/lib/auth/policy";

export function oauthReply(body: unknown, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", "Access-Control-Allow-Origin": "*" } }); }
export function oauthFailure(error: unknown) {
  if (error instanceof OAuthError) return oauthReply({ error: error.oauthCode, error_description: error.message }, error.status);
  if (error && typeof error === "object" && "status" in error && error.status === 429) return oauthReply({ error: "temporarily_unavailable", error_description: "Too many attempts. Try again later." }, 429);
  if (error instanceof AuthError && error.status < 500) return oauthReply({ error: error.status === 403 ? "access_denied" : "invalid_request", error_description: error.message }, error.status);
  return oauthReply({ error: "server_error", error_description: "The authorization service is unavailable. Check the current connection before retrying." }, 503);
}
export function serverMetadata() {
  const { issuer } = mcpConfig();
  return { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`, scopes_supported: ["temco.read", "temco.write", "offline_access"], response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true };
}
export function resourceMetadata() { const { issuer, resource } = mcpConfig(); return { resource, authorization_servers: [issuer], scopes_supported: ["temco.read", "temco.write"], bearer_methods_supported: ["header"], resource_name: "TemcoTools — administrators" }; }
export function oauthOptions() { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Cache-Control": "no-store" } }); }
function rejectBrowserOrigin(request: Request) { if (request.headers.has("cookie")) sameOrigin(request); }
export async function authorizationEndpoint(request: Request) {
  try {
    await authBudget("mcp-authorize", authContext(request).source, authContext(request), { account: 120, source: 120 });
    const { url } = await beginAuthorization(new URL(request.url).searchParams);
    return new Response(null, { status: 302, headers: { Location: new URL(url, mcpConfig().issuer).href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return oauthFailure(error); }
}
export async function registrationEndpoint(request: Request) {
  try { rejectBrowserOrigin(request); await authBudget("mcp-register", authContext(request).source, authContext(request), { account: 40, source: 40 }); return oauthReply(await registerClient(await readAuthBody(request)), 201); } catch (error) { return oauthFailure(error); }
}
async function readForm(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new OAuthError("invalid_request", "Send URL-encoded OAuth parameters.");
  const reader = request.body?.getReader(); if (!reader) throw new OAuthError("invalid_request", "Missing OAuth request.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 16384) { await reader.cancel(); throw new OAuthError("invalid_request", "OAuth request is too large."); } chunks.push(item.value); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  for (const key of new Set(form.keys())) if (form.getAll(key).length !== 1) throw new OAuthError("invalid_request", "Duplicate OAuth parameter.");
  return form;
}
async function clientFromRequest(request: Request, form: URLSearchParams) {
  const header = request.headers.get("authorization");
  let id = form.get("client_id") || "", secret = form.get("client_secret"), method = secret ? "client_secret_post" : "none";
  if (header) {
    if (!header.startsWith("Basic ") || secret || header.length > 4096) throw new OAuthError("invalid_client", "Unsupported client authentication.", 401);
    const text = Buffer.from(header.slice(6), "base64").toString("utf8"), index = text.indexOf(":");
    if (index < 1) throw new OAuthError("invalid_client", "Invalid client authentication.", 401);
    let basicId: string;
    try { basicId = decodeURIComponent(text.slice(0, index)); secret = decodeURIComponent(text.slice(index + 1)); } catch { throw new OAuthError("invalid_client", "Invalid client authentication.", 401); }
    if (id && id !== basicId) throw new OAuthError("invalid_client", "Conflicting client identifiers.", 401);
    id = basicId; method = "client_secret_basic";
  }
  await authBudget("mcp-token", id, authContext(request), { account: 120, source: 300 });
  return authenticateClient(id, secret, method);
}
export async function tokenEndpoint(request: Request) {
  try {
    rejectBrowserOrigin(request); const form = await readForm(request), client = await clientFromRequest(request, form);
    if (form.get("grant_type") === "authorization_code") return oauthReply(await exchangeCode(client, form));
    if (form.get("grant_type") === "refresh_token") return oauthReply(await refreshTokens(client, form));
    throw new OAuthError("unsupported_grant_type", "Use an authorization code or refresh token.");
  } catch (error) { return oauthFailure(error); }
}
export async function revocationEndpoint(request: Request) {
  try { rejectBrowserOrigin(request); const form = await readForm(request), client = await clientFromRequest(request, form); await revokeToken(client, form.get("token") || ""); return oauthReply({}); } catch (error) { return oauthFailure(error); }
}
