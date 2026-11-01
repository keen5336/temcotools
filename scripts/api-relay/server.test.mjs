import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { controlKey, createApiRelayServer } from "./server.mjs";

const secret = "api-relay-test-secret-at-least-32-characters";
const origin = "https://dmp.test";
const alice = { userId: "alice", sessionId: "alice-session" };
const bob = { userId: "bob", sessionId: "bob-session" };
const identity = { path: "/api/me", timeoutMs: 1000 };

async function fixture(t, options = {}) {
  const relay = createApiRelayServer({ secret, allowedOrigins: [origin], heartbeatMs: 60000, authorize: async () => true, ...options });
  relay.server.listen(0, "127.0.0.1"); await once(relay.server, "listening");
  t.after(() => relay.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  async function control(action, owner = alice, data = {}, key = controlKey(secret)) {
    const res = await fetch(`${url}/control`, { method: "POST", headers: { "X-Api-Relay-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ action, owner, ...data }) });
    return { status: res.status, ...await res.json() };
  }
  async function token(owner = alice) {
    const result = await control("pair", owner, { origin, identity, subjectPath: "user.id" });
    assert.equal(result.status, 200);
    return result.token;
  }
  async function connect(tokenValue, wsOrigin = origin) {
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/api-relay/ws`, { origin: wsOrigin });
    const messages = [], waiters = [];
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex((w) => w.matches(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else messages.push(message);
    });
    const next = (type) => new Promise((resolve, reject) => {
      const index = messages.findIndex((m) => m.type === type);
      if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
      const timer = setTimeout(() => reject(new Error(`No ${type} message`)), 2000);
      waiters.push({ matches: (m) => m.type === type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "pair", token: tokenValue }));
    return { ws, next, messages, send: (m) => ws.send(JSON.stringify(m)) };
  }
  async function paired(owner = alice, subject = "dmp-alice") {
    const client = await connect(await token(owner));
    const result = await client.next("paired");
    client.send({ type: "identity", subject });
    await client.next("ready");
    return { ...client, id: result.connectionId, subject };
  }
  const request = (c, path = "/api/data", owner = alice, timeoutMs = 1000) => control("request", owner, { connectionId: c.id, request: { path, timeoutMs } });
  const respond = (c, job, body = "done", extra = {}) => c.send({ type: "result", requestId: job.requestId, ok: true, status: 200, body, subject: c.subject, ...extra });
  return { url, control, token, connect, paired, request, respond };
}

test("control authentication and exact DMP Origin are required", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control("connections", alice, {}, "wrong")).status, 401);
  assert.equal((await f.control("connections", alice, {}, "é".repeat(64))).status, 401);
  assert.equal((await f.control("connections")).status, 200);
  const ws = new WebSocket(`${f.url.replace("http:", "ws:")}/api/api-relay/ws`, { origin: "https://attacker.test" });
  ws.on("error", () => {});
  const status = await new Promise((resolve) => ws.on("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); }));
  assert.equal(status, 403);
});

test("pairing tokens are one-use and cannot choose their owner", async (t) => {
  const f = await fixture(t);
  const token = await f.token();
  const first = await f.connect(token); await first.next("paired");
  const replay = await f.connect(token);
  assert.equal((await once(replay.ws, "close"))[0], 1008);
  assert.equal((await f.control("connections", bob)).connections.length, 0);
});

test("expired tokens and tokens revoked by logout cannot connect", async (t) => {
  const f = await fixture(t, { pairMs: 1 });
  const expired = await f.token();
  // A round trip deterministically outlives the one-millisecond token lease.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const c = await f.connect(expired);
  assert.equal((await once(c.ws, "close"))[0], 1008);
  const g = await fixture(t);
  const revoked = await g.token(); await g.control("revoke");
  const d = await g.connect(revoked);
  assert.equal((await once(d.ws, "close"))[0], 1008);
});

test("connection lists, requests, and disconnects are isolated per Temco user", async (t) => {
  const f = await fixture(t);
  const a = await f.paired(), b = await f.paired(bob, "dmp-bob");
  assert.deepEqual((await f.control("connections")).connections.map((c) => c.id), [a.id]);
  assert.deepEqual((await f.control("connections", bob)).connections.map((c) => c.id), [b.id]);
  assert.equal((await f.request(a, "/api/data", bob)).status, 404);
  assert.equal((await f.control("disconnect", bob, { connectionId: a.id })).status, 404);
  assert.equal(a.messages.length, 0);
});

test("concurrent requests are correlated when results finish out of order", async (t) => {
  const f = await fixture(t);
  const c = await f.paired();
  const first = f.request(c, "/api/one"); const a = await c.next("request");
  const second = f.request(c, "/api/two"); const b = await c.next("request");
  assert.notEqual(a.requestId, b.requestId);
  f.respond(c, b, "second"); f.respond(c, a, "first");
  assert.equal((await first).body, "first"); assert.equal((await second).body, "second");
});

test("a different connection cannot submit another connection's results", async (t) => {
  const f = await fixture(t);
  const a = await f.paired(), b = await f.paired(bob, "dmp-bob");
  const result = f.request(a); const job = await a.next("request");
  f.respond(b, job, "forged"); f.respond(a, job, "real");
  assert.equal((await result).body, "real");
});

test("queue bounds and per-tab concurrency do not serialize other users", async (t) => {
  const f = await fixture(t, { maxConcurrent: 1, maxQueue: 2 });
  const a = await f.paired(), b = await f.paired(bob, "dmp-bob");
  const one = f.request(a, "/one"); const job1 = await a.next("request");
  const two = f.request(a, "/two");
  // Await a separate control round trip to allow the second request to queue.
  await f.control("connections");
  assert.equal((await f.request(a, "/full")).status, 429);
  const other = f.request(b, "/other", bob); const jobB = await b.next("request");
  f.respond(b, jobB, "bob"); assert.equal((await other).body, "bob");
  assert.equal(a.messages.filter((m) => m.type === "request").length, 0);
  f.respond(a, job1); await one;
  const job2 = await a.next("request"); assert.equal(job2.request.path, "/two"); f.respond(a, job2); await two;
});

test("queued authorization is rechecked before send without replaying or ending unrelated work", async (t) => {
  let authorized = true;
  const f = await fixture(t, { maxConcurrent: 1, authorize: async () => authorized });
  const c = await f.paired();
  const first = f.request(c, "/already-running"), running = await c.next("request");
  const queued = f.request(c, "/must-not-send");
  await f.control("connections");
  authorized = false;
  f.respond(c, running, "original result");
  assert.equal((await first).body, "original result");
  const denied = await queued;
  assert.equal(denied.ok, false); assert.match(denied.error, /not dispatched/);
  assert.equal(c.messages.some(message => message.type === "request" && message.request.path === "/must-not-send"), false);
  authorized = true;
  const next = f.request(c, "/new-authorized-intent"), job = await c.next("request");
  assert.equal(job.request.path, "/new-authorized-intent");
  f.respond(c, job, "new result"); assert.equal((await next).body, "new result");
});
test("authorization receives the captured request method rather than trusting a later operation classification", async t => {
  const methods = [];
  const f = await fixture(t, { authorize: async (_owner, context) => { methods.push(context.requestMethod); return context.requestMethod === "GET"; } });
  const c = await f.paired();
  const denied = await f.control("request", alice, { connectionId: c.id, operation: "synthetic", request: { method: "POST", path: "/synthetic-only", body: "{}" } });
  assert.equal(denied.ok, false); assert.equal(denied.dispatchState, "not_dispatched");
  assert.deepEqual(methods, ["POST"]); assert.equal(c.messages.some(message => message.type === "request"), false);
});

test("timeout cancels a job, ignores late results, and does not retry", async (t) => {
  const f = await fixture(t);
  const c = await f.paired();
  const result = f.request(c, "/slow", alice, 100); const job = await c.next("request");
  assert.match((await result).error, /timed out/);
  assert.equal((await c.next("cancel")).requestId, job.requestId);
  f.respond(c, job, "late");
  const next = f.request(c, "/next"); const job2 = await c.next("request");
  assert.equal(job2.request.path, "/next"); f.respond(c, job2, "next"); assert.equal((await next).body, "next");
});

test("logout revokes only its creating session and settles outstanding work", async (t) => {
  const f = await fixture(t);
  const a = await f.paired(), b = await f.paired(bob, "dmp-bob");
  const result = f.request(a); await a.next("request");
  await f.control("revoke"); assert.match((await result).error, /session ended/);
  assert.equal((await f.control("connections", bob)).connections[0].id, b.id);
});

test("session leases expire without an authenticated Temco tab", async (t) => {
  const f = await fixture(t, { leaseMs: 60, heartbeatMs: 20 });
  const c = await f.paired();
  await once(c.ws, "close");
  assert.equal((await f.control("connections")).connections.length, 0);
});

test("renewing an expired lease cannot revive old connections before the sweep", async (t) => {
  const f = await fixture(t, { leaseMs: 40, heartbeatMs: 60000 });
  await f.paired();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await f.control("lease");
  assert.equal((await f.control("connections")).connections.length, 0);
});

test("logout preserves another authenticated session of the same user", async (t) => {
  const f = await fixture(t);
  await f.paired();
  const secondSession = { userId: alice.userId, sessionId: "alice-another-session" };
  const second = await f.paired(secondSession);
  await f.control("revoke", alice);
  assert.deepEqual((await f.control("connections", secondSession)).connections.map((c) => c.id), [second.id]);
});

test("DMP identity change disconnects and fails pending requests", async (t) => {
  const f = await fixture(t);
  const c = await f.paired();
  const result = f.request(c); await c.next("request");
  c.send({ type: "identity-changed" }); assert.match((await result).error, /account changed/);
  assert.equal((await f.control("connections")).connections.length, 0);
});

test("off-origin paths and credential headers are rejected before dispatch", async (t) => {
  const f = await fixture(t); const c = await f.paired();
  for (const request of [{ path: "https://evil.test" }, { path: "//evil.test/api" }, { path: "/\\evil.test" }, { path: "/api", headers: { Cookie: "secret" } }, { path: "/api", method: "TRACE" }]) {
    assert.equal((await f.control("request", alice, { connectionId: c.id, request })).status, 400);
  }
  assert.equal(c.messages.length, 0);
});

test("broker disconnect fails jobs without replaying to a spare tab", async (t) => {
  const f = await fixture(t); const c = await f.paired(); const spare = await f.paired();
  const result = f.request(c); await c.next("request"); c.ws.close();
  assert.match((await result).error, /not retried/);
  assert.equal(spare.messages.length, 0);
});

test("audience-bound control keys preserve the unset legacy key and isolate pilots", async t => {
  const { createHash } = await import("node:crypto");
  assert.equal(controlKey(secret, ""), createHash("sha256").update(`temco-api-relay-control-v1:${secret}`).digest("hex"));
  assert.notEqual(controlKey(secret, "pilot-a"), controlKey(secret, "pilot-b"));
  assert.throws(() => controlKey(secret, "bad audience"));
  const f = await fixture(t, { audience: "pilot-a" });
  assert.equal((await f.control("connections", alice, {}, controlKey(secret, ""))).status, 401);
  assert.equal((await f.control("connections", alice, {}, controlKey(secret, "pilot-b"))).status, 401);
  assert.equal((await f.control("connections", alice, {}, controlKey(secret, "pilot-a"))).status, 200);
});

test("same-user connections remain private to their exact creating session and grant", async t => {
  const f = await fixture(t), c = await f.paired();
  for (const requester of [{ ...alice, sessionId: "different-browser" }, { ...alice, grantId: "oauth:own-same-session" }]) {
    assert.deepEqual((await f.control("connections", requester)).connections, []);
    assert.equal((await f.request(c, "/private", requester)).status, 404);
    assert.equal((await f.control("disconnect", requester, { connectionId: c.id })).status, 404);
  }
  assert.equal((await f.control("connections", alice)).connections[0].id, c.id);
});

const remoteAlice = { userId: alice.userId, sessionId: "alice-home-browser", authSessionId: "auth-home", authVersion: 1, grantId: "oauth:home-client" };
const readApproval = (connectionId, requester = remoteAlice, operations = ["deliveries"]) => ({ connectionId, requester, operations, expiresAt: Date.now() + 60_000, operationConfigHash: "a".repeat(64) });

test("original browser explicitly shares named reads with one exact OAuth grant without transferring ownership", async t => {
  const seen = [];
  const f = await fixture(t, { authorize: async (requester, context) => { seen.push({ requester, context }); return true; } });
  const c = await f.paired();
  assert.deepEqual((await f.control("connections", remoteAlice)).connections, []);
  const approved = await f.control("share", alice, readApproval(c.id));
  assert.equal(approved.shared, true);
  const status = await f.control("connections", remoteAlice);
  assert.equal(status.connections[0].access, "shared_read");
  assert.deepEqual(status.connections[0].operations, ["deliveries"]);
  assert.equal((await f.control("connections", { ...remoteAlice, grantId: "oauth:other-client" })).connections.length, 0);
  assert.equal((await f.control("connections", { ...remoteAlice, sessionId: "changed-session" })).connections.length, 0);
  assert.equal((await f.control("disconnect", remoteAlice, { connectionId: c.id })).status, 404);
  assert.equal((await f.control("unshare", remoteAlice, { connectionId: c.id, shareId: approved.share.id })).status, 404);
  assert.equal((await f.control("share", remoteAlice, readApproval(c.id))).status, 404);
  assert.equal((await f.control("request", remoteAlice, { connectionId: c.id, operation: "session", request: { path: "/not-approved" } })).status, 404);
  assert.equal((await f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { method: "POST", path: "/not-a-read", body: "{}" } })).status, 403);
  const result = f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { path: "/synthetic-deliveries" } });
  const job = await c.next("request"); f.respond(c, job, "only synthetic response");
  assert.equal((await result).body, "only synthetic response");
  const dispatch = seen.find(row => row.context.share?.id === approved.share.id && row.context.requestMethod === "GET");
  assert.equal(dispatch.requester.grantId, remoteAlice.grantId); assert.deepEqual(dispatch.context.connectionOwner, alice);
  assert.equal((await f.control("connections", alice)).connections[0].access, "owner");
});

test("sharing rejects foreign users, non-OAuth grants, invalid scope bounds and excessive expiry", async t => {
  const f = await fixture(t), c = await f.paired();
  for (const data of [readApproval(c.id, bob), readApproval(c.id, { ...remoteAlice, grantId: "stdio-grant" }), { ...readApproval(c.id), operations: [] }, { ...readApproval(c.id), expiresAt: Date.now() + 61 * 60_000 }]) assert.equal((await f.control("share", alice, data)).status, 400);
  const denied = await fixture(t, { authorize: async () => false }), d = await denied.paired();
  assert.equal((await denied.control("share", alice, readApproval(d.id))).status, 403);
});

test("revoked or newly unauthorized shares never dispatch queued work or replay an in-flight read", async t => {
  let current = true;
  const f = await fixture(t, { maxConcurrent: 1, authorize: async () => current }), c = await f.paired();
  const approved = await f.control("share", alice, readApproval(c.id));
  const first = f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { path: "/already-sent" } });
  const sent = await c.next("request");
  const queued = f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { path: "/not-sent" } });
  await f.control("connections", alice);
  assert.equal((await f.control("unshare", alice, { connectionId: c.id, shareId: approved.share.id })).revoked, true);
  assert.equal((await queued).dispatchState, "not_dispatched");
  f.respond(c, sent); assert.equal((await first).dispatchState, "dispatched");
  assert.equal(c.messages.some(m => m.type === "request"), false);
  await f.control("share", alice, readApproval(c.id));
  const own = f.request(c, "/owner-running"), ownJob = await c.next("request");
  const later = f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { path: "/revoked-grant" } });
  await f.control("connections", alice); current = false; f.respond(c, ownJob); await own;
  assert.equal((await later).dispatchState, "not_dispatched");
  assert.deepEqual((await f.control("connections", remoteAlice)).connections, []);
});

test("remote access does not keep the original browser lease alive", async t => {
  const f = await fixture(t, { leaseMs: 60 }), c = await f.paired();
  await f.control("share", alice, readApproval(c.id));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual((await f.control("connections", remoteAlice)).connections, []);
  assert.equal((await f.control("request", remoteAlice, { connectionId: c.id, operation: "deliveries", request: { path: "/expired-owner" } })).status, 404);
});

test("pilot method gate prevents even a fully authorized owner POST before broker dispatch", async t => {
  const previous = process.env.TEMCO_PILOT_MODE;
  try {
    process.env.TEMCO_PILOT_MODE = "read_only_dmp";
    const f = await fixture(t), c = await f.paired();
    const denied = await f.control("request", alice, { connectionId: c.id, operation: "read-looking-rpc", request: { method: "POST", path: "/synthetic-only", body: "{}" } });
    assert.equal(denied.status, 403); assert.match(denied.error, /GET\/HEAD/);
    assert.equal(c.messages.some(m => m.type === "request"), false);
  } finally { if (previous === undefined) delete process.env.TEMCO_PILOT_MODE; else process.env.TEMCO_PILOT_MODE = previous; }
});
