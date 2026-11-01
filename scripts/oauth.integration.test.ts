import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { generate } from "otplib";
import { hashPassword } from "../lib/auth/passwords";
import { oauthConfig } from "../lib/oauth/config";

type Tokens = { access_token: string; refresh_token: string; scope: string };
type Client = { client_id: string };
type Rpc = { result?: { content?: Array<{ text: string }>; protocolVersion?: string }; error?: unknown };
const testUrl = process.env.IDENTITY_TEST_DATABASE_URL;
test("remote MCP OAuth uses actual HTTP PKCE, phone consent, scoped commands and rotating refresh tokens", { skip: !testUrl, timeout: 120_000 }, async (suite) => {
  const database = new URL(testUrl!);
  assert.ok(database.hostname === "127.0.0.1" && database.port === "55439" && database.pathname === "/temcotools_v2_test", "Dedicated synthetic database required.");
  process.env.DATABASE_URL = testUrl;
  process.env.SESSION_SECRET = "synthetic-oauth-http-session-secret-2026";
  const reservation = createNetServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const reserved = reservation.address(); assert.ok(reserved && typeof reserved !== "string");
  const appPort = reserved.port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const appOrigin = `http://127.0.0.1:${appPort}`;
  let handler: ReturnType<typeof import("../lib/oauth/http-server")["createMcpHttpApp"]>["app"] | null = null;
  const oauthServer = createHttpServer((request, response) => { if (handler) handler(request, response); else response.writeHead(503).end(); });
  oauthServer.listen(0, "127.0.0.1"); await once(oauthServer, "listening");
  const address = oauthServer.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.MCP_ISSUER_URL = origin; process.env.MCP_RESOURCE_URL = `${origin}/mcp`; process.env.NEXT_PUBLIC_APP_URL = appOrigin;
  const config = oauthConfig();
  const [{ createMcpHttpApp }, { prisma }, { authenticateOAuthAccessToken }, identity] = await Promise.all([
    import("../lib/oauth/http-server"), import("../lib/db"), import("../lib/oauth/grants"), import("../lib/auth/identity"),
  ]);
  handler = createMcpHttpApp(config).app;
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production", SESSION_SECRET: process.env.SESSION_SECRET, MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x4f).toString("base64url") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let startup = "";
  next.stdout.on("data", (chunk) => { startup = (startup + chunk).slice(-4000); });
  next.stderr.on("data", (chunk) => { startup = (startup + chunk).slice(-4000); });
  const namespace = `oauth-test-${randomUUID()}`;
  const password = "Synthetic OAuth consent passphrase 9";
  const passwordHash = await hashPassword(password);
  const people = await Promise.all(["a", "b"].map((suffix) => prisma.user.create({ data: {
    username: `${namespace}-${suffix}`, displayName: `Synthetic OAuth person ${suffix}`, role: "admin", pinHash: "disabled:v2", passwordHash,
    passwordChangedAt: new Date(), roleBundles: { create: { bundleId: "legacy-admin" } },
  } })));
  const clients: string[] = [];
  const lpn = `${namespace}-LPN`.toUpperCase();
  await prisma.inventoryAuditItem.create({ data: { lpn, status: "Delivered", orderNumber: `${namespace}-order`, vendor: "Synthetic vendor", receivedDate: "2026-10-31", description: "Synthetic appliance", customerName: "Synthetic destination", sourceData: { LPN: lpn }, contentHash: namespace } });
  let cookieA = "", cookieB = "";
  const contexts = new Map<string, string>();
  const uiHeaders = (cookie = cookieA) => ({ Cookie: cookie, Origin: appOrigin, "Content-Type": "application/json", "X-Temco-UI-Context": contexts.get(cookie) ?? "" });
  const form = (path: string, body: Record<string, string>) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  async function register(name: string): Promise<Client> {
    const response = await fetch(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: `${namespace}-${name}`, redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }) });
    assert.equal(response.status, 201);
    const client = await response.json() as Client; clients.push(client.client_id); return client;
  }
  async function login(index: number) {
    const response = await fetch(`${appOrigin}/api/auth/login`, { method: "POST", headers: uiHeaders(""), body: JSON.stringify({ username: people[index].username, password, deviceLabel: "Synthetic OAuth phone" }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie()[0]?.split(";")[0]; assert.ok(cookie);
    const { uiContext } = await response.json(); assert.match(uiContext, /^uc1_[A-Za-z0-9_-]{43}$/); contexts.set(cookie, uiContext); return cookie;
  }
  async function begin(client: Client, scopes = ["inventory.read", "workflow.read"]) {
    const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://client.example/callback", code_challenge: challenge, code_challenge_method: "S256", scope: scopes.join(" "), state: "synthetic-state", resource: config.resourceUrl.href });
    const response = await fetch(`${origin}/authorize?${params}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin, appOrigin); const requestId = location.searchParams.get("request"); assert.ok(requestId);
    return { requestId, verifier, params, scopes };
  }
  async function bind(requestId: string, cookie = cookieA) {
    return fetch(`${appOrigin}/api/oauth-consent?request=${encodeURIComponent(requestId)}`, { headers: uiHeaders(cookie) });
  }
  async function approve(request: Awaited<ReturnType<typeof begin>>, cookie = cookieA) {
    assert.equal((await bind(request.requestId, cookie)).status, 200);
    const response = await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: uiHeaders(cookie), body: JSON.stringify({ requestId: request.requestId, decision: "approve", scopes: request.scopes }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { redirectTo: string };
    const redirect = new URL(result.redirectTo); assert.equal(redirect.origin, "https://client.example"); assert.equal(redirect.searchParams.get("state"), "synthetic-state");
    const code = redirect.searchParams.get("code"); assert.ok(code); return code;
  }
  async function exchange(client: Client, request: Awaited<ReturnType<typeof begin>>, code: string) {
    return form("/token", { client_id: client.client_id, grant_type: "authorization_code", code, code_verifier: request.verifier, redirect_uri: "https://client.example/callback", resource: config.resourceUrl.href });
  }
  async function authorize(client: Client, scopes?: string[]) {
    const request = await begin(client, scopes), code = await approve(request);
    const response = await exchange(client, request, code); assert.equal(response.status, 200);
    return await response.json() as Tokens;
  }
  const mcp = (token?: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Synthetic MCP client", version: "1" } } }) => fetch(config.resourceUrl, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (next.exitCode !== null) throw new Error(`Synthetic Next server exited: ${startup}`);
      try { if ((await fetch(`${appOrigin}/signin`)).status === 200) { ready = true; break; } } catch { /* own server starting */ }
      await delay(100);
    }
    assert.ok(ready, "Fresh production build is required before OAuth HTTP tests.");
    cookieA = await login(0); cookieB = await login(1);
    let client: Client;
    await suite.test("SDK discovery and registration enforce public PKCE clients and safe callbacks", async () => {
      const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
      assert.equal(metadata.issuer, config.issuerUrl.href);
      const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
      assert.equal(resource.resource, config.resourceUrl.href);
      assert.equal((await fetch(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Unsafe synthetic", redirect_uris: ["javascript:alert(1)"], token_endpoint_auth_method: "none" }) })).status, 400);
      assert.equal((await fetch(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Unsupported synthetic secret client", redirect_uris: ["https://client.example/callback"] }) })).status, 400);
      client = await register("main");
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "client_credentials" })).status, 400);
    });
    await suite.test("authorization rejects wrong redirects, missing resource and non-S256 PKCE", async () => {
      const request = await begin(client);
      for (const [key, value] of [["redirect_uri", "https://wrong.example/callback"], ["resource", "https://wrong.example/mcp"], ["code_challenge_method", "plain"]]) {
        const params = new URLSearchParams(request.params); params.set(key, value);
        const response = await fetch(`${origin}/authorize?${params}`, { redirect: "manual" });
        if (key === "redirect_uri") assert.equal(response.status, 400);
        else { assert.equal(response.status, 302); assert.ok(new URL(response.headers.get("location")!).searchParams.has("error")); }
      }
      const params = new URLSearchParams(request.params); params.delete("resource");
      const response = await fetch(`${origin}/authorize?${params}`, { redirect: "manual" });
      assert.equal(new URL(response.headers.get("location")!).searchParams.get("error"), "invalid_target");
    });
    await suite.test("phone consent binds current user/session, rejects CSRF and delegated self-approval", async () => {
      const request = await begin(client);
      const anonymous = await fetch(`${appOrigin}/account/authorize?request=${request.requestId}`, { redirect: "manual" });
      assert.equal(anonymous.status, 307); assert.ok(anonymous.headers.get("location")?.startsWith("/signin?returnTo="));
      const page = await fetch(`${appOrigin}/account/authorize?request=${request.requestId}`, { headers: uiHeaders() });
      assert.equal(page.status, 200); assert.equal(page.headers.get("x-frame-options"), "DENY");
      assert.equal((await bind(request.requestId)).status, 200);
      assert.equal((await bind(request.requestId, cookieB)).status, 403);
      const body = JSON.stringify({ requestId: request.requestId, decision: "approve", scopes: request.scopes });
      assert.equal((await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: { ...uiHeaders(), Origin: "https://wrong.example" }, body })).status, 403);
      assert.equal((await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: { Origin: appOrigin, "Content-Type": "application/json", Authorization: "Bearer synthetic-not-a-browser-session" }, body })).status, 401);
    });
    let tokens: Tokens;
    await suite.test("HTTP PKCE code exchange is one use and resource-bound", async () => {
      const request = await begin(client), code = await approve(request);
      const wrong = await form("/token", { client_id: client.client_id, grant_type: "authorization_code", code, code_verifier: randomBytes(32).toString("base64url"), redirect_uri: "https://client.example/callback", resource: config.resourceUrl.href });
      assert.equal(wrong.status, 400);
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "authorization_code", code, code_verifier: request.verifier, redirect_uri: "https://client.example/callback", resource: "https://wrong.example/mcp" })).status, 400);
      const response = await exchange(client, request, code); assert.equal(response.status, 200); tokens = await response.json() as Tokens;
      assert.equal((await exchange(client, request, code)).status, 400);
      assert.match(tokens.access_token, /^tc_at_/); assert.match(tokens.refresh_token, /^tc_rt_/);
      const stored = await prisma.oAuthToken.findMany({ where: { grant: { clientId: client.client_id } } });
      assert.equal(stored.some((row) => row.tokenHash === tokens.access_token || row.tokenHash === tokens.refresh_token), false);
    });
    await suite.test("remote bearer MCP executes real shared queries and denies broader commands/audiences", async () => {
      const anonymous = await mcp(); assert.equal(anonymous.status, 401); assert.ok(anonymous.headers.get("www-authenticate")?.includes("oauth-protected-resource/mcp"));
      const initialized = await mcp(tokens.access_token); assert.equal(initialized.status, 200); assert.ok((await initialized.json() as Rpc).result?.protocolVersion);
      const query = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "warehouse_lookup", arguments: { kind: "lpn", value: lpn } } });
      assert.equal(query.status, 200); assert.ok((await query.json() as Rpc).result?.content?.[0].text.includes(lpn));
      const denied = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "application_action", arguments: { action: "identity.users", input: {} } } });
      assert.equal(denied.status, 200); assert.equal((await denied.json()).result.isError, true);
      const principal = await authenticateOAuthAccessToken(tokens.access_token, config);
      await assert.rejects(identity.listSessions(principal));
      const security = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "application_action", arguments: { action: "identity.sessions", input: {} } } });
      assert.equal(security.status, 200); assert.equal((await security.json()).result.isError, true);
      const grantId = principal.grantId!.slice(6);
      await prisma.oAuthGrant.update({ where: { id: grantId }, data: { resource: `${origin}/wrong` } });
      assert.equal((await mcp(tokens.access_token)).status, 401);
      await prisma.oAuthGrant.update({ where: { id: grantId }, data: { resource: config.resourceUrl.href } });
      const delegated = await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: { Origin: appOrigin, "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ requestId: "none", decision: "approve", scopes: ["inventory.read"] }) });
      assert.equal(delegated.status, 401);
    });
    await suite.test("refresh rotates; replay commits family revocation and concurrent refresh accepts at most once", async () => {
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: "https://wrong.example/mcp" })).status, 400);
      const rotated = await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: config.resourceUrl.href });
      assert.equal(rotated.status, 200); const replacement = await rotated.json() as Tokens;
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: config.resourceUrl.href })).status, 400);
      assert.equal((await mcp(replacement.access_token)).status, 401);
      const fresh = await authorize(client);
      const responses = await Promise.all([0, 1].map(() => form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: fresh.refresh_token, resource: config.resourceUrl.href })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
      const success = await responses.find((response) => response.status === 200)!.json() as Tokens;
      assert.equal((await mcp(success.access_token)).status, 401);
    });
    await suite.test("refresh cannot enlarge scope and narrowing bounds previously resolved writer authority", async () => {
      const fresh = await authorize(client);
      const before = await authenticateOAuthAccessToken(fresh.access_token, config);
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: fresh.refresh_token, resource: config.resourceUrl.href, scope: "users.manage" })).status, 400);
      const narrowed = await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: fresh.refresh_token, resource: config.resourceUrl.href, scope: "inventory.read" });
      assert.equal(narrowed.status, 200);
      assert.equal((await authenticateOAuthAccessToken(fresh.access_token, config)).capabilities.includes("workflow.read"), false);
      await assert.rejects(prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, before, "workflow.read")));
    });
    await suite.test("current owner grant revocation also blocks an already-resolved writer principal", async () => {
      const fresh = await authorize(client), actor = await authenticateOAuthAccessToken(fresh.access_token, config), id = actor.grantId!.slice(6);
      const revoked = await fetch(`${appOrigin}/api/oauth-consent`, { method: "DELETE", headers: uiHeaders(), body: JSON.stringify({ id }) });
      assert.equal(revoked.status, 200);
      assert.equal((await mcp(fresh.access_token)).status, 401);
      await assert.rejects(prisma.$transaction((tx) => identity.assertCurrentPrincipal(tx, actor, "inventory.read")));
      const own = await fetch(`${appOrigin}/api/oauth-consent`, { headers: uiHeaders() }); assert.equal(own.status, 200);
      const other = await fetch(`${appOrigin}/api/oauth-consent`, { headers: uiHeaders(cookieB) }); assert.equal((await other.json()).grants.length, 0);
    });
    await suite.test("privileged consent requires actual password and authenticator proof through HTTP", async () => {
      const request = await begin(client, ["users.manage"]); assert.equal((await bind(request.requestId)).status, 200);
      const body = JSON.stringify({ requestId: request.requestId, decision: "approve", scopes: request.scopes });
      assert.equal((await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: uiHeaders(), body })).status, 403);
      const setup = await fetch(`${appOrigin}/api/account/security/mfa`, { method: "POST", headers: uiHeaders(), body: JSON.stringify({ action: "begin", input: { password } }) });
      assert.equal(setup.status, 200); const secret = (await setup.json()).secret as string;
      const confirmed = await fetch(`${appOrigin}/api/account/security/mfa`, { method: "POST", headers: uiHeaders(), body: JSON.stringify({ action: "confirm", input: { token: await generate({ secret }) } }) });
      assert.equal(confirmed.status, 200);
      assert.equal((await fetch(`${appOrigin}/api/oauth-consent`, { method: "POST", headers: uiHeaders(), body })).status, 200);
    });
    await suite.test("disabled client and locked issuing session revoke remote access and refresh", async () => {
      const fresh = await authorize(client);
      await prisma.oAuthClient.update({ where: { id: client.client_id }, data: { disabledAt: new Date() } });
      assert.equal((await mcp(fresh.access_token)).status, 401);
      await prisma.oAuthClient.update({ where: { id: client.client_id }, data: { disabledAt: null } });
      const locked = await fetch(`${appOrigin}/api/account/security`, { method: "POST", headers: uiHeaders(), body: JSON.stringify({ action: "lock" }) });
      assert.equal(locked.status, 200);
      assert.equal((await mcp(fresh.access_token)).status, 401);
      assert.equal((await form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: fresh.refresh_token, resource: config.resourceUrl.href })).status, 400);
    });
  } finally {
    if (next.exitCode === null && next.signalCode === null) { const stopped = once(next, "exit"); next.kill("SIGTERM"); await stopped; }
    oauthServer.closeAllConnections(); await new Promise<void>((resolve) => oauthServer.close(() => resolve()));
    await prisma.user.deleteMany({ where: { id: { in: people.map((person) => person.id) } } });
    await prisma.oAuthClient.deleteMany({ where: { id: { in: clients } } });
    await prisma.inventoryAuditItem.deleteMany({ where: { lpn } });
    await prisma.identityAudit.deleteMany({ where: { targetUserId: { in: people.map((person) => person.id) } } });
    await prisma.$disconnect();
  }
});
