import { McpServer, ResourceTemplate, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authenticateAccessToken } from "./oauth";
import { ALL_ACTIONS } from "./catalog";
import { executeAction, describeAction, listActions } from "./engine";
import { artifactChunk } from "./artifacts";
import { mcpConfig, OAuthError } from "./config";
import { authBudget, authContext } from "@/lib/auth/context";

function result(value: unknown) { const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : { value }; return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body }; }
export function applicationMcpServer(token: string) {
  const readAuth = { securitySchemes: [{ type: "oauth2", scopes: ["temco.read"] }] };
  const writeAuth = { securitySchemes: [{ type: "oauth2", scopes: ["temco.read", "temco.write"] }] };
  const server = new McpServer({ name: "temcotools", version: "1.0.0" }, { maxToolInputElements: 2_000_000, instructions: "Administrator access to TemcoTools. Discover actions with application_actions and read their exact input schema with application_action_info. Every write requires an operationId UUID; reuse it after a lost response, never silently retry with a new ID. Browser handoffs identify physical-device and credential ceremonies. Downloads are private and expire after 15 minutes; use mcp.artifact to read chunks." });
  async function run(work: (principal: Awaited<ReturnType<typeof authenticateAccessToken>>) => Promise<unknown> | unknown) {
    try { const value = await work(await authenticateAccessToken(token)); const failed = value && typeof value === "object" && (("httpStatus" in value && Number(value.httpStatus) >= 400) || ("outcome" in value && value.outcome === "unknown") || ("ok" in value && value.ok === false)); return { ...result(value), ...(failed ? { isError: true } : {}) }; }
    catch (error) {
      const challenge = error instanceof OAuthError && ["invalid_token", "insufficient_scope"].includes(error.oauthCode) ? { _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${mcpConfig().issuer}/.well-known/oauth-protected-resource/mcp", error="${error.oauthCode}", scope="temco.read${error.oauthCode === "insufficient_scope" ? " temco.write" : ""}"`] } } : {};
      return { ...challenge, isError: true, ...result({ error: error instanceof Error && "status" in error ? error.message : "The application action could not be completed. Check its current state before retrying.", ...(error && typeof error === "object" && "status" in error ? { status: error.status } : {}) }) }; }
  }
  server.registerTool("application_actions", { _meta: readAuth, description: "Discover available TemcoTools actions, optionally by prefix. Browser handoffs are explicit; write actions require temco.write.", inputSchema: z.object({ prefix: z.string().max(100).optional() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ prefix }) => run(principal => ({ actions: listActions(principal, prefix) })));
  server.registerTool("application_action_info", { _meta: readAuth, description: "Return one action's input JSON schema, effects and operation ID requirement.", inputSchema: z.object({ action: z.string().min(1).max(120) }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ action }) => run(principal => {
    const item = ALL_ACTIONS.find(value => value.name === action);
    if (!item || item.mode === "write" && !principal.grant.scopes.includes("temco.write")) throw new OAuthError("insufficient_scope", "This action is not available to this client.", 403);
    return describeAction(item);
  }));
  server.registerTool("application_action", { _meta: writeAuth, description: "Execute a named TemcoTools action using its published schema. For writes supply operationId UUID and preserve it on lost responses. Some actions require a human browser/device interaction.", inputSchema: z.object({ action: z.string().min(1).max(120), input: z.record(z.string(), z.unknown()).default({}), operationId: z.uuid().optional() }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ action, input, operationId }) => run(() => executeAction(token, action, input, operationId)));
  server.registerTool("application_read", { _meta: readAuth, description: "Execute a read-only TemcoTools action. This tool cannot mutate application data or invoke browser-approval ceremonies.", inputSchema: z.object({ action: z.string().min(1).max(120), input: z.record(z.string(), z.unknown()).default({}) }), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ action, input }) => run(() => {
    if (ALL_ACTIONS.find(value => value.name === action)?.mode !== "read") throw new OAuthError("insufficient_scope", "Use a read-only application action.", 403);
    return executeAction(token, action, input);
  }));
  server.registerResource("temco_download", new ResourceTemplate("temco://downloads/{id}", { list: undefined }), { description: "Private MCP download. Large files are read in chunks with the mcp.artifact action.", mimeType: "application/octet-stream" }, async (uri, variables) => {
    const principal = await authenticateAccessToken(token), id = String(variables.id);
    const file = await artifactChunk(principal.grant.id, id, 0, 196608);
    if (file.nextOffset !== null) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...file, instruction: "Use application_read action mcp.artifact with nextOffset until null." }) }] };
    return { contents: [{ uri: uri.href, mimeType: file.contentType, blob: file.dataBase64 }] };
  });
  // Existing v1 convenience names remain useful alongside the full catalog.
  for (const [name,action] of [["mars_workflow_summary","mars.overview"],["mars_status_rules","mars.status_rules"]]) server.registerTool(name, { _meta: readAuth, inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => run(() => executeAction(token, action, {})));
  server.registerTool("mars_get_unit", { _meta: readAuth, inputSchema: z.object({ requestNumber: z.string().min(1) }), annotations: { readOnlyHint: true } }, async input => run(() => executeAction(token, "mars.unit", input)));
  for (const name of ["mars_search_units", "mars_problem_units"]) server.registerTool(name, { _meta: readAuth, inputSchema: z.object({ query: z.string().optional(), bucket: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) }), annotations: { readOnlyHint: true } }, async input => run(() => executeAction(token, "mars.units", { query: { q: input.query || "", bucket: name === "mars_problem_units" ? "problem" : input.bucket || "", limit: input.limit } })));
  return server;
}
export async function serveMcp(request: Request) {
  const config = mcpConfig(), expected = new URL(config.issuer);
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": request.headers.get("origin") || config.issuer, "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version", Vary: "Origin" };
  const allowedOrigins = [config.issuer, ...(process.env.MCP_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)];
  if ((request.headers.get("host") || new URL(request.url).host) !== expected.host || request.headers.has("origin") && !allowedOrigins.includes(request.headers.get("origin")!)) return Response.json({ error: "Untrusted MCP Host or Origin." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const requestedHeaders = (request.headers.get("access-control-request-headers") || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowedHeaders = ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name", "last-event-id"];
  if (requestedHeaders.some(value => !allowedHeaders.includes(value) && !/^mcp-param-[a-z0-9-]+$/.test(value))) return Response.json({ error: "Unsupported MCP headers." }, { status: 403, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": [...new Set([...allowedHeaders, ...requestedHeaders])].join(", ") } });
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  try {
    const principal = await authenticateAccessToken(token);
    await authBudget("mcp-call", principal.grant.id, authContext(request), { account: 300, source: 1000 });
    const handler = createMcpHandler(() => applicationMcpServer(token), { legacy: "stateless", maxRequestBodySize: 64 * 1024 * 1024, maxSubscriptions: 0, responseMode: "json", onerror: () => { /* Errors are returned through the transport; never log request data/tokens. */ } });
    const response = await handler.fetch(request, { authInfo: { token, clientId: principal.client.id, scopes: principal.grant.scopes, expiresAt: Math.floor(principal.grant.expiresAt.getTime() / 1000) } });
    for (const [key,value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  } catch (error) {
    const status = error instanceof OAuthError ? error.status : error && typeof error === "object" && "status" in error && error.status === 429 ? 429 : 503;
    return Response.json({ error: status === 401 ? "invalid_token" : status === 429 ? "rate_limited" : "temporarily_unavailable" }, { status, headers: { ...headers, ...(status === 401 ? { "WWW-Authenticate": `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp", scope="temco.read temco.write", error="invalid_token"` } : {}) } });
  }
}
