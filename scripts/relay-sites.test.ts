import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { connectTemcoBookmarklet } from "../lib/relay-sites/model";
import { chooseSiteProfile, exactSiteOrigin, exactSitePath, sitePathMatches, siteProfilesOverlap, validateSiteLocation, type SiteProfileBinding } from "../lib/relay-sites/types";
import { renderPayloadVersion, validatePayloadDraft, payloadContentHash } from "../lib/payloads/model";
import { builtinRoutePlannerSource } from "../lib/payloads/builtin";
import { requiresUiContext } from "../lib/ui-context/shared";
import { assertSiteProfileSourceContract, SITE_PROFILE_BINDING_DIRECTIVE, supportsSiteProfileBinding } from "../lib/relay-sites/contract";

const origin = "https://synthetic-site.example.invalid";
const profile = { id: "synthetic-profile", origin, pathPrefix: "/RP", purpose: "route_planner_relay", payloadId: "synthetic-adapter", enabled: true, revision: 3, removedAt: null };
const binding: SiteProfileBinding = { profileId: profile.id, revision: profile.revision, origin, pathname: "/RP/day", pathPrefix: "/RP", payloadId: profile.payloadId, versionId: "synthetic-version", contentHash: "a".repeat(64) };

test("mapped DMP requires a versioned first-line declaration without rewriting unaware legacy source", () => {
  assert.equal(supportsSiteProfileBinding(`${SITE_PROFILE_BINDING_DIRECTIVE}\nvoid 0;`), true);
  for (const source of ["void 0;", `void 0;\n${SITE_PROFILE_BINDING_DIRECTIVE}`, "// temco-site-profile-binding:2\nvoid 0;", ` ${SITE_PROFILE_BINDING_DIRECTIVE}\nvoid 0;`]) {
    assert.equal(supportsSiteProfileBinding(source), false);
    assert.throws(() => assertSiteProfileSourceContract("dmp_relay", source), /first-line declaration/);
  }
  assert.doesNotThrow(() => assertSiteProfileSourceContract("route_planner_relay", "void 0;"));
});

test("site origin/path contracts reject wildcard/secret URL inputs and enforce segment boundaries", () => {
  assert.equal(exactSiteOrigin(origin), origin);
  assert.equal(exactSitePath("/RP", true), "/RP");
  assert.deepEqual(validateSiteLocation({ origin, pathname: "/RP/day" }), { origin, pathname: "/RP/day" });
  for (const bad of ["https://*.example.invalid", `${origin}/`, `${origin}/RP`, `${origin}?token=synthetic`, "https://user:synthetic@site.example.invalid"]) assert.throws(() => exactSiteOrigin(bad));
  for (const bad of ["//other", "/RP?secret=synthetic", "/RP#fragment", "/../RP", "/RP/../other", "/RP%2fother", "/RP\\other", "/RP/*", "not-a-path"]) assert.throws(() => exactSitePath(bad));
  assert.throws(() => exactSitePath("/RP/", true));
  assert.throws(() => validateSiteLocation({ origin, pathname: "/RP", query: "synthetic-secret" }));
  assert.throws(() => validateSiteLocation({ url: `${origin}/RP`, source: "synthetic" }));
  assert.equal(sitePathMatches("/RP", "/RP"), true); assert.equal(sitePathMatches("/RP/day", "/RP"), true); assert.equal(sitePathMatches("/RPequiv", "/RP"), false);
  assert.equal(siteProfilesOverlap(profile, { origin, pathPrefix: "/" }), true);
  assert.equal(siteProfilesOverlap(profile, { origin, pathPrefix: "/RP/day" }), true);
  assert.equal(siteProfilesOverlap(profile, { origin, pathPrefix: "/other" }), false);
  assert.equal(siteProfilesOverlap(profile, { origin: "https://other.invalid", pathPrefix: "/" }), false);
});

test("resolver selection denies unsupported, disabled, removed, any overlap and excessive rows", () => {
  const location = { origin, pathname: binding.pathname };
  assert.equal(chooseSiteProfile([profile], location).id, profile.id);
  assert.throws(() => chooseSiteProfile([profile], { origin, pathname: "/other" }), /not configured/);
  assert.throws(() => chooseSiteProfile([profile], { origin: "https://other.invalid", pathname: "/RP" }), /not configured/);
  assert.throws(() => chooseSiteProfile([{ ...profile, enabled: false }], location), /disabled/);
  assert.throws(() => chooseSiteProfile([{ ...profile, enabled: false, removedAt: new Date() }], location), /disabled/);
  assert.throws(() => chooseSiteProfile([profile, { ...profile, id: "overlap", pathPrefix: "/", enabled: false }], location), /Ambiguous/);
  assert.throws(() => chooseSiteProfile(Array.from({ length: 65 }, (_, index) => ({ ...profile, id: `synthetic-${index}`, pathPrefix: `/unrelated-${index}` })), location), /Ambiguous/);
});

