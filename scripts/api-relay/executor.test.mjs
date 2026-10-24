import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const protocol = readFileSync(new URL("./protocol.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const executor = readFileSync(new URL("./executor.mjs", import.meta.url), "utf8").replace(/^export /gm, "");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const elements = [], events = new Map(), sockets = [], requests = [], responses = new Map();
  const popup = { closed: false, close() { this.closed = true; } };
  const element = (tag) => {
    const el = { tag, textContent: "", style: {}, children: [], append(...children) { this.children.push(...children); }, remove() { this.removed = true; }, setAttribute() {}, attachShadow() { return element("shadow"); } };
    elements.push(el); return el;
  };
  const window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name), open: () => popup };
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    message(message) { return this.onmessage({ data: JSON.stringify(message) }); }
  }
  let identity = "user-one";
  const context = vm.createContext({ window, document: { createElement: element, createTextNode: (s) => s, body: element("body") }, location: { origin: "https://dmp.test" }, WebSocket: Socket, URL, AbortController, TextEncoder, TextDecoder, crypto: { randomUUID: () => "test-nonce" }, alert: (s) => { throw new Error(s); }, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async (url, options) => {
    requests.push({ url, ...options });
    if (new URL(url).pathname === "/identity/me") return new Response(JSON.stringify({ subject: identity }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (responses.has(new URL(url).pathname)) return responses.get(new URL(url).pathname)(options);
    return new Response("data", { status: 200 });
  } });
  vm.runInContext(`(()=>{${protocol}\n${executor}\nstartDmpRelay({temcoOrigin:'https://temco.test',wsUrl:'wss://temco.test/api/api-relay/ws',allowedOrigins:['https://dmp.test'],maxConcurrent:4,maxResponseBytes:64});})();`, context);
  t.after(() => window.__temcoApiRelay?.stop());
  const connect = elements.find((e) => e.tag === "button" && e.textContent === "Connect");
  connect.onclick();
  const pair = async (overrides = {}) => events.get("message")({ origin: "https://temco.test", source: popup, data: { type: "temco-api-relay-pair", nonce: "test-nonce", token: "token" }, ...overrides });
  const ready = async () => {
    await pair(); const ws = sockets.at(-1); ws.onopen();
    await ws.message({ type: "paired", identity: { path: "/identity/me", timeoutMs: 1000 }, subjectPath: "subject" });
    await ws.message({ type: "ready" }); return ws;
  };
  return { sockets, requests, responses, pair, ready, popup, identity: (value) => { identity = value; }, events, window };
}

test("executor accepts pairing only from the expected Temco popup and nonce", async (t) => {
  const f = fixture(t);
  await f.pair({ origin: "https://evil.test" }); await f.pair({ source: {} }); await f.pair({ data: { type: "temco-api-relay-pair", nonce: "wrong", token: "token" } });
  assert.equal(f.sockets.length, 0);
  const ws = await f.ready(); assert.equal(ws.sent[0].type, "pair"); assert.equal(ws.sent[1].subject, "user-one");
});

test("executor uses same-origin credentials and rejects redirects and cross-origin jobs", async (t) => {
  const f = fixture(t), ws = await f.ready();
  await ws.message({ type: "request", requestId: "one", request: { path: "/api/data" } }); await tick(); await tick();
  const request = f.requests.find((r) => r.url.endsWith("/api/data"));
  assert.equal(request.credentials, "same-origin"); assert.equal(request.mode, "same-origin"); assert.equal(request.redirect, "error");
  assert.equal(ws.sent.find((m) => m.requestId === "one").body, "data");
  await ws.message({ type: "request", requestId: "evil", request: { path: "//evil.test" } }); await tick();
  assert.equal(ws.sent.find((m) => m.requestId === "evil").ok, false);
  assert.equal(f.requests.some((r) => r.url.includes("evil.test")), false);
});

test("executor permits out-of-order completion with independent request IDs", async (t) => {
  const f = fixture(t), ws = await f.ready();
  let resolveSlow;
  f.responses.set("/slow", () => new Promise((resolve) => { resolveSlow = resolve; }));
  await ws.message({ type: "request", requestId: "slow", request: { path: "/slow" } }); await tick();
  await ws.message({ type: "request", requestId: "fast", request: { path: "/fast" } }); await tick(); await tick();
  assert.deepEqual(ws.sent.filter((m) => m.type === "result").map((m) => m.requestId), ["fast"]);
  resolveSlow(new Response("slow")); await tick(); await tick();
  assert.deepEqual(ws.sent.filter((m) => m.type === "result").map((m) => m.requestId), ["fast", "slow"]);
});

test("executor catches an account switch before sending the requested API call", async (t) => {
  const f = fixture(t), ws = await f.ready(); f.identity("user-two");
  await ws.message({ type: "request", requestId: "one", request: { path: "/api/private" } }); await tick(); await tick();
  assert.equal(f.requests.some((r) => r.url.endsWith("/api/private")), false);
  assert.equal(ws.sent.some((m) => m.type === "identity-changed"), true);
  assert.equal(ws.readyState, 3);
});

test("executor detects an account change during a request and withholds its result", async (t) => {
  const f = fixture(t), ws = await f.ready();
  f.responses.set("/switch", () => { f.identity("user-two"); return new Response("private response"); });
  await ws.message({ type: "request", requestId: "one", request: { path: "/switch" } }); await tick(); await tick();
  assert.equal(ws.sent.some((m) => m.type === "result" && m.ok === true), false);
  assert.equal(ws.sent.some((m) => m.type === "identity-changed"), true);
});

test("executor bounds streamed response size", async (t) => {
  const f = fixture(t), ws = await f.ready();
  f.responses.set("/large", () => new Response("x".repeat(65)));
  await ws.message({ type: "request", requestId: "large", request: { path: "/large" } }); await tick(); await tick();
  assert.match(ws.sent.find((m) => m.requestId === "large").error, /too large/);
});

test("executor aborts cancelled work without retrying", async (t) => {
  const f = fixture(t), ws = await f.ready();
  f.responses.set("/slow", ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
  await ws.message({ type: "request", requestId: "slow", request: { path: "/slow" } }); await tick();
  await ws.message({ type: "cancel", requestId: "slow" }); await tick();
  assert.match(ws.sent.find((m) => m.requestId === "slow").error, /cancelled/);
  assert.equal(f.requests.filter((r) => r.url.endsWith("/slow")).length, 1);
});
