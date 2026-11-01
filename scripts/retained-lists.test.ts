import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { decodeRetainedWorkbookBase64, RetainedWorkbookError, validateRetainedWorkbook } from "../lib/retained-workbook";
import { boundedRetainedCsv, RetainedListError } from "../lib/scan-lists";
import type { Principal } from "../lib/auth/principal";

async function workbook() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Synthetic routes");
  sheet.addRow(["Route", "Contact", "Order", "LPN", "Serial", "Tracking", "Part", "Description"]);
  sheet.addRow(["DEMO-100", "=SYNTHETIC_FORMULA()", "ORDER-DEMO-A", "00123", "SERIAL-DEMO-A", "TRACK-DEMO-A", "PART-DEMO-A", "Synthetic appliance A"]);
  sheet.addRow(["demo-100", "Synthetic recipient B", "ORDER-DEMO-B", "LPN-DEMO-B", "SERIAL-DEMO-B", "TRACK-DEMO-B", "PART-DEMO-B", "Synthetic appliance B"]);
  sheet.addRow([null, "Synthetic recipient C", "ORDER-DEMO-C", "LPN-DEMO-C", null, null, null, "Synthetic no-route appliance"]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
test("bounded workbook preflight accepts retained XLSX and rejects sparse-row and actual expanded archive excess", async () => {
  const bytes = await workbook(); assert.deepEqual(decodeRetainedWorkbookBase64(bytes.toString("base64")), bytes); assert.deepEqual(await validateRetainedWorkbook(bytes), bytes);
  assert.throws(() => decodeRetainedWorkbookBase64("not-base64"), RetainedWorkbookError);
  const sparse = await JSZip.loadAsync(bytes); sparse.file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="999999999"><c r="A999999999"><v>1</v></c></row></sheetData></worksheet>');
  await assert.rejects(validateRetainedWorkbook(await sparse.generateAsync({ type: "nodebuffer" })), (error: unknown) => error instanceof RetainedWorkbookError && error.status === 413);
  const bomb = new JSZip(); bomb.file("[Content_Types].xml", "<Types/>"); bomb.file("xl/workbook.xml", "<workbook/>"); bomb.file("xl/worksheets/sheet1.xml", "x".repeat(32 * 1024 * 1024 + 1));
  await assert.rejects(validateRetainedWorkbook(await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })), (error: unknown) => error instanceof RetainedWorkbookError && error.status === 413);
});
test("retained CSV keeps quoted identifiers and protects spreadsheet formula cells", () => {
  const csv = boundedRetainedCsv([["LPN", "Contact"], ["00123", '=SYNTHETIC("A")'], ["LPN-DEMO", "plain, quoted"]]);
  assert.ok(csv.includes('"00123"')); assert.ok(csv.includes('"\'=SYNTHETIC(""A"")"')); assert.ok(csv.includes('"plain, quoted"'));
});
test("saved lists and Route Recon use one current principal, conflict-safe retries and readable legacy rows", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!); assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated local test database required.");
  const [{ prisma }, commands, native, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/application/retained-lists"), import("../lib/scan-lists"), import("../lib/auth/principal")]);
  const userIds: string[] = [], bundleIds: string[] = [], legacyIds: string[] = [];
  async function actor(capabilities: string[]) {
    const bundle = await prisma.roleBundle.create({ data: { name: `Retained fixture ${randomUUID()}`, capabilities } }); bundleIds.push(bundle.id);
    const user = await prisma.user.create({ data: { username: `retained-fixture-${randomUUID()}`, displayName: "Synthetic retained operator", role: "user", pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId: bundle.id } } } }); userIds.push(user.id);
    const now = new Date(), session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, lastActivityAt: now, lastStrongAuthenticatedAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000), deviceLabel: "Synthetic retained workflow" } });
    const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(principal); return { ...principal, sessionId: session.id } as Principal;
  }
  try {
    const operator = await actor(["workflow.read", "workflow.execute"]), other = await actor(["workflow.read", "workflow.execute"]), reader = await actor(["workflow.read"]);
    const payload = { localDraftId: randomUUID(), name: "Synthetic shared draft", createdAt: "2026-10-31T10:00:00.000Z", userId: other.userId, scans: [{ value: "00123", scannedAt: "2026-10-31T10:01:00.000Z" }, { value: "LPN-DEMO-B", scannedAt: "2026-10-31T10:02:00.000Z" }, { value: "LPN-DEMO-B", scannedAt: "2026-10-31T10:02:00.000Z" }] };
    const [first, duplicate] = await Promise.all([commands.createScanList(operator, payload), commands.createScanList(operator, payload)]); assert.equal(first.id, duplicate.id);
    const stored = await prisma.scanListSession.findUniqueOrThrow({ where: { id: first.id }, include: { items: true } }); assert.equal(stored.createdByUserId, operator.userId); assert.equal(stored.items.length, 3); assert.ok(stored.items.every(item => item.scannedByUserId === operator.userId));
    assert.equal((await commands.createScanList(operator, { ...payload, scans: [...payload.scans].reverse() })).id, first.id);
    const separate = await commands.createScanList(other, payload); assert.notEqual(separate.id, first.id, "Two people cannot collide on a device draft ID.");
    await assert.rejects(commands.createScanList(operator, { ...payload, name: "Changed saved event" }), (error: unknown) => error instanceof RetainedListError && error.status === 409);
    await assert.rejects(commands.createScanList(operator, { ...payload, scans: [{ value: "changed", scannedAt: payload.scans[0].scannedAt }] }), (error: unknown) => error instanceof RetainedListError && error.status === 409);
    const legacyPayload = { ...payload, localDraftId: randomUUID(), name: "Synthetic legacy named list" };
    const legacy = await prisma.scanListSession.create({ data: { localDraftId: legacyPayload.localDraftId, name: legacyPayload.name, createdByUserId: operator.userId, createdAt: new Date(legacyPayload.createdAt), items: { create: legacyPayload.scans.map(scan => ({ scannedValue: scan.value, createdAt: new Date(scan.scannedAt), scannedByUserId: operator.userId })) } } }); legacyIds.push(legacy.id);
    assert.equal((await commands.createScanList(operator, legacyPayload)).id, legacy.id);
    assert.notEqual((await commands.createScanList(other, legacyPayload)).id, legacy.id);
    const unowned = await prisma.scanListSession.create({ data: { localDraftId: randomUUID(), name: "Synthetic legacy unowned list", items: { create: { scannedValue: "LPN-LEGACY-UNOWNED" } } } }); legacyIds.push(unowned.id);
    assert.equal((await commands.getScanList(reader, { id: unowned.id })).items[0].scannedValue, "LPN-LEGACY-UNOWNED");
    await assert.rejects(commands.archiveScanList(reader, { id: first.id })); await assert.rejects(commands.deleteScanList(reader, { id: first.id })); await assert.rejects(commands.createScanList(reader, { ...payload, localDraftId: randomUUID() }));
    const archived = await commands.archiveScanList(operator, { id: first.id }); assert.ok(archived.archivedAt); assert.deepEqual(await commands.archiveScanList(operator, { id: first.id }), archived); assert.equal((await commands.restoreScanList(operator, { id: first.id })).archivedAt, null);
    assert.ok((await commands.exportScanList(reader, { id: first.id })).content.includes('"00123"'));
    const bytes = await workbook(), reconInput = { name: "Synthetic Route Recon", filename: "synthetic-routes.xlsx", operationId: randomUUID(), contentBase64: bytes.toString("base64"), userId: other.userId };
    const preview = await commands.previewRouteRecon(reader, { contentBase64: reconInput.contentBase64 }); assert.equal(preview.itemCount, 3); assert.equal(preview.routes.length, 2);
    const [report, repeated] = await Promise.all([commands.importRouteRecon(operator, reconInput), commands.importRouteRecon(operator, reconInput)]); assert.equal(report.id, repeated.id); assert.equal((await prisma.routeRecon.findUniqueOrThrow({ where: { id: report.id } })).createdByUserId, operator.userId);
    await assert.rejects(commands.importRouteRecon(operator, { ...reconInput, name: "Changed import event" }), (error: unknown) => error instanceof RetainedListError && error.status === 409);
    const printable = await commands.getRouteReconPrintableData(reader, { id: report.id, routeNumber: "demo-100" }); assert.equal(printable.items.length, 2); assert.equal(printable.physicalPrinting, "requires_connected_device_or_browser_confirmation"); assert.equal((await commands.getRouteReconPrintableData(reader, { id: report.id, routeNumber: null })).items.length, 1);
    assert.ok((await commands.exportRouteRecon(reader, { id: report.id })).content.includes("'=SYNTHETIC_FORMULA()"));
    await assert.rejects(commands.archiveRouteRecon(reader, { id: report.id })); await commands.archiveRouteRecon(operator, { id: report.id }); assert.equal((await commands.restoreRouteRecon(operator, { id: report.id })).archivedAt, null);
    await commands.deleteRouteRecon(operator, { id: report.id }); await assert.rejects(commands.importRouteRecon(operator, reconInput), (error: unknown) => error instanceof RetainedListError && error.status === 410);
    await commands.deleteScanList(operator, { id: first.id }); await commands.deleteScanList(operator, { id: first.id }); await assert.rejects(commands.createScanList(operator, payload), (error: unknown) => error instanceof RetainedListError && error.status === 410);
    await prisma.roleBundle.update({ where: { id: bundleIds[0] }, data: { capabilities: ["workflow.read"] } }); await assert.rejects(native.saveScanList({ ...payload, localDraftId: randomUUID() }, operator));
    await prisma.userSession.update({ where: { id: other.sessionId }, data: { revokedAt: new Date() } }); await assert.rejects(commands.archiveScanList(other, { id: separate.id }));
    assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: { in: userIds } } }), 0, "Saved list rows are not physical warehouse evidence.");
  } finally {
    await prisma.scanListSession.deleteMany({ where: { OR: [{ createdByUserId: { in: userIds } }, { id: { in: legacyIds } }] } }); await prisma.routeRecon.deleteMany({ where: { createdByUserId: { in: userIds } } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: { in: userIds } } }); await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await prisma.roleBundle.deleteMany({ where: { id: { in: bundleIds } } }); await prisma.$disconnect();
  }
});
