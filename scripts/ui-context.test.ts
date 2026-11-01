import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { NextRequest } from "next/server";
import { runInNewContext } from "node:vm";
import { createUiContext } from "../lib/auth/ui-context";
import { uiContextBootstrap } from "../lib/ui-context/bootstrap";
import { boundApiHref, requiresUiContext, UI_CONTEXT_HEADER, UI_CONTEXT_ERROR_HEADER, type BrowserUiContext } from "../lib/ui-context/shared";

test("native proxy rejects switched/missing tab identity without granting authority or clearing the new cookie", async () => {
  process.env.SESSION_SECRET = "synthetic-ui-context-secret-for-native-checks-2026";
  process.env.NEXT_PUBLIC_APP_URL = "https://synthetic.temco.invalid";
  const { proxy } = await import("../proxy");
  const now = Date.now(), a = { userId: "synthetic-user-a", sessionId: "synthetic-session-a-0001", authVersion: 1, issuedAt: now, expiresAt: now + 3_600_000 }, b = { ...a, userId: "synthetic-user-b", sessionId: "synthetic-session-b-0001" };
  const contextA = createUiContext(a)!, contextB = createUiContext(b)!;
  const cookieB = await sealData(b, { password: process.env.SESSION_SECRET, ttl: 43_200 });
  const request = (path: string, method = "GET", context?: string, cookie = cookieB, origin = process.env.NEXT_PUBLIC_APP_URL!) => new NextRequest(new URL(path, origin), { method, headers: { Cookie: `temco_session=${cookie}`, Origin: origin, ...(context ? { [UI_CONTEXT_HEADER]: context } : {}) } });
  const accepted = await proxy(request("/api/account/security", "GET", contextB)); assert.equal(accepted.headers.get("x-middleware-next"), "1", "A matching fingerprint passes only this rejection boundary; nonexistent fixture users still need domain authentication.");
  const missing = await proxy(request("/api/account/security")); assert.equal(missing.status, 409); assert.equal((await missing.json()).code, "ui_context_required");
  for (const [path, method] of [["/api/account/security", "GET"], ["/api/account/security", "POST"], ["/api/auth/activity", "POST"], ["/api/auth/logout", "POST"], ["/api/admin/users/synthetic-target", "PATCH"]]) {
    const denied = await proxy(request(path, method, contextA)); assert.equal(denied.status, 409); assert.equal(denied.headers.get(UI_CONTEXT_ERROR_HEADER), "changed"); assert.equal(denied.headers.has("set-cookie"), false); assert.equal((await denied.json()).code, "ui_context_changed");
  }
  assert.notEqual(contextA, createUiContext({ ...a, sessionId: "synthetic-session-a-0002" }));
  assert.notEqual(contextA, createUiContext({ ...a, authVersion: 2 }));
  const download = boundApiHref("/api/inventory-audit/export?archive=active", contextB), exported = await proxy(request(download));
  const rewritten = new URL(exported.headers.get("x-middleware-rewrite")!); assert.equal(rewritten.searchParams.has("__temco_ui"), false); assert.equal(rewritten.searchParams.get("archive"), "active");
  assert.equal((await proxy(request(boundApiHref("/api/inventory-audit/export", contextA)))).status, 409);
  assert.equal((await proxy(request(boundApiHref("/api/account/security", contextB), "POST"))).status, 409, "GET query fingerprints never authorize a mutation.");
  const badOrigin = request("/api/account/security", "POST", contextB); badOrigin.headers.set("Origin", "https://wrong.invalid"); assert.equal((await proxy(badOrigin)).status, 403);
  assert.equal((await proxy(request("/api/account/security", "GET", contextB, "not-a-cookie"))).status, 401);
  const bearer = request("/api/account/security"); bearer.headers.set("Authorization", "Bearer synthetic-client"); assert.equal((await proxy(bearer)).status, 409, "Bearer headers cannot exempt cookie UI endpoints.");
});

