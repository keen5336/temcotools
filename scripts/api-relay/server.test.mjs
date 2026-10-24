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
  const relay = createApiRelayServer({ secret, allowedOrigins: [origin], heartbeatMs: 60000, ...options });
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
