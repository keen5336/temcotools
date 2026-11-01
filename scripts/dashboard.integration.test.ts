import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../lib/db";
import { CURRENT_USER_SELECT, resolvePrincipal } from "../lib/auth/principal";
import { getOperationalDashboard, saveDashboardPreferences } from "../lib/dashboard";
import { authenticateAccessGrant, createAccessGrant } from "../lib/application/grants";

test("dashboard uses current widget authority, durable preferences and optimistic concurrency", { skip: !process.env.DATABASE_URL }, async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test", "Only the dedicated synthetic database is allowed.");
  const user = await prisma.user.create({ data: { username: `dashboard-${randomUUID()}`, displayName: "Synthetic dashboard operator", pinHash: "disabled:v2", roleBundles: { create: { bundleId: "legacy-user" } } } });
  const now = Date.now(), sessionId = randomUUID();
  const session = await prisma.userSession.create({ data: { id: sessionId, userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic test", expiresAt: new Date(now + 60_000) } });
  try {
    const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    assert.ok(principal); principal.sessionId = sessionId;
    const first = await getOperationalDashboard(principal);
    assert.ok(first.widgets.some(widget => widget.id === "observations"));
    assert.equal(first.availableWidgets.some(widget => widget.id === "access"), false);
    await assert.rejects(saveDashboardPreferences(principal, { expectedRevision: 0, widgetIds: ["access"] }));
    const saved = await saveDashboardPreferences(principal, { expectedRevision: 0, widgetIds: ["sources", "observations"] });
    assert.deepEqual((await getOperationalDashboard(principal)).selectedWidgetIds, ["sources", "observations"]);
    await assert.rejects(saveDashboardPreferences(principal, { expectedRevision: 0, widgetIds: [] }));
    const grant = await createAccessGrant(principal, { clientName: "Synthetic read-only dashboard", scopes: ["inventory.read"], lifetimeMinutes: 5 });
    const limited = await authenticateAccessGrant(grant.token);
    assert.deepEqual((await getOperationalDashboard(limited)).availableWidgets.map(widget => widget.id), ["observations", "sources"]);
    await assert.rejects(saveDashboardPreferences(limited, { expectedRevision: saved.revision, widgetIds: [] }));
    await assert.rejects(createAccessGrant(limited, { clientName: "Forbidden nested grant", scopes: ["inventory.read"] }));
    await saveDashboardPreferences(principal, { expectedRevision: saved.revision, widgetIds: [], useDefaults: true });
    assert.equal((await getOperationalDashboard(principal)).revision, 0);
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(getOperationalDashboard(principal));
  } finally { await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect(); }
});