test("only existing public/machine paths skip tab binding; ordinary API reads and writes remain covered", () => {
  for (const [method, path] of [["POST", "/api/auth/login"], ["POST", "/api/auth/recovery"], ["GET", "/api/api-relay/loader"], ["GET", "/api/payloads/dmp-relay/loader"], ["GET", `/api/payloads/dmp-relay/versions/synthetic/${"a".repeat(64)}`], ["POST", "/api/internal/api-relay-authorization"], ["POST", "/mcp"], ["OPTIONS", "/api/warehouse/import"]]) assert.equal(requiresUiContext(method, path), false, `${method} ${path}`);
  for (const [method, path] of [["POST", "/api/auth/logout"], ["POST", "/api/auth/activity"], ["GET", "/api/payloads/dmp-relay"], ["GET", "/api/payloads/dmp-relay/versions/synthetic"], ["POST", "/api/payloads/dmp-relay/loader"], ["POST", "/api/mcp"], ["GET", "/api/inventory-audit/export"], ["GET", "/api/admin/files/download"]]) assert.equal(requiresUiContext(method, path), true, `${method} ${path}`);
});

test("early bootstrap preserves native Request/FormData/abort and cannot rebind an old document", async () => {
  const contextA = "uc1_" + "A".repeat(43), contextB = "uc1_" + "B".repeat(43), events = new EventTarget();
  const captured: Request[] = [];
  let abortOnly = false;
  const original: typeof fetch = async (input, init) => {
    const request = new Request(input, init); captured.push(request);
    if (abortOnly) return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  const window: { location: { href: string; origin: string }; fetch: typeof fetch; dispatchEvent: (event: Event) => boolean; __temcoUiContextV1?: BrowserUiContext } = { location: { href: "https://synthetic.temco.invalid/tools/inventory-audit", origin: "https://synthetic.temco.invalid" }, fetch: original, dispatchEvent: event => events.dispatchEvent(event) };
  const realm = { window, Request, Headers, Response, URL, CustomEvent };
  runInNewContext(uiContextBootstrap(contextA), realm);
  const wrapped = window.fetch;
  const form = new FormData(); form.set("note", "Synthetic upload only"); form.set("file", new Blob(["synthetic workbook bytes"]), "synthetic.txt");
  const request = new Request("https://synthetic.temco.invalid/api/pick-waves", { method: "POST", credentials: "include", headers: { "X-Keep": "synthetic", [UI_CONTEXT_HEADER]: contextB }, body: form });
  await wrapped(request); const sent = captured[0]; assert.equal(sent.headers.get(UI_CONTEXT_HEADER), contextA, "Caller headers cannot retarget the pinned document."); assert.equal(sent.headers.get("X-Keep"), "synthetic"); assert.equal(sent.credentials, "include"); assert.equal(sent.cache, "no-store"); assert.match(sent.headers.get("content-type")!, /^multipart\/form-data; boundary=/);
  const uploaded = await sent.formData(); assert.equal(uploaded.get("note"), "Synthetic upload only"); assert.equal(await (uploaded.get("file") as File).text(), "synthetic workbook bytes");
  await wrapped("https://relay.synthetic.invalid/print", { method: "POST", body: "synthetic label" }); assert.equal(captured[1].headers.has(UI_CONTEXT_HEADER), false, "LAN/relay/other-origin requests never receive the app snapshot.");
  await wrapped("https://synthetic.temco.invalid/api/auth/login", { method: "POST", body: "synthetic credential ceremony" }); assert.equal(captured[2].headers.has(UI_CONTEXT_HEADER), false);
  abortOnly = true; const controller = new AbortController(); const pending = wrapped("https://synthetic.temco.invalid/api/warehouse/import", { method: "POST", body: "synthetic buffered import", signal: controller.signal }); controller.abort(new Error("Synthetic operator cancelled")); await assert.rejects(pending, /Synthetic operator cancelled/); assert.equal(captured[3].signal.aborted, true); abortOnly = false;
  runInNewContext(uiContextBootstrap(contextA), realm); assert.equal(window.fetch, wrapped, "Repeated same-session layout initialization must not stack wrappers.");
  let blocked = 0; events.addEventListener("temco-ui-context-blocked", () => blocked++);
  runInNewContext(uiContextBootstrap(contextB), realm); assert.equal(window.__temcoUiContextV1?.context, contextA); assert.equal(window.__temcoUiContextV1?.blocked, true); assert.equal(blocked, 1);
  const count = captured.length, denied = await window.fetch("https://synthetic.temco.invalid/api/account/security", { method: "POST" }); assert.equal(denied.status, 409); assert.equal(captured.length, count, "A blocked document neither dispatches nor retries queued API work.");
  await window.fetch("https://synthetic.temco.invalid/api/auth/login", { method: "POST" }); assert.equal(captured.length, count + 1, "An explicit login ceremony remains available; success must open a fresh document.");
});
