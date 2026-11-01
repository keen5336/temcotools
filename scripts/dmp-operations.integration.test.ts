import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { prisma } from "../lib/db";
import { CURRENT_USER_SELECT, resolvePrincipal } from "../lib/auth/principal";
import { authenticateAccessGrant, createAccessGrant } from "../lib/application/grants";
import { getDmpReceipt, requestDmpOperation } from "../lib/api-relay/service";

test("named DMP intents survive lost responses without replay or scope escalation", { skip: !process.env.DATABASE_URL }, async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test");
  let sends = 0;
  const broker = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); sends++;
    if (input.request.path === "/synthetic-lost-response") { request.socket.destroy(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ requestId: `synthetic-${sends}`, ok: true, status: 200, body: "synthetic response only", dispatchState: "dispatched" }));
  });
  broker.listen(0, "127.0.0.1"); await once(broker, "listening"); const address = broker.address(); assert.ok(address && typeof address !== "string");
  process.env.API_RELAY_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  process.env.SESSION_SECRET = "synthetic-dmp-operation-secret-2026-only";
  process.env.DMP_API_OPERATIONS = JSON.stringify({ synthetic_write: { label: "Synthetic test mutation", method: "POST", path: "/synthetic-fixture-only" }, synthetic_lost: { label: "Synthetic lost response", method: "POST", path: "/synthetic-lost-response" } });
  const user = await prisma.user.create({ data: { username: `dmp-intent-${randomUUID()}`, displayName: "Synthetic operator", pinHash: "disabled:v2", roleBundles: { create: { bundleId: "legacy-user" } } } });
  const sessionId = randomUUID(), now = Date.now();
  const session = await prisma.userSession.create({ data: { id: sessionId, userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic client", expiresAt: new Date(now + 60_000) } });
  try {
    const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(principal); principal.sessionId = sessionId;
    const input = { operationId: randomUUID(), operation: "synthetic_write", connectionId: "synthetic-device", input: {} };
    const outcomes = await Promise.all([requestDmpOperation(principal, input), requestDmpOperation(principal, input)]);
    assert.equal(sends, 1); assert.equal(outcomes.filter(result => result.replayed).length, 1);
    assert.equal((await getDmpReceipt(principal, input))?.state, "response_observed");
    const repeated = await requestDmpOperation(principal, input); assert.equal(repeated.replayed, true); assert.equal(sends, 1);
    await assert.rejects(requestDmpOperation(principal, { ...input, operation: "synthetic_lost" }));
    const lost = { ...input, operationId: randomUUID(), operation: "synthetic_lost" };
    assert.equal((await requestDmpOperation(principal, lost)).receipt.state, "unknown");
    assert.equal((await requestDmpOperation(principal, lost)).replayed, true); assert.equal(sends, 2);
    await assert.rejects(requestDmpOperation(principal, { ...lost, operationId: randomUUID(), connectionId: "different-device" }), /matching mutation/); assert.equal(sends, 2);
    const grant = await createAccessGrant(principal, { clientName: "Read-only synthetic DMP", scopes: ["workflow.read"] });
    await assert.rejects(requestDmpOperation(await authenticateAccessGrant(grant.token), { ...input, operationId: randomUUID() })); assert.equal(sends, 2);
    const stored = await prisma.dmpOperation.findMany({ where: { actorUserId: user.id } });
    assert.equal(JSON.stringify(stored).includes("synthetic response only"), false);
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(getDmpReceipt(principal, input));
  } finally {
    await new Promise<void>(resolve => broker.close(() => resolve()));
    await prisma.dmpOperation.deleteMany({ where: { actorUserId: user.id } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect();
  }
});
