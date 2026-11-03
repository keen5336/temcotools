import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createScopedClient } from "../lib/db/scoped-client";
import { withSiteContext, type SiteDatabaseContext } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type SessionClaim } from "../lib/auth/principal";
import { SITE_TABLES } from "../lib/sites/tables";
const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("warehouse isolation is enforced for retained ORM/raw SQL paths and current authority", { skip: !url }, async t => {
  const target = new URL(url!);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "synthetic-expanded-sdk-session-secret-2026";
  process.env.NEXT_PUBLIC_APP_URL = "https://synthetic.temco.invalid";
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  const db = createScopedClient(owner, async () => null), ns = randomUUID();
  const now = new Date(), expiry = new Date(now.getTime() + 3600_000);
  const sites = await Promise.all(["a", "b"].map(s => owner.warehouseSite.create({ data: { id: `scope-${ns}-${s}`, slug: `scope-${ns}-${s}`, name: `Synthetic ${s}` } })));
  const user = await owner.user.create({ data: { username: `scope-${ns}`, displayName: "Synthetic local manager", pinHash: "disabled:v2", role: "admin", passwordHash: "synthetic-unusable-hash" } });
  const session = await owner.userSession.create({ data: { id: `scope-session-${ns}`, userId: user.id, authVersion: 1, expiresAt: expiry, activeSiteId: sites[0].id, mfaVerifiedAt: now, deviceLabel: "Synthetic" } });
  const members = await Promise.all(sites.map(site => owner.warehouseMembership.create({ data: { siteId: site.id, userId: user.id, roles: { create: { roleId: "warehouse-manager" } } } })));
  const contexts = sites.map(site => ({ siteId: site.id, userId: user.id, sessionId: session.id, authVersion: 1 } satisfies SiteDatabaseContext));
  const as = <T>(index: number, run: () => T) => withSiteContext(contexts[index], run);
  const units = await Promise.all(sites.map((_, i) => as(i, () => db.warehouseUnit.create({ data: { createdByUserId: user.id, creationEvidence: "synthetic" } }))));
  try {
    await t.test("all current operational tables force RLS and runtime role cannot bypass it", async () => {
      const rows = await owner.$queryRaw<{ name: string; forced: boolean }[]>`SELECT c.relname AS name,c.relrowsecurity AND c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`;
      for (const table of SITE_TABLES) assert.equal(rows.find(r => r.name === table)?.forced, true, table);
      const role = await db.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      assert.deepEqual(role, [{ rolname: "temco_runtime", rolsuper: false, rolbypassrls: false }]);
    });
    await t.test("contextless ORM/raw and nested global relations cannot disclose operational data", async () => {
      assert.equal(await db.warehouseUnit.count(), 0);
      assert.equal((await db.$queryRaw<unknown[]>`SELECT * FROM "WarehouseUnit"`).length, 0);
      await owner.labelPrinter.create({ data: { siteId: sites[0].id, name: `synthetic-${ns}`, endpoint: "http://printer.invalid", createdByUserId: user.id } });
      const rows = await db.user.findUniqueOrThrow({ where: { id: user.id }, include: { labelPrintersCreated: true } });
      assert.equal(rows.labelPrintersCreated.length, 0);
      assert.equal((await as(0, () => db.user.findUniqueOrThrow({ where: { id: user.id }, include: { labelPrintersCreated: true } }))).labelPrintersCreated.length, 1);
      await assert.rejects(db.warehouseUnit.create({ data: { creationEvidence: "contextless" } }));
    });
    await t.test("site selection intersects raw/ORM/bulk queries and explicit other-site filters", async () => {
      assert.deepEqual((await as(0, () => db.warehouseUnit.findMany({ where: { id: { in: units.map(u => u.id) } } }))).map(u => u.id), [units[0].id]);
      assert.equal(await as(0, () => db.warehouseUnit.findUnique({ where: { id: units[1].id } })), null);
      assert.equal((await as(0, () => db.$queryRaw<unknown[]>`SELECT * FROM "WarehouseUnit" WHERE id=${units[1].id}`)).length, 0);
      assert.equal((await as(0, () => db.warehouseUnit.updateMany({ where: { id: units[1].id }, data: { creationEvidence: "forbidden" } }))).count, 0);
      await assert.rejects(as(0, () => db.warehouseUnit.create({ data: { siteId: sites[1].id } })));
      await assert.rejects(as(0, () => db.warehouseUnit.update({ where: { id: units[0].id }, data: { siteId: sites[1].id } })));
    });
    await t.test("cross-site foreign keys cannot link hidden unit history", async () => {
      await assert.rejects(as(0, () => db.warehouseUnitNote.create({ data: { unitId: units[1].id, authorUserId: user.id, authorUsername: user.username, authorName: user.displayName } })));
      await as(0, () => db.warehouseUnitNote.create({ data: { unitId: units[0].id, authorUserId: user.id, authorUsername: user.username, authorName: user.displayName } }));
      const unit = await as(0, () => db.warehouseUnit.findUniqueOrThrow({ where: { id: units[0].id }, include: { notes: true } }));
      assert.equal(unit.notes.length, 1);
      assert.equal((await as(1, () => db.warehouseUnitNote.findMany({ where: { unitId: units[0].id } }))).length, 0);
    });
    await t.test("local managers manage only delegated site memberships/configuration without changing identities", async () => {
      const svc = await import("../lib/sites/service");
      const claim = { userId: user.id, sessionId: session.id, authVersion: 1, issuedAt: session.createdAt.getTime(), expiresAt: expiry.getTime() };
      const base = await resolvePrincipal(claim, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[0].id);
      assert.ok(base);
      const p = { ...base, sessionId: session.id, strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
      const person = await owner.user.create({ data: { username: `scope-target-${ns}`, displayName: "Synthetic member", pinHash: "disabled:v2", role: "user" } });
      const saved = await as(0, () => svc.saveMembership(p, { operationId: randomUUID(), userId: person.id, expectedRevision: 0, isActive: true, roleIds: ["warehouse-operator"] }));
      assert.equal(saved.siteId, sites[0].id);
      assert.equal(await owner.warehouseMembership.count({ where: { userId: person.id, siteId: sites[1].id } }), 0);
      await assert.rejects(as(0, () => svc.saveMembership(p, { operationId: randomUUID(), userId: person.id, expectedRevision: 0, isActive: false, roleIds: [] })));
      await assert.rejects(as(0, () => svc.saveSiteRole(p, { operationId: randomUUID(), expectedRevision: 0, name: "Forbidden", capabilities: ["platform.manage"] })));
      const before = await owner.user.findUniqueOrThrow({ where: { id: person.id } });
      await as(0, () => svc.saveMembership(p, { operationId: randomUUID(), userId: person.id, expectedRevision: saved.revision, isActive: false, roleIds: [] }));
      const after = await owner.user.findUniqueOrThrow({ where: { id: person.id } });
      assert.equal(after.isActive, before.isActive); assert.equal(after.authVersion, before.authVersion); assert.equal(after.passwordHash, before.passwordHash);
      await assert.rejects(as(0, () => svc.createSite(p, { operationId: randomUUID(), slug: `forbidden-${ns}`, name: "Forbidden site" })));
      const admin = await as(0, () => svc.getSiteAdministration(p));
      assert.equal(admin.site.id, sites[0].id); assert.ok(admin.members.every(m => m.userId === user.id || m.userId === person.id));
      await as(0, () => svc.saveSiteConfiguration(p, { operationId: randomUUID(), expectedRevision: admin.site.revision, name: "Synthetic updated", configuration: { timezone: "America/Chicago", locations: ["Lane 1"] } }));
      await assert.rejects(as(0, () => svc.saveSiteConfiguration(p, { operationId: randomUUID(), expectedRevision: admin.site.revision, name: "Stale", configuration: { locations: [] } })));
    });
    await t.test("human platform administration creates local membership without promoting a legacy admin label", async () => {
      const identity = await import("../lib/auth/identity");
      await owner.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
      try {
        const base = await resolvePrincipal({ userId: user.id, sessionId: session.id, authVersion: 1, issuedAt: session.createdAt.getTime(), expiresAt: expiry.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[0].id); assert.ok(base);
        const p = { ...base, sessionId: session.id, strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
        const created = await as(0, () => identity.createIdentityUser(p, { username: `scope-created-${ns}`, displayName: "Synthetic local manager", role: "admin" }));
        assert.equal(created.isPlatformAdmin, false);
        assert.equal(await owner.warehouseMembership.count({ where: { userId: created.id, siteId: sites[0].id, isActive: true } }), 1);
        assert.equal((await owner.user.findUniqueOrThrow({ where: { id: created.id } })).passwordHash, null);
      } finally { await owner.user.update({ where: { id: user.id }, data: { isPlatformAdmin: false } }); }
    });
    await t.test("native MCP SDK uses the same scoped commands and human handoffs without domain mutation inputs", async () => {
      const { withPrincipalSite } = await import("../lib/sites/context");
      const { createAccessGrant, authenticateAccessGrant } = await import("../lib/application/grants");
      const { createApplicationMcpServer } = await import("../lib/application/mcp");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const base = await resolvePrincipal({ userId: user.id, sessionId: session.id, authVersion: 1, issuedAt: session.createdAt.getTime(), expiresAt: expiry.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[0].id); assert.ok(base);
      const p = { ...base, sessionId: session.id, strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
      const grant = await withPrincipalSite(p, () => createAccessGrant(p, { clientName: "Synthetic expanded SDK", scopes: ["workflow.read", "inventory.read", "account.self"], lifetimeMinutes: 5 }));
      const client = new Client({ name: "synthetic-expanded-sdk", version: "1" }), server = createApplicationMcpServer(() => authenticateAccessGrant(grant.token));
      const [a,b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
      const read = (v: unknown) => JSON.parse((v as { content: { text: string }[] }).content[0].text);
      try {
        for (const action of ["connections.grant", "connections.grant.revoke", "connections.device.link", "connections.device.unlink", "connections.device.default"]) {
          const result = await client.callTool({ name: "application_action", arguments: { action, input: {} } }); assert.equal(result.isError, undefined, action);
          assert.equal(read(result).status, "requires_user_interaction"); assert.equal(read(result).actionUrl, "https://synthetic.temco.invalid/management/connections");
        }
        const catalog = read(await client.callTool({ name: "application_actions", arguments: {} }));
        assert.ok(catalog.some((a: { name: string }) => a.name === "workflows.start")); assert.ok(!catalog.some((a: { name: string }) => a.name === "integrations.qualify"));
        const started = await client.callTool({ name: "application_action", arguments: { action: "workflows.start", input: { operationId: randomUUID(), template: "synthetic_receiving" } } }); assert.equal(started.isError, undefined);
        const run = read(started).run; assert.equal(run.siteId, sites[0].id);
        const looked = await client.callTool({ name: "application_action", arguments: { action: "workflows.run", input: { runId: run.id } } }); assert.equal(read(looked).run.id, run.id);
        const custody = await client.callTool({ name: "application_action", arguments: { action: "custody.unit", input: { unitId: units[0].id } } }); assert.equal(custody.isError, undefined); assert.equal(read(custody).unit.id, units[0].id); assert.equal(read(custody).participation.siteId, sites[0].id);
        const forbiddenCustody = await client.callTool({ name: "application_action", arguments: { action: "custody.propose", input: { operationId: randomUUID(), unitId: units[0].id, destinationSiteId: sites[1].id, aliasIds: ["not-an-authorized-alias"], handoff: {}, note: "Scoped client cannot authorize custody" } } }); assert.equal(forbiddenCustody.isError, true);
        const denied = await client.callTool({ name: "application_action", arguments: { action: "sites.create", input: { operationId: randomUUID(), slug: "sdk-denied", name: "Denied" } } }); assert.equal(denied.isError, true);
      } finally { await client.close(); await server.close(); }
    });
    await t.test("legacy admin is local only and site membership revocation takes effect immediately", async () => {
      const claim: SessionClaim = { userId: user.id, sessionId: session.id, authVersion: 1, issuedAt: session.createdAt.getTime(), expiresAt: expiry.getTime() };
      const p = await resolvePrincipal(claim, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[0].id);
      assert.ok(p?.capabilities.includes("sites.members.manage")); assert.equal(p?.isPlatformAdmin, false);
      assert.equal(p?.capabilities.includes("users.manage"), false); assert.equal(p?.capabilities.includes("payloads.manage"), false);
      await owner.warehouseMembership.update({ where: { id: members[0].id }, data: { isActive: false } });
      assert.equal(await as(0, () => db.warehouseUnit.count()), 0);
      await assert.rejects(as(0, () => db.warehouseUnit.create({ data: {} })));
      assert.equal(await as(1, () => db.warehouseUnit.count({ where: { id: units[1].id } })), 1);
      await owner.warehouseMembership.update({ where: { id: members[0].id }, data: { isActive: true } });
      await owner.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      assert.equal(await as(1, () => db.warehouseUnit.count()), 0);
    });
  } finally { await owner.$disconnect(); const { prisma: shared } = await import("../lib/db"); await shared.$disconnect(); }
});
