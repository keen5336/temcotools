import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";
import { prisma } from "../lib/db";
import { CURRENT_USER_SELECT, resolvePrincipal } from "../lib/auth/principal";
import { importPickWorkbook } from "../lib/application/pick-actions";
import { ingestWarehouseScan } from "../lib/application/scan-ingestion";
import { createOfficeDisposition } from "../lib/office/service";
import { createWarehouseUnit, linkWarehouseIdentifier } from "../lib/warehouse/units";
import { PICK_WAVE_STAGING_LOCATIONS } from "../lib/pick-wave-constants";

test("shared pick capture retains physical evidence, rejects ambiguous orders and honors office holds", { skip: !process.env.DATABASE_URL }, async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.ok(target.hostname === "127.0.0.1" && target.port === "55439" && target.pathname === "/temcotools_v2_test");
  const prefix = `SCAN-FLOW-${randomUUID()}`, at = new Date();
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic workflow operator", pinHash: "disabled:v2", role: "admin", roleBundles: { create: { bundleId: "legacy-admin" } } } });
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic scanner", lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 60_000) } });
  const units: string[] = []; let waveId = "";
  try {
    const actor = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(actor); actor.sessionId = session.id; actor.strongAuthenticatedAt = at.getTime(); actor.mfaVerifiedAt = at.getTime();
    for (const suffix of ["A", "B"]) {
      const unit = await createWarehouseUnit(actor, { operationId: `${prefix}-${suffix}`, evidence: "Synthetic distinct appliance label verified." }); units.push(unit.unitId);
      await linkWarehouseIdentifier(actor, { unitId: unit.unitId, kind: "lpn", value: `${prefix}-${suffix}`, evidence: "Synthetic scanner identifier attached to this unit." });
    }
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Synthetic picks");
    sheet.addRow(["Route", "LPN", "Order Number", "Description"]);
    sheet.addRow(["SYNTHETIC-ROUTE", `${prefix}-A`, `${prefix}-ORDER`, "Synthetic appliance A"]);
    sheet.addRow(["SYNTHETIC-ROUTE", `${prefix}-B`, `${prefix}-ORDER`, "Synthetic appliance B"]);
    const input = { operationId: randomUUID(), name: prefix, filename: "synthetic.xlsx", contentBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"), routeMappings: [{ routeNumber: "SYNTHETIC-ROUTE", stagingLocation: PICK_WAVE_STAGING_LOCATIONS[0] }] };
    const [one, two] = await Promise.all([importPickWorkbook(actor, input), importPickWorkbook(actor, input)]); waveId = one.id; assert.equal(two.id, waveId);
    await assert.rejects(importPickWorkbook(actor, { ...input, name: `${prefix}-changed` }));
    const capture = (value: string, eventId = randomUUID()) => ({ eventId, rawIdentifier: value, capturedByUserId: user.id, capturedAt: new Date().toISOString(), type: "presence" as const, pickWaveId: waveId });
    const ambiguous = await ingestWarehouseScan(actor, capture(`${prefix}-ORDER`)); assert.ok("task" in ambiguous && ambiguous.task.ambiguous); assert.equal(await prisma.pickWaveItem.count({ where: { pickWaveId: waveId, scannedAt: { not: null } } }), 0);
    const event = capture(`${prefix}-A`);
    const first = await ingestWarehouseScan(actor, event); const replay = await ingestWarehouseScan(actor, event);
    assert.ok("task" in first && first.task.matched); assert.ok(replay.replayed);
    assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: user.id, eventId: event.eventId } }), 1);
    assert.equal(await prisma.pickWaveScan.count({ where: { captureEventId: `${user.id}:${event.eventId}` } }), 1);
    await createOfficeDisposition(actor, { operationId: randomUUID(), unitId: units[1], kind: "hold", reason: "Synthetic office inspection is required before delivery.", instruction: "HOLD: office inspection before staging replacement B." });
    const held = await ingestWarehouseScan(actor, capture(`${prefix}-B`));
    assert.ok("task" in held && !held.task.matched); assert.ok("instructions" in held.office && held.office.instructions.some(instruction => instruction.action === "hold"));
    assert.equal((await prisma.pickWaveItem.findFirstOrThrow({ where: { pickWaveId: waveId, lpn: `${prefix}-B` } })).scannedAt, null);
    assert.ok(await prisma.warehousePhysicalObservation.findFirst({ where: { userId: user.id, unitId: units[1] } }));
  } finally {
    if (waveId) await prisma.pickWave.delete({ where: { id: waveId } });
    await prisma.officeCommandReceipt.deleteMany({ where: { userId: user.id } });
    await prisma.officeDisposition.deleteMany({ where: { unitId: { in: units } } });
    await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: user.id } });
    await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: units } } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: units } } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: user.id } }); await prisma.$disconnect();
  }
});
