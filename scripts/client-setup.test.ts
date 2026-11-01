import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Principal } from "../lib/auth/principal";

const target = process.env.CLIENT_SETUP_TEST_DATABASE_URL;
if (target) { const url = new URL(target); assert.equal(url.protocol, "postgresql:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55439"); assert.equal(url.pathname, "/temcotools_v2_test"); assert.equal(url.search, ""); process.env.DATABASE_URL = target; }
test("MCP setup distinguishes validated configuration from reachability and redacts unsafe URLs", async () => {
  const { describeMcpConnection } = await import("../lib/application/client-setup");
  assert.equal(describeMcpConnection({}).status, "unconfigured");
  const local = describeMcpConnection({ issuerUrl: "http://127.0.0.1:55371", resourceUrl: "http://127.0.0.1:55371/mcp", appUrl: "http://127.0.0.1:55370" });
  assert.equal(local.status, "loopback"); assert.equal(local.mcpUrl, "http://127.0.0.1:55371/mcp"); assert.match(local.notice, /another phone|cloud/);
  const remote = describeMcpConnection({ issuerUrl: "https://temco.example", resourceUrl: "https://temco.example/mcp", appUrl: "https://temco.example" });
  assert.equal(remote.status, "configured_unverified"); assert.match(remote.notice, /reachability.*not been checked/);
  for (const resourceUrl of ["https://name:synthetic-secret@temco.example/mcp", "https://temco.example/mcp?token=synthetic-secret", "https://temco.example/mcp#synthetic-secret", "https://other.example/mcp"]) {
    const unsafe = describeMcpConnection({ issuerUrl: "https://temco.example", resourceUrl, appUrl: "https://temco.example" });
    assert.equal(unsafe.status, "invalid_configuration"); assert.equal(unsafe.mcpUrl, null); assert.ok(!JSON.stringify(unsafe).includes("synthetic-secret"));
  }
});
test("connected-client setup lists only current person's recorded grants and reuses scoped revocation", { skip: !target }, async () => {
  const { prisma } = await import("../lib/db");
  const { getConnectedClientSetup } = await import("../lib/application/client-setup");
  const grants = await import("../lib/application/grants"), oauth = await import("../lib/oauth/service");
  const { executeApplicationAction } = await import("../lib/application/actions");
  const suffix = randomUUID(), users: string[] = [], clients: string[] = [];
  const previous = { MCP_ISSUER_URL: process.env.MCP_ISSUER_URL, MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL };
  Object.assign(process.env, { MCP_ISSUER_URL: "http://127.0.0.1:55371", MCP_RESOURCE_URL: "http://127.0.0.1:55371/mcp", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:55370" });
  const bundle = await prisma.roleBundle.create({ data: { name: `Client setup ${suffix}`, capabilities: ["account.self", "inventory.read", "workflow.read"] } });
  async function actor(name: string): Promise<Principal> {
    const user = await prisma.user.create({ data: { username: `client-setup-${suffix}-${name}`, displayName: `Synthetic client owner ${name}`, pinHash: "disabled:test", roleBundles: { create: { bundleId: bundle.id } } } }); users.push(user.id);
    const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic client setup fixture", expiresAt: new Date(Date.now() + 3_600_000) } });
    return { userId: user.id, username: user.username, displayName: user.displayName, role: "user", authVersion: user.authVersion, capabilities: ["account.self", "inventory.read", "workflow.read"], sessionId: session.id };
  }
  try {
    const owner = await actor("A"), other = await actor("B");
    const own = await grants.createAccessGrant(owner, { clientName: "Synthetic own private client", scopes: ["inventory.read"], lifetimeMinutes: 30 }), theirs = await grants.createAccessGrant(other, { clientName: "Synthetic other private client", scopes: ["workflow.read"], lifetimeMinutes: 30 });
    // This fixture qualifies the recorded-grant query only; actual OAuth
    // password/MFA/consent/PKCE HTTP behavior has its own integration tests.
    const client = await prisma.oAuthClient.create({ data: { id: `client-setup-${suffix}`, name: "Synthetic recorded OAuth client", metadata: {} } }); clients.push(client.id);
    const remote = await prisma.oAuthGrant.create({ data: { requestId: randomUUID(), clientId: client.id, userId: owner.userId, sessionId: owner.sessionId!, authVersion: owner.authVersion, issuer: process.env.MCP_ISSUER_URL! + "/", resource: process.env.MCP_RESOURCE_URL!, scopes: ["workflow.read"], expiresAt: new Date(Date.now() + 60_000) } });
    const before = await getConnectedClientSetup(owner);
    assert.equal(before.connection.status, "loopback"); assert.deepEqual(before.availableReadScopes, ["inventory.read", "workflow.read"]); assert.deepEqual(before.stdioGrants.map(value => value.id), [own.grant.id]); assert.deepEqual(before.oauthGrants.map(value => value.id), [remote.id]);
    assert.ok(!JSON.stringify(before).includes(own.token)); assert.ok(!JSON.stringify(before).includes("tokenHash")); assert.ok(!JSON.stringify(before).includes("sessionId"));
    const viaMcp = await executeApplicationAction(owner, "access.setup", {}) as Awaited<ReturnType<typeof getConnectedClientSetup>>;
    assert.deepEqual(viaMcp.connection, before.connection); assert.deepEqual(viaMcp.oauthGrants.map(grant => grant.id), before.oauthGrants.map(grant => grant.id)); assert.deepEqual(viaMcp.availableReadScopes, before.availableReadScopes);
    const unsafeRecord = await prisma.oAuthGrant.create({ data: { requestId: randomUUID(), clientId: client.id, userId: owner.userId, sessionId: owner.sessionId!, authVersion: owner.authVersion, issuer: process.env.MCP_ISSUER_URL! + "/", resource: "https://synthetic:record-secret@temco.example/mcp?token=record-secret", scopes: ["workflow.read"], expiresAt: new Date(Date.now() + 60_000) } });
    const redacted = await getConnectedClientSetup(owner); assert.equal(redacted.oauthGrants.find(grant => grant.id === unsafeRecord.id)?.resource, null); assert.ok(!JSON.stringify(redacted).includes("record-secret"));
    const limited = { ...owner, capabilities: ["account.self", "inventory.read"] as Principal["capabilities"] };
    assert.deepEqual((await getConnectedClientSetup(limited)).availableReadScopes, ["inventory.read"]);
    await assert.rejects(getConnectedClientSetup({ ...owner, capabilities: ["inventory.read"] }));
    assert.equal((await oauth.revokeOAuthGrant(other, remote.id)).revoked, false); assert.equal((await grants.revokeAccessGrant(owner, theirs.grant.id)).revoked, false);
    assert.equal((await executeApplicationAction(owner, "access.oauth.revoke", { id: remote.id }) as { revoked: boolean }).revoked, true); assert.equal((await executeApplicationAction(owner, "access.grant.revoke", { id: own.grant.id }) as { revoked: boolean }).revoked, true);
    const after = await getConnectedClientSetup(owner); assert.ok(after.oauthGrants.find(grant => grant.id === remote.id)?.revokedAt); assert.ok(after.stdioGrants[0].revokedAt); await assert.rejects(grants.authenticateAccessGrant(own.token));
    await prisma.userSession.update({ where: { id: owner.sessionId! }, data: { revokedAt: new Date() } }); await assert.rejects(getConnectedClientSetup(owner));
  } finally { await prisma.oAuthGrant.deleteMany({ where: { userId: { in: users } } }); await prisma.oAuthClient.deleteMany({ where: { id: { in: clients } } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: { in: users } } }); await prisma.user.deleteMany({ where: { id: { in: users } } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect(); for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
