import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { prisma } from "../lib/db";
import { resolvePrincipal } from "../lib/auth/principal";
import { createAccessGrant, authenticateAccessGrant, revokeAccessGrant, hashGrantToken } from "../lib/application/grants";
import { createApplicationMcpServer } from "../lib/application/mcp";
import { lookupWarehouseInventory } from "../lib/warehouse-lookup";

const configured = process.env.DATABASE_URL;
const target = configured ? new URL(configured) : null;
const safe = target?.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test";
test("real database and MCP preserve identity, candidate boundaries and grant revocation", { skip: !configured }, async () => {
  assert.ok(safe, "Integration test refuses anything except the dedicated local v2 test database.");
  const suffix = randomUUID(), lpn = `000-V2-${suffix.toUpperCase()}`, order = `ORDER_%_${suffix}`;
  const user = await prisma.user.create({ data: { username: `v2-fixture-${suffix}`, displayName: "Synthetic operator", pinHash: "not-a-usable-credential", role: "user" } });
  const other = await prisma.user.create({ data: { username: `v2-other-${suffix}`, displayName: "Other synthetic operator", pinHash: "not-a-usable-credential" } });
  const now = Date.now();
  const claim = { userId: user.id, authVersion: user.authVersion, issuedAt: now, expiresAt: now + 60_000, sessionId: randomUUID() };
  const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id } }));
  const otherPrincipal = await resolvePrincipal({ ...claim, userId: other.id, authVersion: other.authVersion }, id => prisma.user.findUnique({ where: { id } }));
  assert.ok(principal); assert.ok(otherPrincipal);
  const capturedAt = new Date("2026-10-01T13:00:00Z");
  await prisma.inventoryAuditItem.create({ data: { lpn, status: "Delivered", orderNumber: order, vendor: "Synthetic vendor", receivedDate: "2026-09-01", description: "Synthetic appliance", customerName: "Fixture recipient", contentHash: "fixture", sourceData: { LPN: lpn, privateRuntimeField: "synthetic-only" }, archivedAt: new Date() } });
  await prisma.inventoryAuditScan.create({ data: { sourceScanId: suffix, pickWaveId: `fixture-${suffix}`, pickWaveName: "Synthetic historical pass", scannedValue: lpn, lpn, scannedAt: capturedAt, scannedByName: "Synthetic operator", matchedPickWave: false, duplicateInWave: false } });
  const server = createApplicationMcpServer(async () => authenticateAccessGrant(grant.token));
  const client = new Client({ name: "synthetic-integration-client", version: "1" });
  let grant: Awaited<ReturnType<typeof createAccessGrant>>;
  try {
    grant = await createAccessGrant(principal, { clientName: "Synthetic test", scopes: ["inventory.read"], lifetimeMinutes: 5 });
    const stored = await prisma.appAccessGrant.findUniqueOrThrow({ where: { id: grant.grant.id } });
    assert.equal(stored.tokenHash, hashGrantToken(grant.token));
    assert.notEqual(stored.tokenHash, grant.token);
    await assert.rejects(createAccessGrant(principal, { clientName: "Escalation attempt", scopes: ["users.manage"] }));
    const uiResult = await lookupWarehouseInventory(principal, { kind: "lpn", value: lpn.toLowerCase() });
    assert.equal(uiResult.physicalPresence, "not_determined");
    assert.equal(uiResult.kind, "lpn");
    if (uiResult.kind === "lpn") {
      assert.equal(uiResult.record?.reportedStatus, "Delivered");
      assert.equal(uiResult.lastObservation?.capturedAt, capturedAt.toISOString());
      assert.ok(uiResult.record?.archivedAt);
    }
    const candidates = await lookupWarehouseInventory(principal, { kind: "order", value: order });
    assert.equal(candidates.kind, "order");
    if (candidates.kind === "order") { assert.equal(candidates.candidates.length, 1); assert.equal(candidates.identityResolved, false); }
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "warehouse_lookup", arguments: { kind: "lpn", value: lpn } });
    assert.equal(response.isError, undefined);
    const content = response.content as { type: string; text: string }[];
    assert.deepEqual(JSON.parse(content[0].text), uiResult);
    assert.equal((await client.callTool({ name: "mars_workflow_summary", arguments: {} })).isError, true);
    assert.equal((await revokeAccessGrant(otherPrincipal, grant.grant.id)).revoked, false);
    assert.ok(await authenticateAccessGrant(grant.token));
    await prisma.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 } } });
    assert.equal(await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id } })), null);
    assert.equal((await client.callTool({ name: "warehouse_lookup", arguments: { kind: "lpn", value: lpn } })).isError, true);
    await assert.rejects(authenticateAccessGrant(grant.token));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    await prisma.inventoryAuditScan.deleteMany({ where: { sourceScanId: suffix } });
    await prisma.inventoryAuditItem.deleteMany({ where: { lpn } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    await prisma.$disconnect();
  }
});