test("one stable bookmark reports only origin/path with no referrer or external-page read", () => {
  const scripts: Record<string, unknown>[] = [], alerts: string[] = [];
  const location = { origin, pathname: "/RP/day", search: "?token=synthetic-do-not-send", hash: "#synthetic-fragment", href: `${origin}/RP/day?synthetic-secret` };
  const document = { createElement: (tag: string) => { assert.equal(tag, "script"); return {}; }, head: { appendChild: (node: Record<string, unknown>) => scripts.push(node) } };
  const context = createContext({ location, document, window: {}, URL, alert: (message: string) => alerts.push(message) });
  new Script(connectTemcoBookmarklet("https://synthetic-temco.example.invalid").slice("javascript:".length)).runInContext(context);
  assert.equal(scripts.length, 1); assert.equal(alerts.length, 0);
  const url = new URL(String(scripts[0].src));
  assert.equal(url.pathname, "/api/connect-temco/loader");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["origin", "pathname"]);
  assert.equal(url.searchParams.get("origin"), origin); assert.equal(url.searchParams.get("pathname"), "/RP/day");
  assert.equal(scripts[0].referrerPolicy, "no-referrer"); assert.ok(!url.href.includes("synthetic-do-not-send") && !url.href.includes("synthetic-fragment"));
  const busy = createContext({ location, document, window: { __temcoApiRelay: { busy: () => true } }, URL, alert: (message: string) => alerts.push(message) });
  new Script(connectTemcoBookmarklet("https://synthetic-temco.example.invalid").slice("javascript:".length)).runInContext(busy);
  assert.equal(scripts.length, 1); assert.match(alerts[0], /still running/);
  assert.equal(requiresUiContext("GET", "/api/connect-temco/loader"), false);
  for (const [method, path] of [["POST", "/api/connect-temco/loader"], ["GET", "/api/connect-temco/loader/other"], ["GET", "/api/relay-sites"]]) assert.equal(requiresUiContext(method, path), true);
});

test("published wrapper checks actual origin/path before source and keeps pinned binding metadata", () => {
  const draft = validatePayloadDraft({ name: "Synthetic", purpose: "route_planner_relay", targetOrigins: [origin], source: "globalThis.executed=TEMCO_PAYLOAD;", protocolVersion: 1, operationNames: [] });
  const source = renderPayloadVersion({ ...draft, id: binding.versionId, payloadId: binding.payloadId, version: 1, contentHash: payloadContentHash(draft) }, binding);
  for (const [actualOrigin, pathname, busy, allowed] of [[origin, "/RP/day", false, true], [origin, "/other", false, false], [origin, "/RP/another", false, false], ["https://other.invalid", "/RP/day", false, false], [origin, "/RP/day", true, false]] as const) {
    const context = createContext({ location: { origin: actualOrigin, pathname }, window: { __temcoApiRelay: { busy: () => busy } }, alert: () => {} });
    new Script(source).runInContext(context);
    assert.equal(Boolean(context.executed), allowed);
    if (allowed) assert.deepEqual(JSON.parse(JSON.stringify(context.executed.profileBinding)), binding);
  }
});

test("current DMP executor pins managed metadata with or without site binding and preserves metadata-free legacy fallback", () => {
  const source = readFileSync("scripts/api-relay/executor.mjs", "utf8").replace(/^export /gm, "");
  for (const mode of ["legacy", "managed", "bound"]) {
    const buttons: { textContent?: string; onclick?: () => void }[] = [], opened: string[] = [];
    const element = () => ({ textContent: "", onclick: undefined as (() => void) | undefined, style: {}, append: () => {}, attachShadow: () => ({ append: () => {} }), setAttribute: () => {}, remove: () => {} });
    const document = { createElement: (tag: string) => { const node = element(); if (tag === "button") buttons.push(node); return node; }, createTextNode: () => ({}), body: { append: () => {} } };
    const legacy = { payloadId: "dmp-relay", versionId: "builtin", contentHash: "b".repeat(64) };
    const context = createContext({ document, location: { origin, pathname: binding.pathname }, window: { addEventListener: () => {}, open: (url: string) => { opened.push(url); return {}; } }, URL, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" }, alert: () => {}, setInterval: () => 1, clearInterval: () => {}, WebSocket: { CLOSING: 2 }, ...(mode !== "legacy" ? { TEMCO_PAYLOAD: { payloadId: binding.payloadId, versionId: binding.versionId, contentHash: binding.contentHash, ...(mode === "bound" ? { profileBinding: binding } : {}) } } : {}) });
    new Script(`${source}\nstartDmpRelay(${JSON.stringify({ temcoOrigin: "https://temco.example.invalid", allowedOrigins: [origin], payload: legacy })});`).runInContext(context);
    buttons.find(button => button.textContent === "Connect")!.onclick!();
    const captured = JSON.parse(new URL(opened[0]).searchParams.get("payload")!);
    assert.equal(captured.payloadId, mode !== "legacy" ? binding.payloadId : legacy.payloadId);
    assert.equal(captured.versionId, mode !== "legacy" ? binding.versionId : legacy.versionId);
    assert.equal(captured.contentHash, mode !== "legacy" ? binding.contentHash : legacy.contentHash);
    assert.deepEqual(captured.profileBinding, mode === "bound" ? binding : undefined);
  }
});

test("Route Planner builtin is owner-origin review/manual-intake only", () => {
  const builtin = builtinRoutePlannerSource("https://synthetic-temco.example.invalid");
  assert.deepEqual(builtin.targetOrigins, ["https://routeplannerui.homedepot.com"]);
  const draft = validatePayloadDraft({ ...builtin, name: "RP synthetic review", purpose: "route_planner_relay", protocolVersion: 1, operationNames: [] });
  const nodes: { textContent?: string; onclick?: () => void }[] = [], opened: string[] = [];
  const context = createContext({ document: { getElementById: () => null, createElement: () => { const node = { textContent: "", onclick: undefined as (() => void) | undefined, style: {}, append: () => {}, remove: () => {} }; nodes.push(node); return node; }, createTextNode: () => ({}), body: { append: () => {} } }, window: { open: (url: string) => opened.push(url) }, alert: () => {}, fetch: () => { throw new Error("No fetch allowed"); } });
  new Script(draft.source).runInContext(context);
  nodes.find(node => node.textContent === "Open manual XML intake")!.onclick!();
  assert.deepEqual(opened, ["https://synthetic-temco.example.invalid/tools/dmp-samples"]);
});
