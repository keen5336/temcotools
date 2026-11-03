import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withPrincipalSite } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("configured integration services enforce current warehouse, immutable approval and explicit provider authority", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url; process.env.SESSION_SECRET = "synthetic-integration-service-session-key-not-for-use";
  const requests: Array<{ action: string; owner: { siteId: string } }> = [];
  const relay = createServer(async (req, res) => { let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ connections: [] })); });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve)); const address = relay.address(); assert.ok(address && typeof address !== "string"); process.env.API_RELAY_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  const s = await import("../lib/integrations/service"); const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID();
  const sites = await Promise.all(["a", "b"].map(name => owner.warehouseSite.create({ data: { slug: `integration-${ns}-${name}`, name: `Synthetic integration ${name}` } })));
  const people = await Promise.all(["admin", "manager", "receiver"].map((name, i) => owner.user.create({ data: { username: `integration-${ns}-${name}`, displayName: `Synthetic ${name}`, role: i === 0 ? "admin" : "user", isPlatformAdmin: i === 0, pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin-value" } })));
  await Promise.all(people.slice(1).map((p, i) => owner.warehouseMembership.create({ data: { siteId: sites[0].id, userId: p.id, roles: { create: { roleId: i === 0 ? "warehouse-manager" : "warehouse-operator" } } } })));
  await owner.warehouseMembership.create({ data: { siteId: sites[1].id, userId: people[2].id, roles: { create: { roleId: "warehouse-operator" } } } });
  const sessions = await Promise.all(people.map(p => owner.userSession.create({ data: { id: randomUUID(), userId: p.id, authVersion: 1, activeSiteId: sites[0].id, expiresAt: new Date(Date.now() + 3600_000), mfaVerifiedAt: new Date(), deviceLabel: "Synthetic local test" } })));
  async function principal(index: number, siteId = sites[0].id, session = sessions[index]) { const p = await resolvePrincipal({ userId: session.userId, sessionId: session.id, authVersion: session.authVersion, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, userId => owner.user.findUnique({ where: { id: userId }, select: CURRENT_USER_SELECT }), Date.now(), siteId); assert.ok(p); return { ...p, sessionId: session.id, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() }; }
  const [admin, manager, receiver] = await Promise.all([principal(0), principal(1), principal(2)]);
  const as = <T>(p: Principal, run: () => T) => withPrincipalSite(p, run), op = () => randomUUID();
  const definition = { integrationId: "synthetic-wms", key: "delivery.items", name: "Synthetic list", adapterId: "synthetic-adapter", adapterVersion: 1, origin: "https://synthetic.example.invalid", pagePathPrefix: "/warehouse", effect: "read", requiredCapability: "workflow.read", inputs: { deliveryId: { type: "string", maxLength: 80 } }, output: { type: "object", fields: { status: { type: "string", maxLength: 50 } } }, request: { method: "POST", path: "/rpc/list", query: {}, body: { encoding: "form", fields: { command: { from: "constant", value: "SYNTHETIC_READ" }, delivery: { from: "input", path: ["deliveryId"] } } } }, limits: { timeoutMs: 1000, maxInputBytes: 8192, maxResponseBytes: 65536, maxConcurrent: 1, maxQueued: 2, heartbeatMaxAgeMs: 10000, identityMaxAgeMs: 10000 } };
  let record: Awaited<ReturnType<typeof s.saveIntegrationActionDraft>>, versionId = "", firstVersion = "", providerId = "", secondProviderId = "", grantId = "", linkId = "";
  try {
    await t.test("draft receipts are idempotent and strict JSON cannot claim authority", async () => {
      const input = { operationId: op(), expectedRevision: 0, definition }; record = await as(manager, () => s.saveIntegrationActionDraft(manager, input)); const retry = await as(manager, () => s.saveIntegrationActionDraft(manager, input)); assert.equal(record.id, retry.id);
      await assert.rejects(as(manager, () => s.saveIntegrationActionDraft(manager, { ...input, definition: { ...definition, name: "Reused ID" } })), /operation ID/);
      await assert.rejects(as(manager, () => s.saveIntegrationActionDraft(manager, { ...input, operationId: op(), approved: true })), /Unrecognized/);
      await assert.rejects(as(manager, () => s.validateIntegrationActionDraft(manager, { definition: { ...definition, request: { ...definition.request, headers: { Cookie: "forbidden" } } } })));
    });
    await t.test("preview validates POST read mapping locally without dispatching", async () => {
      const before = requests.length; const value = await as(manager, () => s.previewIntegrationAction(manager, { definition, input: { deliveryId: "SYNTHETIC-01" }, output: { status: "fixture" } })); assert.equal(value.execution, "preview-only"); assert.equal(value.sent, false); assert.equal(value.request.method, "POST"); assert.equal(requests.length, before);
    });
    await t.test("only current platform authority qualifies an immutable contract", async () => {
      const q = { operationId: op(), id: record.id, expectedRevision: record.revision, qualification: { mode: "synthetic", evidenceReference: "synthetic-private-fixture-only", requestPathPrefix: "/rpc", identityContractId: "synthetic-identity-v1", warehouseBindingContractId: "synthetic-warehouse-v1" } };
      await assert.rejects(as(manager, () => s.qualifyIntegrationAction(manager, q)), /permission|authoriz/i);
      await assert.rejects(as(manager, () => s.publishIntegrationAction(manager, { operationId: op(), id: record.id, expectedRevision: record.revision })), /platform administrator/);
      const published = await as(admin, () => s.qualifyIntegrationAction(admin, q)); record = published.record; firstVersion = versionId = published.version.id;
      assert.equal((published.version.contractApproval as { reviewedByPlatformAdminId: string }).reviewedByPlatformAdminId, admin.userId); assert.equal(published.liveDispatchAvailable, false);
      await assert.rejects(owner.integrationActionVersion.update({ where: { id: versionId }, data: { contentHash: "altered" } }), /immutable/);
    });
    await t.test("site managers can republish approved metadata but cannot swap read RPC semantics", async () => {
      record = await as(manager, () => s.saveIntegrationActionDraft(manager, { operationId: op(), id: record.id, expectedRevision: record.revision, definition: { ...definition, name: "Local label" } }));
      const safe = await as(manager, () => s.publishIntegrationAction(manager, { operationId: op(), id: record.id, expectedRevision: record.revision })); record = safe.record; versionId = safe.version.id;
      const unsafe = { ...definition, request: { ...definition.request, body: { ...definition.request.body, fields: { ...definition.request.body.fields, command: { from: "constant", value: "ALLEGED_MUTATION" } } } } };
      record = await as(manager, () => s.saveIntegrationActionDraft(manager, { operationId: op(), id: record.id, expectedRevision: record.revision, definition: unsafe })); await assert.rejects(as(manager, () => s.publishIntegrationAction(manager, { operationId: op(), id: record.id, expectedRevision: record.revision })), /platform contract/);
      record = await as(manager, () => s.rollbackIntegrationAction(manager, { operationId: op(), id: record.id, expectedRevision: record.revision, versionId: firstVersion })); versionId = firstVersion;
      await assert.rejects(as(manager, () => s.setIntegrationActionEnabled(manager, { operationId: op(), id: record.id, expectedRevision: record.revision - 1, enabled: false })), /changed/);
    });
    await t.test("published pins, disable and cross-site access are enforced by real services/RLS", async () => {
      const fixture = { actionVersionId: versionId, input: { deliveryId: "SYNTHETIC" }, output: { status: "fixture" } };
      const simulated = await as(receiver, () => s.simulateConfiguredAction(receiver, fixture)); assert.equal(simulated.sent, false); assert.equal(simulated.physicalEffect, false);
      record = await as(manager, () => s.setIntegrationActionEnabled(manager, { operationId: op(), id: record.id, expectedRevision: record.revision, enabled: false })); await assert.rejects(as(receiver, () => s.simulateConfiguredAction(receiver, fixture)), /disabled/);
      record = await as(manager, () => s.setIntegrationActionEnabled(manager, { operationId: op(), id: record.id, expectedRevision: record.revision, enabled: true }));
      const other = await principal(2, sites[1].id); await assert.rejects(as(other, () => s.simulateConfiguredAction(other, fixture)), /not found/);
    });
    await t.test("browser registration is always disconnected/unqualified and rejects asserted identity", async () => {
      const input = { operationId: op(), integrationId: definition.integrationId, deviceId: "synthetic-laptop", tabId: "synthetic-tab-a", origin: definition.origin, pathname: "/warehouse/day", actionVersionIds: [versionId] };
      await assert.rejects(as(manager, () => s.registerProviderPlaceholder(manager, { ...input, authenticationState: "authenticated", upstreamIdentity: "no" })), /Unrecognized/);
      await assert.rejects(as(manager, () => s.registerProviderPlaceholder(manager, { ...input, origin: "https://other.example.invalid" })), /outside/);
      const p = await as(manager, () => s.registerProviderPlaceholder(manager, input)); providerId = p.provider.id; assert.equal(p.provider.transportState, "disconnected"); assert.equal(p.provider.authenticationState, "unqualified"); assert.equal(p.provider.upstreamIdentity, null);
      const second = await as(manager, () => s.registerProviderPlaceholder(manager, { ...input, operationId: op(), deviceId: "synthetic-zebra", tabId: "synthetic-tab-b" })); secondProviderId = second.provider.id;
    });
    await t.test("sharing requires exact session/action/effect and fresh human MFA; MCP cannot self-approve", async () => {
      const input = { operationId: op(), providerId, expectedProviderRevision: 1, grantee: { kind: "session", userId: receiver.userId, sessionId: receiver.sessionId }, actionVersionIds: [versionId], effects: ["read"] };
      await assert.rejects(as(manager, () => s.grantProviderAccess(manager, { ...input, effects: ["write"] })), /effect/);
      await owner.userSession.update({ where: { id: manager.sessionId }, data: { mfaVerifiedAt: null } }); await assert.rejects(as(manager, () => s.grantProviderAccess(manager, input)), /authenticator/); await owner.userSession.update({ where: { id: manager.sessionId }, data: { mfaVerifiedAt: new Date() } });
      const appGrant = await owner.appAccessGrant.create({ data: { userId: manager.userId, sessionId: manager.sessionId, siteId: sites[0].id, authVersion: 1, tokenHash: randomUUID(), clientName: "Synthetic MCP", scopes: ["account.self"], expiresAt: new Date(Date.now() + 600_000) } });
      const mcp = { ...manager, grantId: appGrant.id }; const handed = await as(mcp, () => s.grantProviderAccess(mcp, input)); assert.equal("status" in handed && handed.status, "requires_user_interaction");
      const created = await as(manager, () => s.grantProviderAccess(manager, input)); assert.ok("grant" in created); if ("grant" in created) grantId = created.grant.id;
    });
    await t.test("status is own-person or explicit current share, never site-wide estate", async () => {
      const shared = await as(receiver, () => s.getConnectionStatus(receiver)); assert.deepEqual(shared.providers.map(p => p.id), [providerId]); assert.equal(shared.providers[0].ready, false);
      const own = await as(manager, () => s.getConnectionStatus(manager)); assert.equal(own.providers.length, 2); assert.equal(own.providers.every(p => p.access === "owner_status_only"), true);
      assert.equal(requests.every(r => r.action === "connections" && r.owner.siteId === sites[0].id), true);
      await as(manager, () => s.revokeProviderAccess(manager, { operationId: op(), providerId, grantId })); assert.equal((await as(receiver, () => s.getConnectionStatus(receiver))).providers.length, 0);
    });
    await t.test("device links and pinned routing create no action authority and revoke linked grants", async () => {
      const linked = await as(manager, () => s.linkConnectedDevices(manager, { operationId: op(), deviceIds: ["synthetic-laptop", "synthetic-zebra"] })); assert.ok("link" in linked); if (!("link" in linked)) return; linkId = linked.link.id; assert.equal(linked.grantsCreated, false);
      const routed = await as(manager, () => s.saveDeviceProviderDefault(manager, { operationId: op(), linkId, expectedRevision: 1, deviceId: "synthetic-zebra", integrationId: definition.integrationId, effect: "read", providerId, expectedProviderRevision: 1 })); assert.ok("createsAuthority" in routed); if ("createsAuthority" in routed) { assert.equal(routed.createsAuthority, false); assert.equal(routed.failover, false); }
      await assert.rejects(as(manager, () => s.saveDeviceProviderDefault(manager, { operationId: op(), linkId, expectedRevision: 1, deviceId: "synthetic-zebra", integrationId: definition.integrationId, effect: "read", providerId, expectedProviderRevision: 1 })), /changed/);
      await as(manager, () => s.unlinkConnectedDevices(manager, { operationId: op(), linkId })); const revoked = await owner.connectedDeviceLink.findUniqueOrThrow({ where: { id: linkId } }); assert.ok(revoked.revokedAt);
      await as(manager, () => s.revokeProviderAccess(manager, { operationId: op(), providerId: secondProviderId })); assert.ok((await owner.providerConnection.findUniqueOrThrow({ where: { id: secondProviderId } })).revokedAt);
    });
    await t.test("membership removal immediately blocks management without resetting identity", async () => { const before = await owner.user.findUniqueOrThrow({ where: { id: manager.userId } }); await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: sites[0].id, userId: manager.userId } }, data: { isActive: false } }); await assert.rejects(as(manager, () => s.listIntegrationActions(manager)), /warehouse|access/); const after = await owner.user.findUniqueOrThrow({ where: { id: manager.userId } }); assert.equal(after.passwordHash, before.passwordHash); assert.equal(after.authVersion, before.authVersion); });
  } finally { await owner.$disconnect(); const { prisma } = await import("../lib/db"); await prisma.$disconnect(); await new Promise<void>(resolve => relay.close(() => resolve())); }
});
