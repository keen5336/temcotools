import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { normalizeRouteMappings, normalizeStagingLocation } from "../lib/pick-wave-validation";

test("location names are normalized and reject empty, oversized and unsafe label values", () => {
  assert.equal(normalizeStagingLocation("  8-e  "), "8-E");
  assert.equal(normalizeStagingLocation(" loading   bay_1 "), "LOADING BAY_1");
  for (const value of [null, {}, "", "  ", "A".repeat(33), "8-^XZ", "<script>"]) {
    assert.throws(() => normalizeStagingLocation(value));
  }
});

test("route validation uses configured locations and retains only an existing route's removed choice", () => {
  const mapping = (routeNumber: string, stagingLocation: string | null) => ({ routeNumber, stagingLocation });
  assert.deepEqual(normalizeRouteMappings([mapping("R1", "7-E"), mapping("R2", null)], ["7-E"]), [mapping("R1", "7-E"), mapping("R2", null)]);
  assert.throws(() => normalizeRouteMappings([mapping("R1", "9-A")], ["7-E"]), /no longer an available/);
  assert.throws(() => normalizeRouteMappings([mapping("R1", "7-E"), mapping("R2", "7-E")], ["7-E"]), /assigned more than once/);
  assert.throws(() => normalizeRouteMappings([mapping("R1", null), mapping("r1", null)], []), /assigned more than once/);
  const existing = [mapping("R1", "9-A")];
  assert.deepEqual(normalizeRouteMappings([mapping("r1", "9-A")], [], existing), [mapping("r1", "9-A")]);
  assert.throws(() => normalizeRouteMappings([mapping("R2", "9-A")], [], existing), /no longer an available/);
  assert.deepEqual(normalizeRouteMappings([mapping("R1", null)], [], existing), [mapping("R1", null)]);
});

const database = process.env.PICK_WAVE_TEST_DATABASE_URL;
test("PostgreSQL locations persist across import, removal, route edits and scans", { skip: !database }, async () => {
  const target = new URL(database!);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "55474");
  assert.equal(target.pathname, "/pick_wave_qa");
  process.env.DATABASE_URL = database;
  const { prisma } = await import("../lib/db");
  const { addPickWaveLocation, listPickWaveLocations, removePickWaveLocation } = await import("../lib/pick-wave-locations");
  const { createPickWave, replacePickWaveRoutes, scanPickWave } = await import("../lib/pick-waves");
  try {
    const initial = await listPickWaveLocations();
    assert.equal(initial.length, 34);
    for (let n = 7; n <= 14; n++) for (const letter of n < 9 ? ["A", "B", "C", "D", "E"] : ["A", "B", "C", "D"]) assert.ok(initial.includes(`${n}-${letter}`));
    assert.deepEqual(initial.slice(0, 6), ["7-A", "7-B", "7-C", "7-D", "7-E", "8-A"]);
    await addPickWaveLocation(" 6-f "); await addPickWaveLocation("6-F");
    assert.equal((await listPickWaveLocations()).filter((name) => name === "6-F").length, 1);
    const userId = "pick-wave-qa-user";
    await prisma.user.create({ data: { id: userId, username: userId, displayName: "QA", pinHash: "synthetic-unused" } });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pick");
    sheet.addRow(["Route", "LPN"]); sheet.addRow(["R1", "LPN-1"]); sheet.addRow(["R2", "LPN-2"]);
    const fileBuffer = await workbook.xlsx.writeBuffer();
    const options = { name: "Location QA", filename: "synthetic.xlsx", fileBuffer, userId, routeMappings: [{ routeNumber: "R1", stagingLocation: "6-F" }, { routeNumber: "R2", stagingLocation: "8-E" }] };
    const wave = await createPickWave(options);
    await removePickWaveLocation("6-f");
    assert.ok(!(await listPickWaveLocations()).includes("6-F"));
    await replacePickWaveRoutes(wave.id, options.routeMappings);
    assert.equal((await scanPickWave({ id: wave.id, scannedValue: "LPN-1", userId })).stagingLocation, "6-F");
    await assert.rejects(createPickWave(options), /no longer an available/);
    await assert.rejects(replacePickWaveRoutes(wave.id, [{ routeNumber: "R1", stagingLocation: null }, { routeNumber: "R2", stagingLocation: "6-F" }]), /no longer an available/);
    await replacePickWaveRoutes(wave.id, [{ routeNumber: "R1", stagingLocation: "7-E" }, { routeNumber: "R2", stagingLocation: "8-E" }]);
    assert.equal((await scanPickWave({ id: wave.id, scannedValue: "LPN-1", userId })).stagingLocation, "7-E");
    for (const name of await listPickWaveLocations()) await removePickWaveLocation(name);
    assert.deepEqual(await listPickWaveLocations(), []);
    assert.deepEqual(await listPickWaveLocations(), [], "reads never reseed an intentionally empty list");
    const noLocations = await createPickWave({ ...options, routeMappings: [{ routeNumber: "R1", stagingLocation: null }, { routeNumber: "R2", stagingLocation: null }] });
    assert.ok(noLocations.id);
    await prisma.pickWave.deleteMany(); await prisma.user.delete({ where: { id: userId } });
    await prisma.pickWaveStagingLocation.createMany({ data: initial.map((name) => ({ name })) });
  } finally { await prisma.$disconnect(); }
});
