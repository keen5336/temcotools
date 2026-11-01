import express, { type ErrorRequestHandler } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CAPABILITIES } from "@/lib/auth/principal";
import { createApplicationMcpServer } from "@/lib/application/mcp";
import { authenticateOAuthAccessToken } from "./grants";
import { oauthConfig, type OAuthConfig } from "./config";
import { TemcoOAuthProvider } from "./service";

export function createMcpHttpApp(config: OAuthConfig = oauthConfig()) {
  const app = express();
  const provider = new TemcoOAuthProvider(config);
  app.disable("x-powered-by");
  // No forwarded header is accepted as an alternative authority. The reverse
  // proxy must preserve the explicitly configured public Host.
  app.use((request, response, next) => {
    if (request.headers.host?.toLowerCase() !== config.issuerUrl.host.toLowerCase()) { response.status(421).json({ error: "Unexpected host." }); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const bearer = requireBearerAuth({ verifier: provider, expectedResource: config.resourceUrl, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl) });
  app.use("/mcp", (request, response, next) => {
    // Bearer-only CORS; no credentials/cookie authentication or identity is
    // accepted at this resource. Browser clients still need their own grant.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
    if (request.method === "OPTIONS") { response.status(204).end(); return; }
    next();
  });
  // Authenticate before parsing the application's supported import size.
  app.post("/mcp", bearer, express.json({ limit: 50 * 1024 * 1024 }), async (request, response) => {
    const token = request.auth!.token;
    const server = createApplicationMcpServer(() => authenticateOAuthAccessToken(token, config));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(request, response, request.body); }
    catch { if (!response.headersSent) response.status(500).json({ error: "MCP request could not be completed." }); }
  });
  app.get("/mcp", bearer, (_request, response) => { response.status(405).setHeader("Allow", "POST"); response.json({ error: "This stateless MCP resource uses POST." }); });
  app.delete("/mcp", bearer, (_request, response) => { response.status(405).setHeader("Allow", "POST"); response.json({ error: "No transport session is retained." }); });
  app.use(["/authorize", "/token", "/register", "/revoke"], express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }));
  // Protocol handlers, S256 PKCE validation, client validation and endpoint
  // rate limits are the maintained SDK's implementation.
  app.use(mcpAuthRouter({ provider, issuerUrl: config.issuerUrl, resourceServerUrl: config.resourceUrl, scopesSupported: [...CAPABILITIES], resourceName: "TemcoTools warehouse operations" }));
  const errors: ErrorRequestHandler = (_error, _request, response, next) => { void next; if (!response.headersSent) response.status(400).json({ error: "Request could not be processed." }); };
  app.use(errors);
  return { app, provider };
}
