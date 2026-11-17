import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DEFAULT_RELAY_PROGRAM } from "../../lib/api-relay/default-program";

const database = process.env.API_RELAY_TEST_DATABASE_URL;
test("managed relays enforce live admin roles, immutable history, concurrency, bindings and DMP fallback in PostgreSQL", { skip: !database }, async () => {
  const target = new URL(database!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55475"); assert.equal(target.pathname, "/relay_qa");
  process.env.DATABASE_URL = database;
  const { prisma } = await import("../../lib/db");
  const { getRelayManager, listRelayDefinitions, saveRelayDefinition, validateRelayBinding } = await import("../../lib/api-relay/definitions");
  const make = (expectedRevision = 0) => ({ id: "warehouse", name: "Warehouse", enabled: true, origins: ["https://warehouse.test"], pathPrefix: "/ops", identityPath: "/api/me", subjectPath: "user.id", operations: { lookup: { label: "Look up item", path: "/api/items/{item}" } }, program: DEFAULT_RELAY_PROGRAM, expectedRevision, operationId: randomUUID() });
  try {
    assert.equal((await listRelayDefinitions()).find(row => row.id === "dmp")!.revision, 0);
    assert.equal(await prisma.apiRelayDefinition.count(), 0, "reads do not write defaults");
    for (const [id, role, isActive] of [["relay-admin", "admin", true], ["relay-manager", "manager", true], ["relay-user", "user", true], ["relay-inactive", "admin", false]] as const) await prisma.user.create({ data: { id, username: id, displayName: id, pinHash: "synthetic-unused", role, isActive } });
    for (const userId of ["relay-manager", "relay-user", "relay-inactive", "missing"]) { await assert.rejects(getRelayManager(userId)); await assert.rejects(saveRelayDefinition(userId, make())); }
    const first = make(); assert.equal((await saveRelayDefinition("relay-admin", first)).revision, 1);
    assert.equal((await saveRelayDefinition("relay-admin", first)).revision, 1);
    assert.equal(await prisma.apiRelayRevision.count(), 1);
    await assert.rejects(saveRelayDefinition("relay-admin", { ...first, name: "Different edit" }), /another edit/);
    await assert.rejects(saveRelayDefinition("relay-admin", make(0)), /changed/);
    await assert.rejects(saveRelayDefinition("relay-admin", { ...make(), id: "overlap", pathPrefix: "/ops/orders" }), /overlaps/);
    const { hashPassword } = await import("../../lib/auth/passwords");
    await prisma.user.update({ where: { id: "relay-user" }, data: { passwordHash: await hashPassword("Synthetic relay cedar 71"), passwordEnrolledAt: new Date(), legacyDisabledAt: new Date() } });
    const session = await prisma.authSession.create({ data: { id: randomUUID(), userId: "relay-user", authVersion: 1, kind: "password", deviceName: "Test", expiresAt: new Date(Date.now() + 60_000) } });
    const binding = { relayId: "warehouse", relayRevision: 1, origin: "https://warehouse.test", pathname: "/ops/items", owner: { userId: "relay-user", sessionId: session.id } };
    assert.equal((await validateRelayBinding(binding)).id, "warehouse");
    await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await assert.rejects(validateRelayBinding(binding), /session expired or was revoked/);
    await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: null } });
    const concurrent = await Promise.allSettled([saveRelayDefinition("relay-admin", make(1)), saveRelayDefinition("relay-admin", make(1))]);
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected").length, 1);
    await assert.rejects(validateRelayBinding(binding), /changed/);
    const current = (await listRelayDefinitions()).find(row => row.id === "warehouse")!;
    await saveRelayDefinition("relay-admin", { ...make(current.revision), enabled: false });
    await assert.rejects(validateRelayBinding({ ...binding, relayRevision: current.revision + 1 }), /No enabled/);
    const dmp = (await listRelayDefinitions()).find(row => row.id === "dmp")!;
    const { revision, ...fields } = dmp;
    await saveRelayDefinition("relay-admin", { ...fields, enabled: false, expectedRevision: revision, operationId: randomUUID() });
    assert.equal((await listRelayDefinitions()).find(row => row.id === "dmp")!.enabled, false, "disabled builtin never falls back to the environment");
    await prisma.user.update({ where: { id: "relay-admin" }, data: { role: "manager" } });
    await assert.rejects(saveRelayDefinition("relay-admin", make(3)), /Only administrators/);
    const history = await prisma.apiRelayRevision.findMany({ where: { relayId: "warehouse" }, orderBy: { revision: "asc" } });
    assert.deepEqual(history.map(row => row.revision), [1, 2, 3]);
    assert.equal((history[0].snapshot as { enabled: boolean }).enabled, true);
  } finally { await prisma.$disconnect(); }
});
