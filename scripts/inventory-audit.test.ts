import assert from "node:assert/strict";
import test from "node:test";
import { lpnInputDate, prepareLpnReport, type LpnSourceRow } from "../lib/lpn-report";

function row(lpn: string, overrides: LpnSourceRow = {}): LpnSourceRow {
  return { LPN: lpn, Status: "Placing", "Order Number": "ORDER-1", Vendor: "Vendor", "Received Date": "10/08/2026", Description: "Washer", "Deliver to:": "Customer", Location: "A1", ...overrides };
}

test("LPN reports preserve keys, include all statuses, normalize dates, and reject conflicting duplicate LPNs", () => {
  assert.equal(lpnInputDate("10/08/2026 10:30"), "2026-10-08");
  assert.equal(lpnInputDate(46303), "2026-10-08");
  const parsed = prepareLpnReport([row(" 0001 "), row("0001"), row("a2", { Status: "Shipped" }), row("")]);
  assert.equal(parsed.items[0].lpn, "0001");
  assert.equal(parsed.items[1].lpn, "A2");
  assert.equal(parsed.items[1].status, "Shipped");
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.blankCount, 1);
  assert.throws(() => prepareLpnReport([row("A1"), row("a1", { Location: "B2" })]), /conflicting rows/);
  assert.throws(() => prepareLpnReport([{ LPN: "A1" }]), /Missing report columns/);
  assert.notDeepEqual(prepareLpnReport([row("D1", { "Received Date": "10/08/2026 10:30" })]).items[0].sourceData, prepareLpnReport([row("D1", { "Received Date": "10/08/2026 11:30" })]).items[0].sourceData);
  const reordered = Object.fromEntries(Object.entries(row("0001")).reverse());
  assert.deepEqual(prepareLpnReport([reordered]).items[0].sourceData, parsed.items[0].sourceData);
});

