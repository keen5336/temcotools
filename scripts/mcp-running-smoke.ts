// Qualify an already-running isolated development endpoint. Never targets
// production or signs in as the owner; all fixtures are temporary and synthetic.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "../lib/db";
import { hashPassword } from "../lib/auth/passwords";

async function main() {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_preview_test", "Only the task-owned isolated preview database is allowed.");
  const app = new URL(process.env.NEXT_PUBLIC_APP_URL!), issuer = new URL(process.env.MCP_ISSUER_URL!), resource = new URL(process.env.MCP_RESOURCE_URL!);
  assert.ok([app, issuer, resource].every(url => url.hostname === "127.0.0.1" && url.protocol === "http:"));
  const password = randomBytes(32).toString("base64url"), suffix = randomUUID();
  const user = await prisma.user.create({ data: { username: `synthetic-mcp-smoke-${suffix}`, displayName: "Synthetic MCP smoke fixture", pinHash: "disabled:v2", passwordHash: await hashPassword(password), passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-user" } } } });
  let clientId: string | undefined; const sdk = new Client({ name: "synthetic-running-verification", version: "1" });
  try {
    const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", issuer)); assert.equal(metadata.status, 200);
    const login = await fetch(new URL("/api/auth/login", app), { method: "POST", headers: { "Content-Type": "application/json", Origin: app.origin }, body: JSON.stringify({ username: user.username, password, deviceLabel: "Synthetic runtime verification" }) }); assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.ok(cookie);
    const headers = { "Content-Type": "application/json", Origin: app.origin, Cookie: cookie };
    const callback = "http://127.0.0.1:55379/synthetic-callback";
    const registration = await fetch(new URL("/register", issuer), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Synthetic running verification", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) }); assert.equal(registration.status, 201);
    clientId = (await registration.json()).client_id; assert.ok(clientId);
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({ client_id: clientId!, redirect_uri: callback, response_type: "code", scope: "inventory.read", resource: resource.href, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: suffix });
    const start = await fetch(new URL(`/authorize?${params}`, issuer), { redirect: "manual" }); assert.equal(start.status, 302);
    const requestId = new URL(start.headers.get("location")!).searchParams.get("request"); assert.ok(requestId);
    const bound = await fetch(new URL(`/api/oauth-consent?request=${encodeURIComponent(requestId!)}`, app), { headers }); assert.equal(bound.status, 200);
    const approved = await fetch(new URL("/api/oauth-consent", app), { method: "POST", headers, body: JSON.stringify({ requestId, decision: "approve", scopes: ["inventory.read"] }) }); assert.equal(approved.status, 200);
    const code = new URL((await approved.json()).redirectTo).searchParams.get("code"); assert.ok(code);
    const exchange = await fetch(new URL("/token", issuer), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId!, grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: callback, resource: resource.href }) }); assert.equal(exchange.status, 200);
    const tokens = await exchange.json(); assert.ok(tokens.access_token);
    await sdk.connect(new StreamableHTTPClientTransport(resource, { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const tools = await sdk.listTools(); assert.ok(tools.tools.some(tool => tool.name === "application_action_info"));
    const actions = await sdk.callTool({ name: "application_actions", arguments: { prefix: "warehouse." } }); assert.equal(actions.isError, undefined);
    const info = await sdk.callTool({ name: "application_action_info", arguments: { action: "warehouse.notes" } }); assert.equal(info.isError, undefined);
    const query = await sdk.callTool({ name: "warehouse_lookup", arguments: { kind: "lpn", value: `SYNTHETIC-NOT-STOCK-${suffix}` } }); assert.equal(query.isError, undefined);
    const denied = await sdk.callTool({ name: "application_action", arguments: { action: "identity.users", input: {} } }); assert.equal(denied.isError, true);
    await prisma.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    const revokedHttp = await fetch(resource, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }) });
    assert.equal(revokedHttp.status, 401, "Current session revocation must deny a still-unexpired bearer at the running HTTP boundary.");
    let revoked = false;
    try { revoked = (await sdk.callTool({ name: "warehouse_lookup", arguments: { kind: "lpn", value: "SYNTHETIC" } })).isError === true; } catch { revoked = true; }
    assert.equal(revoked, true);
    console.log("PASS: running MCP discovery, actual password/PKCE/consent, SDK connection, action/schema discovery, shared lookup, scope denial and session revocation. Synthetic fixtures only; owner enrollment untouched.");
  } finally {
    await sdk.close().catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } });
    if (clientId) await prisma.oAuthClient.delete({ where: { id: clientId } });
    await prisma.identityAudit.deleteMany({ where: { OR: [{ actorUserId: user.id }, { targetUserId: user.id }] } });
    await prisma.$disconnect();
  }
}
main().catch(() => { console.error("Running MCP verification failed; inspect protected diagnostics without printing credentials."); process.exitCode = 1; });
