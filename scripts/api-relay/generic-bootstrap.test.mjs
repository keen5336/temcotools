import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const code = ["../../lib/integrations/browser-executor.mjs", "../../lib/integrations/browser-bootstrap.mjs"].map(p => readFileSync(new URL(p, import.meta.url), "utf8").replace(/^export /gm, "")).join("\n");
function fixture(t, overrides = {}) {
  const origin = "https://synthetic-system.example.invalid", messages = [], elements = [], sockets = [], listeners = new Map(), timers = new Set();
  const popup = { closed: false, close() { this.closed = true; } }, location = { origin, pathname: "/warehouse/items", search: "?DO_NOT_CAPTURE", hash: "#DO_NOT_CAPTURE", ...overrides };
  const element = tag => { const e = { tag, style: {}, children: [], append(...children) { this.children.push(...children); }, attachShadow() { return element("shadow"); }, setAttribute() {}, remove() { this.removed = true; } }; elements.push(e); return e; };
  const window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key), open: url => { messages.push(url); return popup; } };
  class Socket { static OPEN = 1; constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(v) { this.sent.push(JSON.parse(v)); } close() { this.readyState = 3; } }
  const hash = "a".repeat(64), payload = { purpose: "integration_relay", payloadId: "synthetic-provider", versionId: "payload-v1", contentHash: hash, profileBinding: { profileId: "synthetic-profile", revision: 1, origin, pathname: location.pathname, pathPrefix: "/warehouse", payloadId: "synthetic-provider", versionId: "payload-v1", contentHash: hash } };
  const context = vm.createContext({ window, location, document: { createElement: element, body: element("body") }, WebSocket: Socket, URL, TextEncoder, TextDecoder, structuredClone, AbortController, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" }, alert: v => messages.push(v), confirm: () => false, setTimeout, clearTimeout, setInterval: fn => { const timer = setInterval(fn, 60000); timers.add(timer); return timer; }, clearInterval, fetch: async () => new Response('{"subject":"synthetic-person","warehouse":"synthetic-depot"}') });
  const boot = () => vm.runInContext(`(()=>{${code}\nstartGenericProvider({temcoOrigin:'https://temco.example.invalid',wsUrl:'wss://temco.example.invalid/api/integration-relay/ws'},${JSON.stringify(payload)});})();`, context);
  boot(); t.after(() => { window.__temcoGenericProvider?.stop(); for (const timer of timers) clearInterval(timer); });
  const approval = { id: "approval", mode: "synthetic", evidenceReference: "synthetic-only-fixture", requestContractHash: hash };
  const binding = { providerId: "provider-one", audience: "pilot:synthetic", siteId: "site-one", integrationId: "synthetic-system", owner: { userId: "user-one", sessionId: "session-one", deviceId: "device-one", tabId: "tab-one", authVersion: 1 }, origin, pagePathPrefix: "/warehouse", configurationVersion: "config-one", profileVersion: "synthetic-profile:1", adapterVersion: "1", payloadVersionId: "payload-v1", payloadHash: hash, actionVersionIds: ["identity-v1"], identity: { action: { versionId: "identity-v1", key: "identity", effect: "read", approval, request: { origin, path: "/synthetic-identity", method: "GET", timeoutMs: 1000, maxResponseBytes: 1000 } }, format: "json", subjectPath: ["subject"], warehousePath: ["warehouse"], expectedWarehouse: "synthetic-depot", contractId: "identity-contract", warehouseContractId: "warehouse-contract" } };
  const connect = () => elements.find(e => e.textContent === "Connect this tab").onclick();
  const pair = changes => listeners.get("message")({ origin: "https://temco.example.invalid", source: popup, data: { type: "temco-provider-pair", nonce: "00000000-0000-4000-8000-000000000000", token: "t".repeat(43), binding }, ...changes });
  return { boot, window, listeners, messages, sockets, popup, location, binding, connect, pair, elements };
}
test("generic payload reports only exact origin/path and requires its original human popup", async t => {
  const f = fixture(t); f.connect(); const url = new URL(f.messages[0]); assert.equal(url.pathname, "/tools/provider-connect"); assert.equal(url.searchParams.get("pathname"), "/warehouse/items"); assert.ok(!url.href.includes("DO_NOT_CAPTURE"));
  await f.pair({ origin: "https://evil.example.invalid" }); await f.pair({ source: {} }); assert.equal(f.sockets.length, 0);
  await f.pair(); assert.equal(f.sockets.length, 1); f.sockets[0].onopen(); const frame = f.sockets[0].sent[0]; assert.equal(frame.type, "pair"); assert.equal(frame.integrationId, "synthetic-system"); assert.equal(frame.siteId, "site-one"); assert.equal(frame.profileVersion, "synthetic-profile:1"); assert.equal(f.popup.closed, true);
  f.window.__temcoGenericProvider.stop(); assert.equal(f.sockets[0].readyState, 3); assert.equal(f.listeners.size, 0);
});
test("page navigation and mismatched immutable payload/config pins fail closed", async t => {
  const f = fixture(t); f.connect(); f.binding.payloadVersionId = "changed-payload"; await f.pair(); assert.equal(f.sockets.length, 0);
  f.location.pathname = "/other"; f.connect(); assert.match(f.elements.find(e => e.children?.some(c => c.textContent === "Connect this tab")).children[1].textContent, /outside/);
});
test("re-injection cannot replace busy DMP or generic work and pagehide disposes original resources", t => {
  const f = fixture(t), original = f.window.__temcoGenericProvider; f.window.__temcoApiRelay = { busy: () => true }; f.boot(); assert.equal(f.window.__temcoGenericProvider, original); assert.match(f.messages.at(-1), /still in flight/);
  delete f.window.__temcoApiRelay; f.listeners.get("pagehide")(); assert.equal(f.window.__temcoGenericProvider, undefined);
});