const testUrl = process.env.AUDIT_TEST_DATABASE_URL;
test("Inventory Audit keeps historical inventory and reconciles complete, repeatable Pick Wave exports", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!);
  assert.equal(url.pathname, "/temcotools_audit_test", "Use a dedicated, disposable audit test database.");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Tests only accept local databases.");
  process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db");
  const { archiveAuditItems, exportPickWaveToAudit, getInventoryAudit, importInventoryReport, parseAuditFilters } = await import("../lib/inventory-audit");
  const importRows = (rows: LpnSourceRow[]) => importInventoryReport({ rows, filename: "lpn-report.xlsx", uploadedByName: "Audit tester" });
  await prisma.inventoryAuditScan.deleteMany();
  await prisma.inventoryAuditItem.deleteMany();
  await prisma.inventoryAuditImport.deleteMany();
  await prisma.pickWave.deleteMany();
  await prisma.user.deleteMany();
  try {
    const user = await prisma.user.create({ data: { username: "audit-tester", displayName: "Audit tester", pinHash: "unused" } });
    const wave = await prisma.pickWave.create({ data: { name: "Audit fixture", sourceFilename: "pick.xlsx", createdByUserId: user.id,
      items: { create: [{ rowNumber: 2, lpn: "a1", serialNumber: "SERIAL-A" }, { rowNumber: 3, serialNumber: "NO-LPN" }] },
    }, include: { items: true } });
    const item = wave.items.find((item) => item.lpn)!;
    const noLpn = wave.items.find((item) => !item.lpn)!;
    await prisma.pickWaveScan.createMany({ data: [
      ...Array.from({ length: 28 }, (_, index) => ({ pickWaveId: wave.id, itemId: item.id, scannedValue: index ? "a1" : "SERIAL-A", matched: true, alreadyScanned: index > 0, scannedByUserId: user.id })),
      { pickWaveId: wave.id, scannedValue: "B2", matched: false, scannedByUserId: user.id },
      { pickWaveId: wave.id, itemId: noLpn.id, scannedValue: "NO-LPN", matched: true, scannedByUserId: user.id },
    ] });
    await t.test("exports all scans before a report exists and concurrent retries do not duplicate history", async () => {
      const results = await Promise.all([exportPickWaveToAudit(wave.id), exportPickWaveToAudit(wave.id)]);
      assert.equal(results.reduce((sum, result) => sum + result.newScanCount, 0), 30);
      assert.equal(await prisma.inventoryAuditScan.count(), 30);
      assert.equal(results[0].totalScanCount, 30);
      assert.equal(results[0].unmatchedScanCount, 30);
    });
    await t.test("first import links prior scans and retains unmatched evidence", async () => {
      const result = await importRows([row("A1"), row("C3", { Status: "Stored" }), row("A1")]);
      assert.equal(result.insertedCount, 2); assert.equal(result.duplicateCount, 1);
      const a = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } });
      assert.ok(a.verifiedAt); assert.ok(a.lastScannedAt); assert.equal(a.lastScanWaveName, wave.name);
      const unknown = await getInventoryAudit(parseAuditFilters(new URLSearchParams({ view: "unmatched" })));
      assert.equal(unknown.total, 2); assert.ok(unknown.scans.some((scan) => scan.lpn === null));
    });
    let oldA: Awaited<ReturnType<typeof prisma.inventoryAuditItem.findUniqueOrThrow>>;
    await t.test("unchanged imports leave every inventory field and archive state untouched; missing rows are retained", async () => {
      const a = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } });
      await archiveAuditItems([a.id], true);
      oldA = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: a.id } });
      const result = await importRows([row("a1")]);
      assert.equal(result.unchangedCount, 1);
      assert.deepEqual(await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { id: a.id } }), oldA);
      assert.equal(await prisma.inventoryAuditItem.count(), 2);
    });
    await t.test("any source column change restores an archived row and requires fresh scan evidence", async () => {
      const result = await importRows([row("A1", { Location: "B7" })]);
      assert.equal(result.changedCount, 1);
      const a = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } });
      assert.equal(a.archivedAt, null); assert.equal(a.verifiedAt, null); assert.equal(a.revision, 2);
      assert.equal(a.firstSeenAt.getTime(), oldA.firstSeenAt.getTime());
      assert.equal(a.lastScannedAt?.getTime(), oldA.lastScannedAt?.getTime());
      assert.equal((await exportPickWaveToAudit(wave.id)).newScanCount, 0);
      assert.equal((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } })).verifiedAt, null);
      await prisma.pickWaveScan.create({ data: { pickWaveId: wave.id, itemId: item.id, scannedValue: "SERIAL-A", matched: true, createdAt: oldA.firstSeenAt } });
      await exportPickWaveToAudit(wave.id);
      assert.equal((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } })).verifiedAt, null, "Old scans do not verify changed inventory.");
      await prisma.pickWaveScan.create({ data: { pickWaveId: wave.id, itemId: item.id, scannedValue: "SERIAL-A", matched: true, createdAt: new Date(a.sourceChangedAt.getTime() + 1) } });
      assert.equal((await exportPickWaveToAudit(wave.id)).newScanCount, 1);
      assert.ok((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "A1" } })).verifiedAt);
    });
    await t.test("late reports match earlier unknown LPNs, and deleting the source wave preserves scan evidence", async () => {
      await importRows([row("B2")]);
      assert.ok((await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: "B2" } })).verifiedAt);
      assert.equal((await getInventoryAudit(parseAuditFilters(new URLSearchParams({ view: "unmatched" })))).total, 1);
      await prisma.pickWave.delete({ where: { id: wave.id } });
      assert.equal(await prisma.inventoryAuditScan.count(), 32);
    });
    await t.test("large reports use bulk imports and pagination, with repeat imports preserving state", async () => {
      const rows = Array.from({ length: 2101 }, (_, index) => row(`BULK-${String(index).padStart(5, "0")}`));
      assert.equal((await importRows(rows)).insertedCount, 2101);
      assert.equal((await importRows(rows)).unchangedCount, 2101);
      const page1 = await getInventoryAudit(parseAuditFilters(new URLSearchParams({ search: "BULK-", page: "1" })));
      const page2 = await getInventoryAudit(parseAuditFilters(new URLSearchParams({ search: "BULK-", page: "2" })));
      assert.equal(page1.total, 2101); assert.equal(page1.items.length, 100); assert.equal(page1.pageCount, 22);
      assert.ok(page2.items.every((item) => !page1.items.some((other) => other.id === item.id)));
      assert.equal((await getInventoryAudit(parseAuditFilters(new URLSearchParams({ page: "99999" })))).page, 22);
    });
    await t.test("conflicting reports save no partial rows", async () => {
      const before = await prisma.inventoryAuditItem.count();
      await assert.rejects(importRows([row("NEW"), row("NEW", { Status: "Other" })]), /conflicting rows/);
      assert.equal(await prisma.inventoryAuditItem.count(), before);
    });
  } finally { await prisma.$disconnect(); }
});
