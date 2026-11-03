import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCapability, AuthorizationError, resolvePrincipal, SESSION_MAX_AGE_MS,
  type CurrentUser, type SessionClaim,
} from "../lib/auth/principal";
import { isSameOriginMutation, requiresSameOrigin } from "../lib/auth/request-origin";

const now = 1_800_000_000_000;
const claim: SessionClaim = {
  userId: "operator-a", authVersion: 3, sessionId: "synthetic-session-a",
  issuedAt: now - 1000, expiresAt: now + SESSION_MAX_AGE_MS - 1000,
};
const current: CurrentUser = {
  id: "operator-a", username: "operator-a", displayName: "Operator A",
  role: "admin", isActive: true, authVersion: 3,
  siteMemberships: [{ siteId: "warehouse-initial", isActive: true, site: { isActive: true, name: "Synthetic warehouse" }, roles: [{ role: { siteId: null, isActive: true, capabilities: ["inventory.read", "labels.manage"] } }] }],
};

test("principal uses the current user and role, ignoring cookie display/role snapshots", async () => {
  const principal = await resolvePrincipal(
    { ...claim, role: "admin", isActive: true } as SessionClaim,
    async () => ({ ...current, displayName: "Current name", role: "user" }), now,
  );
  assert.ok(principal);
  assert.equal(principal.displayName, "Current name");
  assert.equal(principal.role, "user");
  assertCapability(principal, "inventory.read");
  assert.throws(() => assertCapability(principal, "users.manage"), AuthorizationError);
  assert.throws(() => assertCapability(principal, "payloads.manage"), AuthorizationError);
});

test("deactivation, credential/access generation change, deletion and mismatched identity revoke the old claim", async () => {
  for (const user of [null, { ...current, isActive: false }, { ...current, authVersion: 4 }, { ...current, id: "operator-b" }]) {
    assert.equal(await resolvePrincipal(claim, async () => user, now), null);
  }
});

test("legacy, expired, future and malformed session claims fail before user lookup", async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; return current; };
  const invalid: SessionClaim[] = [
    {}, { userId: current.id }, { ...claim, authVersion: undefined },
    { ...claim, authVersion: 0 }, { ...claim, expiresAt: now },
    { ...claim, issuedAt: now + 60_000 },
    { ...claim, expiresAt: now + SESSION_MAX_AGE_MS + 1000 },
    { ...claim, issuedAt: NaN }, { ...claim, sessionId: "short" },
  ];
  for (const candidate of invalid) assert.equal(await resolvePrincipal(candidate, lookup, now), null);
  assert.equal(lookups, 0);
});

test("database errors fail closed rather than using cookie authority", async () => {
  await assert.rejects(resolvePrincipal(claim, async () => { throw new Error("unavailable"); }, now), /unavailable/);
});

test("warehouse membership supplies capabilities independently of the legacy role label", async () => {
  const principal = await resolvePrincipal(claim, async () => ({ ...current, role: "manager" }), now);
  assert.ok(principal);
  assertCapability(principal, "labels.manage");
  for (const capability of ["users.manage", "payloads.manage", "files.manage"] as const) {
    assert.throws(() => assertCapability(principal, capability), AuthorizationError);
  }
});

test("every unsafe ordinary API mutation requires exact origin, including login and forged bearer requests", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/admin/users", "/api/api-relay/request", "/api/inventory-audit"]) {
      assert.equal(requiresSameOrigin(method, path), true);
    }
  }
  for (const origin of [null, "null", "https://evil.example", "https://temco.example.evil.example", "https://temco.example/", "http://temco.example"]) {
    assert.equal(isSameOriginMutation(origin, "https://temco.example"), false);
  }
  assert.equal(isSameOriginMutation("https://temco.example", "https://temco.example"), true);
  assert.equal(isSameOriginMutation("http://localhost:3000", "http://localhost:3000"), true);
  assert.equal(isSameOriginMutation("https://temco.example", "invalid"), false);
});

test("dedicated MCP lives outside app API Origin guard; ordinary API paths have no bearer exemption", () => {
  assert.equal(requiresSameOrigin("POST", "/mcp"), false);
  assert.equal(requiresSameOrigin("POST", "/api/mcp"), true);
  assert.equal(requiresSameOrigin("POST", "/api/mcp/other"), true);
  assert.equal(requiresSameOrigin("POST", "/api/mcp-lookalike"), true);
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(requiresSameOrigin(method, "/api/admin/users"), false);
});

test("legacy admin alone cannot become a platform admin; warehouse bundles cannot grant platform powers", async () => {
  const p = await resolvePrincipal(claim, async () => ({ ...current, siteMemberships: [{ ...current.siteMemberships![0], roles: [{ role: { siteId: null, isActive: true, capabilities: ["users.manage", "payloads.manage", "platform.manage", "sites.members.manage"] } }] }] }), now);
  assert.equal(p?.role, "manager"); assert.equal(p?.isPlatformAdmin, false);
  assert.deepEqual([...(p?.capabilities ?? [])].sort(), ["account.self", "sites.members.manage"].sort());
  const platform = await resolvePrincipal(claim, async () => ({ ...current, isPlatformAdmin: true }), now);
  assert.equal(platform?.role, "admin"); assert.ok(platform?.capabilities.includes("platform.manage"));
});

test("one person has different active bundles in different warehouses; inactive membership supplies none", async () => {
  const person = { ...current, siteMemberships: [...current.siteMemberships!, { siteId: "site-b", isActive: true, site: { isActive: true, name: "Warehouse B" }, roles: [{ role: { siteId: "site-b", isActive: true, capabilities: ["workflow.read"] } }] }] };
  const b = await resolvePrincipal(claim, async () => person, now, "site-b"); assert.equal(b?.siteId, "site-b"); assert.equal(b?.capabilities.includes("inventory.read"), false);
  person.siteMemberships[1].isActive = false;
  const gone = await resolvePrincipal(claim, async () => person, now, "site-b"); assert.equal(gone?.siteId, undefined); assert.deepEqual(gone?.capabilities, ["account.self"]);
});
