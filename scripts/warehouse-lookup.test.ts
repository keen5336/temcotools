import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesForRole, type Principal } from "../lib/auth/principal";
import { lookupWarehouseInventory, WarehouseLookupError, type WarehouseInventoryRow, type WarehouseLookupRepository, type WarehouseLookupSnapshot, type WarehouseScanRow } from "../lib/warehouse-lookup";

const principal: Principal = { userId: "warehouse-tester", username: "warehouse-tester", displayName: "Warehouse tester", role: "user", authVersion: 1, capabilities: capabilitiesForRole("user") };

function row(lpn: string, overrides: Partial<WarehouseInventoryRow> = {}): WarehouseInventoryRow {
  return { id: `row-${lpn}`, lpn, status: "Stored", orderNumber: "ORDER-DEMO-1", vendor: "Synthetic vendor", receivedDate: "2026-10-30", description: "Synthetic appliance", customerName: "Synthetic customer", sourceData: { lpn, status: "Stored", "order number": "ORDER-DEMO-1", "extra field": "Retain me" }, revision: 3, firstSeenAt: new Date("2026-10-29T08:00:00Z"), sourceChangedAt: new Date("2026-10-31T08:00:00Z"), verifiedAt: null, lastScannedAt: null, archivedAt: null, ...overrides };
}

function scan(overrides: Partial<WarehouseScanRow> = {}): WarehouseScanRow {
  return { id: "scan-evidence-1", sourceScanId: "original-scan-1", lpn: "00A1", scannedValue: "00a1", pickWaveId: "wave-demo", pickWaveName: "Synthetic wave", scannedByName: "Warehouse tester", matchedPickWave: false, duplicateInWave: false, scannedAt: new Date("2026-10-30T12:00:00Z"), exportedAt: new Date("2026-10-31T15:00:00Z"), ...overrides };
}

function repository(snapshot: Partial<WarehouseLookupSnapshot> = {}): WarehouseLookupRepository {
  return { read: async () => ({ rows: [], scans: [], scanCount: 0, latestImport: { id: "import-demo", filename: "synthetic.xlsx", createdAt: new Date("2026-10-31T08:00:00Z"), rowCount: 2 }, ...snapshot }) };
}

test("exact LPN lookup preserves identity text and separates historical WMS state from independent observation", async () => {
  const historical = row("00A1", { status: "Delivered", archivedAt: new Date("2026-10-31T09:00:00Z"), lastScannedAt: new Date("2026-10-31T11:00:00Z") });
  const observed = scan();
  let receivedInput: unknown;
  const result = await lookupWarehouseInventory(principal, { kind: "lpn", value: " 00a1 " }, { read: async (input) => { receivedInput = input; return { rows: [historical], scans: [observed], scanCount: 1, latestImport: null }; } });
  assert.deepEqual(receivedInput, { kind: "lpn", value: "00A1", limit: 20 });
  assert.equal(result.kind, "lpn");
  if (result.kind !== "lpn") throw new Error("Expected LPN lookup");
  assert.equal(result.record?.lpn, "00A1");
  assert.equal(result.record?.inventoryRecordId, historical.id);
  assert.equal(result.record?.reportedStatus, "Delivered");
  assert.deepEqual(result.record?.sourceData, historical.sourceData);
  assert.equal(result.record?.revision, 3);
  assert.equal(result.record?.archivedAt, historical.archivedAt!.toISOString());
  assert.equal(result.physicalPresence, "not_determined");
  assert.equal(result.sourceAsOf, null);
  assert.equal(result.latestReportMembership, "unknown");
  assert.equal(result.lastObservation?.capturedAt, observed.scannedAt.toISOString());
  assert.equal(result.lastObservation?.exportedAt, observed.exportedAt.toISOString());
  assert.notEqual(result.lastObservation?.capturedAt, result.record?.rowSummaryLastScannedAt);
  assert.equal(result.lastObservation?.identityBasis, "exact_lpn_scan");
  assert.equal(result.lastObservation?.sourceScanId, observed.sourceScanId);
});

test("an exact order lookup returns separate candidates without selecting or merging a physical unit", async () => {
  const result = await lookupWarehouseInventory(principal, { kind: "order", value: " ORDER-DEMO-1 ", limit: 1 }, repository({ rows: [row("UNIT-A"), row("UNIT-B")] }));
  assert.equal(result.kind, "order");
  if (result.kind !== "order") throw new Error("Expected order candidates");
  assert.equal(result.normalizedValue, "ORDER-DEMO-1");
  assert.equal(result.identityResolved, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lpn, "UNIT-A");
  assert.equal(result.hasMore, true);
  assert.equal(result.physicalPresence, "not_determined");
  assert.equal("record" in result, false);
  assert.equal(result.latestImport?.importedAt, "2026-10-31T08:00:00.000Z");
  assert.equal(result.sourceAsOf, null, "Import time must not become source-as-of time");
});

test("missing WMS rows retain independent evidence and non-LPN legacy matches remain explicitly weak", async () => {
  const result = await lookupWarehouseInventory(principal, { kind: "lpn", value: "00A1" }, repository({ scans: [scan({ scannedValue: "ORDER-DEMO-1", matchedPickWave: true, duplicateInWave: true })], scanCount: 27 }));
  assert.equal(result.kind, "lpn");
  if (result.kind !== "lpn") throw new Error("Expected LPN lookup");
  assert.equal(result.record, null);
  assert.equal(result.observationCount, 27);
  assert.equal(result.observationsTruncated, true);
  assert.equal(result.lastObservation?.identityBasis, "legacy_pick_match");
  assert.equal(result.lastObservation?.duplicateInWave, true);
  assert.equal(result.physicalPresence, "not_determined");
});

test("authorization runs before repository access or lookup validation", async () => {
  let read = false;
  await assert.rejects(lookupWarehouseInventory({ ...principal, capabilities: [] }, { kind: "lpn", value: "00A1" }, { read: async () => { read = true; throw new Error("Must not read data"); } }), /permission/);
  assert.equal(read, false);
});

test("invalid or oversized lookup inputs never reach storage", async () => {
  const noRead: WarehouseLookupRepository = { read: async () => { throw new Error("Invalid input reached storage"); } };
  for (const input of [null, [], {}, { kind: "serial", value: "DEMO" }, { kind: "lpn", value: " " }, { kind: "lpn", value: "a".repeat(501) }, { kind: "order", value: "DEMO", limit: 0 }, { kind: "order", value: "DEMO", limit: 51 }, { kind: "order", value: "DEMO", limit: 2.5 }, { kind: "order", value: "DEMO", limit: "10" }]) {
    await assert.rejects(lookupWarehouseInventory(principal, input, noRead), WarehouseLookupError);
  }
});
