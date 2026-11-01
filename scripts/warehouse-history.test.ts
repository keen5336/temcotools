import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";

const testUrl = process.env.WAREHOUSE_TEST_DATABASE_URL;
test("warehouse history pages/export retain complete corrected evidence beyond screen limits", { skip: !testUrl }, async () => {
  const url = new URL(testUrl!); assert.equal(url.protocol, "postgresql:"); assert.ok(["127.0.0.1", "localhost"].includes(url.hostname)); assert.equal(url.pathname, "/temcotools_v2_test"); assert.equal(url.search, "");
  process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db");
  const { getWarehouseUnit, getWarehouseUnitObservations, getWarehouseSourceRevisions, exportWarehouseUnitHistory } = await import("../lib/warehouse/units");
  const prefix = `HISTORY-${randomUUID()}`;
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic history reviewer", pinHash: "not-a-login", role: "admin" } });
  const unit = await prisma.warehouseUnit.create({ data: { createdByUserId: user.id } });
  const actor: Principal = { userId: user.id, username: user.username, displayName: user.displayName, authVersion: user.authVersion, role: "admin", capabilities: [...CAPABILITIES] };
  const base = new Date(Date.now() - 86_400_000);
  const row = await prisma.inventoryAuditItem.create({ data: { lpn: prefix, unitId: unit.id, status: "Stored", orderNumber: "SYNTHETIC-ORDER", vendor: "Synthetic vendor", receivedDate: base.toISOString().slice(0, 10), description: "Synthetic history appliance", customerName: "Synthetic recipient", sourceData: { revision: "27" }, contentHash: "synthetic-hash", revision: 27 } });
  const batchIds: string[] = [];
  try {
    await prisma.inventorySourceRevision.createMany({ data: Array.from({ length: 27 }, (_, index) => ({ id: `${prefix}-revision-${String(index + 1).padStart(2, "0")}`, inventoryItemId: row.id, revision: index + 1, contentHash: `synthetic-${index}`, sourceData: { syntheticExtraColumn: `revision-${index + 1}` }, lpn: row.lpn, status: "Stored", receivedDate: row.receivedDate, orderNumber: row.orderNumber, vendor: row.vendor, description: row.description, customerName: row.customerName, recordedAt: base })) });
    for (let index = 0; index < 6; index++) {
      const batch = await prisma.inventoryAuditImport.create({ data: { filename: "synthetic-history.xlsx", uploadedByName: "Synthetic reviewer", rowCount: 1, insertedCount: 0, changedCount: 0, unchangedCount: 1, duplicateCount: 0, blankCount: 0, scope: prefix } }); batchIds.push(batch.id);
      await prisma.inventoryImportMembership.create({ data: { importId: batch.id, sourceRevisionId: `${prefix}-revision-01`, lpn: row.lpn } });
    }
    const ids = Array.from({ length: 210 }, (_, index) => `${prefix}-observation-${String(index).padStart(3, "0")}`);
    await prisma.warehousePhysicalObservation.createMany({ data: ids.map((id, index) => ({ id, userId: user.id, eventId: id, fingerprint: `synthetic-${index}`, rawIdentifier: prefix, identifierType: "lpn", type: "presence", location: "SYNTHETIC-WAREHOUSE", captureMethod: "manual", capturedAt: new Date(base.getTime() + index), unitId: unit.id, resolution: "resolved", candidateUnitIds: [unit.id] })) });
    await prisma.warehouseObservationCorrection.createMany({ data: ids.slice(5).map((observationId) => ({ observationId, unitId: null, reason: "Synthetic identity amendment removes this current unit association but retains original evidence.", userId: user.id, revision: 1 })) });
    const screen = await getWarehouseUnit(actor, { unitId: unit.id });
    assert.equal(screen.observations.length, 200); assert.equal(screen.observationsMayBeTruncated, true);
    assert.ok(screen.observationHistoryCursor); assert.equal(screen.sourceHistoryMayBeTruncated, true);
    assert.equal(screen.observations.some((item) => item.associationCurrent), false);
    assert.equal(screen.physicalState.observedAt, new Date(base.getTime() + 4).toISOString(), "Current physical summary must not be lost behind a truncated display of corrected-away history.");
    const seen = new Set<string>(); let cursor: string | undefined;
    do { const page = await getWarehouseUnitObservations(actor, { unitId: unit.id, limit: 50, cursor }); for (const item of page.items) { assert.equal(seen.has(item.observationId), false); seen.add(item.observationId); } cursor = page.nextCursor ?? undefined; } while (cursor);
    assert.equal(seen.size, 210);
    const revisions = new Set<string>();
    do { const page = await getWarehouseSourceRevisions(actor, { unitId: unit.id, limit: 10, cursor }); for (const item of page.items) { assert.equal(revisions.has(item.sourceRevisionId), false); revisions.add(item.sourceRevisionId); if (item.revision === 1) assert.equal(item.reports.length, 6); } cursor = page.nextCursor ?? undefined; } while (cursor);
    assert.equal(revisions.size, 27);
    const exported = await exportWarehouseUnitHistory(actor, { unitId: unit.id });
    assert.equal(exported.observationCount, 210); assert.equal(exported.sourceRevisionCount, 27);
    const body = JSON.parse(exported.json); assert.equal(body.observations.length, 210); assert.equal(body.sourceRevisions.length, 27); assert.equal(body.observations.filter((item: { associationCurrent: boolean }) => !item.associationCurrent).length, 205);
    await assert.rejects(getWarehouseUnitObservations(actor, { unitId: unit.id, cursor: "invalid" }), /Invalid history/);
  } finally {
    await prisma.warehouseObservationCorrection.deleteMany({ where: { userId: user.id } }); await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: user.id } });
    await prisma.inventoryImportMembership.deleteMany({ where: { importId: { in: batchIds } } }); await prisma.inventorySourceRevision.deleteMany({ where: { inventoryItemId: row.id } }); await prisma.inventoryAuditItem.delete({ where: { id: row.id } }); await prisma.inventoryAuditImport.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.warehouseUnit.delete({ where: { id: unit.id } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.$disconnect();
  }
});
