import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sealData, unsealData } from "iron-session";
import bcrypt from "bcryptjs";
import WebSocket from "ws";
import { DEFAULT_RELAY_PROGRAM } from "../../lib/api-relay/default-program";
import { controlKey, createApiRelayServer } from "../api-relay/server.mjs";
import { createRelayServer } from "../label-relay/server.mjs";

const base = process.env.AUTH_TEST_APP_URL, database = process.env.AUTH_TEST_DATABASE_URL;
const secret = "synthetic-auth-test-session-secret-long-enough";
test("real HTTP login, migration, cookies, account APIs and live relay revocation", { skip: !base || !database }, async t => {
  assert.equal(base, "http://127.0.0.1:33021");
  const target = new URL(database!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55476"); assert.equal(target.pathname, "/auth_qa");
  process.env.DATABASE_URL = database; process.env.SESSION_SECRET = secret;
  const { prisma } = await import("../../lib/db");
  const { issueOperatorCode } = await import("../../lib/auth/identity");
  const request = (path: string, cookie = "", body?: unknown, origin: string | null = base!) => fetch(base + path, { method: body === undefined ? "GET" : "POST", redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookieOf = (response: Response) => { const value = response.headers.get("set-cookie"); assert.ok(value?.startsWith("temco_session="), "session cookie installed"); return value!.split(";")[0]; };
  const claims = (cookie: string) => unsealData<{ userId: string; sessionId: string; authVersion: number }>(cookie.slice(cookie.indexOf("=") + 1), { password: secret });
  const prefix = `auth-http-${randomUUID().slice(0, 8)}-`;
  const createUser = async (name: string, role: "user" | "admin") => prisma.user.create({ data: { id: prefix + name, username: prefix + name, displayName: name, role, pinHash: await bcrypt.hash("1234", 4) } });
  await prisma.apiRelayRevision.deleteMany({ where: { relayId: "auth-qa-relay" } });
  await prisma.apiRelayDefinition.deleteMany({ where: { id: "auth-qa-relay" } });
  const owner = await createUser("admin", "admin"), staff = await createUser("staff", "user");
  const password = "cedar sunset"; // exactly 12 characters
  let adminCookie = "", staffCookie = "", secondCookie = "";
  const broker = createApiRelayServer({ secret, managedOrigins: true, maxConcurrent: 1, heartbeatMs: 60000, authorize: async (binding: unknown) => {
    const response = await fetch(base + "/api/internal/relay-authorization", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Relay-Key": controlKey(secret) }, body: JSON.stringify(binding) });
    return response.ok && (await response.json()).ok === true;
  } });
  broker.server.listen(33023, "127.0.0.1"); await once(broker.server, "listening");
  t.after(() => broker.close());
  const label = createRelayServer({ origin: base, heartbeatInterval: 60000, authenticate: async (cookie: string) => {
    const response = await request("/api/label-relay/session", cookie); return response.ok ? response.json() : null;
  } });
  label.server.listen(0, "127.0.0.1"); await once(label.server, "listening"); t.after(() => label.close());
  const labelAddress = label.server.address(); assert.ok(labelAddress && typeof labelAddress !== "string");
  const labelPort = labelAddress.port;
  try {
    await t.test("PIN and old signed-cookie claims cannot reach tools, relays or account admin", async () => {
      const legacy = "temco_session=" + await sealData({ userId: staff.id, username: staff.username, role: "admin", isActive: true }, { password: secret, ttl: 86400 });
      for (const path of ["/api/admin/users", "/api/label-relay/session", "/api/pick-waves/locations", "/api/account/security"]) assert.equal((await request(path, legacy)).status, 401);
      const home = await request("/", legacy); assert.equal(home.status, 307); assert.equal(new URL(home.headers.get("location")!, base).pathname, "/account/update");
      assert.equal((await request("/api/auth/login", "", { username: staff.username, pin: "1234" }, null)).status, 403);
      const tooBig = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: base!, "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(12000) }) }); assert.equal(tooBig.status, 413);
      const start = await request("/api/auth/login", "", { username: staff.username, pin: "1234" }); assert.equal(start.status, 200);
      const restricted = cookieOf(start); assert.equal((await start.json()).redirectTo, "/account/update");
      assert.equal((await request("/api/pick-waves/locations", restricted)).status, 401);
      assert.equal((await request("/api/api-relay/pair", restricted, { origin: "https://auth-qa.test" })).status, 401);
      assert.equal((await request("/api/admin/account-codes", restricted, { userId: staff.id, purpose: "enroll", operationId: randomUUID(), reason: "synthetic takeover" })).status, 401);
      const denied = new WebSocket(`ws://127.0.0.1:${labelPort}/api/label-relay/ws`, { origin: base, headers: { Cookie: restricted } }); denied.on("error", () => {});
      const status = await new Promise(resolve => denied.on("unexpected-response", (_req, response) => { response.resume(); resolve(response.statusCode); denied.terminate(); })); assert.equal(status, 401);
      assert.ok((await (await request("/account/update", restricted)).text()).includes("12 characters"));
    });
    await t.test("independent admin code updates existing identity, installs 30-day cookie and disables old PIN", async () => {
      const first = await issueOperatorCode(owner.id, "enroll", "synthetic HTTP bootstrap");
      const updateAdmin = await request("/api/auth/update", "", { username: owner.username, code: first.code, password: "Synthetic administrator path 17" }); assert.equal(updateAdmin.status, 200); adminCookie = cookieOf(updateAdmin);
      const response = await request("/api/admin/account-codes", adminCookie, { userId: staff.id, purpose: "enroll", operationId: randomUUID(), reason: "verified HTTP synthetic staff" }); assert.equal(response.status, 200);
      const code = (await response.json()).code;
      const input = { username: staff.username, code, password, deviceName: "Assigned HTTP Zebra" };
      assert.equal((await request("/api/auth/update", "", { ...input, password: "short words" })).status, 400);
      const update = await request("/api/auth/update", "", input); assert.equal(update.status, 200); staffCookie = cookieOf(update);
      const header = update.headers.get("set-cookie")!; assert.ok(/HttpOnly/i.test(header) && /Secure/i.test(header) && /SameSite=lax/i.test(header)); assert.ok(header.includes("Max-Age=2591940"));
      const data = await claims(staffCookie); assert.equal(data.userId, staff.id); assert.ok(!("role" in data));
      assert.equal((await request("/api/auth/update", "", input)).status, 400);
      assert.equal((await request("/api/auth/login", "", { username: staff.username, pin: "1234" })).status, 401);
      assert.equal((await request("/api/pick-waves/locations", staffCookie)).status, 200);
      assert.equal((await request("/api/label-relay/session", staffCookie)).status, 200);
      assert.equal((await request("/api/admin/users", staffCookie)).status, 403);
      assert.equal((await request("/api/admin/users", adminCookie)).status, 200);
      const signed = await request("/api/auth/login", "", { username: staff.username, password, deviceName: "Assigned HTTP laptop" }); assert.equal(signed.status, 200); secondCookie = cookieOf(signed);
      assert.ok((await (await request("/account/security", secondCookie)).text()).includes("Signed-in devices"));
    });
    await t.test("sensitive publishing requires recent password confirmation", async () => {
      const data = await claims(adminCookie);
      await prisma.authSession.update({ where: { id: data.sessionId }, data: { reauthenticatedAt: new Date(Date.now() - 11 * 60_000) } });
      for (const path of ["/api/admin/users", "/api/admin/account-codes", "/api/admin/api-relays", "/api/driver-paperwork/templates"]) assert.equal((await request(path, adminCookie, {})).status, path === "/api/admin/users" || path === "/api/admin/account-codes" ? 400 : 403);
      // Valid user mutation is blocked specifically by step-up, not parsing.
      assert.equal((await request("/api/admin/users", adminCookie, { username: "synthetic-new", displayName: "Synthetic" })).status, 403);
      assert.equal((await request("/api/account/security", adminCookie, { action: "reauthenticate", password: "Synthetic administrator path 17" })).status, 200);
    });
    await t.test("revoking the creating session cancels queued relay work while another device remains signed in", async () => {
      const rule = { id: "auth-qa-relay", name: "Synthetic relay", enabled: true, origins: ["https://auth-qa.test"], pathPrefix: "/", identityPath: "/me", subjectPath: "user.id", operations: { item: { label: "Item", path: "/item/{id}" } }, program: DEFAULT_RELAY_PROGRAM, expectedRevision: 0, operationId: randomUUID() };
      const definition = await request("/api/admin/api-relays", adminCookie, rule); assert.equal(definition.status, 200);
      const paired = await request("/api/api-relay/pair", staffCookie, { origin: "https://auth-qa.test", pathname: "/", relayId: rule.id, relayRevision: 1 }); assert.equal(paired.status, 200);
      const token = (await paired.json()).token;
      const ws = new WebSocket("ws://127.0.0.1:33023/api/api-relay/ws", { origin: "https://auth-qa.test" });
      const messages: { type: string; connectionId: string; requestId: string; request: { path: string } }[] = [];
      const waiters: { type: string; resolve: (message: typeof messages[number]) => void }[] = [];
      ws.on("message", raw => { const message = JSON.parse(raw.toString()); messages.push(message); const index = waiters.findIndex(item => item.type === message.type); if (index >= 0) waiters.splice(index, 1)[0].resolve(message); });
      const next = (type: string) => new Promise<typeof messages[number]>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`No ${type} message`)), 5000); waiters.push({ type, resolve: message => { clearTimeout(timer); resolve(message); } }); });
      await once(ws, "open"); const pair = next("paired"); ws.send(JSON.stringify({ type: "pair", token })); const connectionId = (await pair).connectionId;
      const ready = next("ready"); ws.send(JSON.stringify({ type: "identity", subject: "synthetic-user" })); await ready;
      const command = next("request"); const first = request("/api/api-relay/request", secondCookie, { connectionId, operation: "item", input: { id: "first" } }); const job = await command;
      const queued = request("/api/api-relay/request", secondCookie, { connectionId, operation: "item", input: { id: "never-send" } });
      let queuedCount = 0;
      for (let round = 0; round < 20 && queuedCount !== 2; round++) { const status = await request("/api/api-relay/status", secondCookie, {}); queuedCount = (await status.json()).connections[0]?.pending || 0; }
      assert.equal(queuedCount, 2);
      const creator = await claims(staffCookie);
      assert.equal((await request("/api/account/security", secondCookie, { action: "revoke-session", sessionId: creator.sessionId })).status, 200);
      ws.send(JSON.stringify({ type: "result", requestId: job.requestId, ok: true, status: 200, subject: "synthetic-user", body: "synthetic result" }));
      assert.equal((await (await first).json()).ok, true);
      assert.equal((await (await queued).json()).ok, false);
      assert.ok(!messages.some(message => message.type === "request" && message.request.path.includes("never-send")));
      assert.equal((await request("/api/pick-waves/locations", staffCookie)).status, 401);
      assert.equal((await request("/api/pick-waves/locations", secondCookie)).status, 200);
      ws.terminate();
    });
    await t.test("label commands and replayed cookies stop immediately after durable logout", async () => {
      assert.equal((await request("/api/account/security", secondCookie, { action: "revoke-session", sessionId: "" })).status, 400);
      const ws = new WebSocket(`ws://127.0.0.1:${labelPort}/api/label-relay/ws`, { origin: base, headers: { Cookie: secondCookie } });
      await once(ws, "open");
      assert.equal((await request("/api/auth/logout", secondCookie, {})).status, 200);
      const closed = once(ws, "close"); ws.send(JSON.stringify({ type: "status" })); await closed;
      assert.equal((await request("/api/pick-waves/locations", secondCookie)).status, 401);
      assert.equal((await request("/api/label-relay/session", secondCookie)).status, 401);
    });
    await t.test("confirmed administrator self-recovery returns a code even though its old session ends", async () => {
      const created = await request("/api/admin/users", adminCookie, { username: prefix + "backup", displayName: "Synthetic backup", role: "admin" }); assert.equal(created.status, 200);
      const backup = await created.json();
      const setup = await request("/api/admin/account-codes", adminCookie, { userId: backup.id, purpose: "enroll", operationId: randomUUID(), reason: "synthetic backup administrator" }); assert.equal(setup.status, 200);
      const updated = await request("/api/auth/update", "", { username: backup.username, code: (await setup.json()).code, password: "Synthetic backup cedar 41" }); assert.equal(updated.status, 200);
      const recovery = await request("/api/admin/account-codes", adminCookie, { userId: owner.id, purpose: "reset", operationId: randomUUID(), reason: "synthetic self recovery" }); assert.equal(recovery.status, 200);
      const result = await recovery.json(); assert.ok(result.code);
      assert.equal((await request("/api/admin/users", adminCookie)).status, 401);
      const restored = await request("/api/auth/update", "", { username: owner.username, code: result.code, password: "Synthetic recovered admin 44" }); assert.equal(restored.status, 200);
      assert.equal((await request("/api/admin/users", cookieOf(restored))).status, 200);
    });
  } finally {
    await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await prisma.apiRelayRevision.deleteMany({ where: { relayId: "auth-qa-relay" } });
    await prisma.apiRelayDefinition.deleteMany({ where: { id: "auth-qa-relay" } });
    await prisma.$disconnect();
  }
});
