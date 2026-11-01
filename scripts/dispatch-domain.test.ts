import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";

const testUrl = process.env.DISPATCH_TEST_DATABASE_URL;
test("manual dispatch exact-unit picking and lane verification retain physical facts and signed amendments", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!); assert.equal(url.protocol, "postgresql:"); assert.ok(["127.0.0.1", "localhost"].includes(url.hostname)); assert.equal(url.pathname, "/temcotools_v2_test"); assert.equal(url.search, "");
  process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db"); const service = await import("../lib/dispatch/service"); const warehouse = await import("../lib/warehouse/units");
  const prefix = `DISPATCH-${randomUUID()}`; const base = Date.now() - 60_000; const at = (n: number) => new Date(base + n).toISOString();
  const bundle = await prisma.roleBundle.create({ data: { name: prefix, capabilities: [...CAPABILITIES] } });
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic dispatch lead", role: "admin", pinHash: "not-a-credential", roleBundles: { create: { bundleId: bundle.id } } } });
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic dispatch test", expiresAt: new Date(Date.now() + 3_600_000), mfaVerifiedAt: new Date() } });
  const actor: Principal = { userId: user.id, username: user.username, displayName: user.displayName, authVersion: user.authVersion, role: "admin", capabilities: [...CAPABILITIES], sessionId: session.id, strongAuthenticatedAt: Date.now(), mfaVerifiedAt: Date.now() };
  let count = 0; const op = () => `${prefix}-${++count}`; const unitIds: string[] = []; const waveIds: string[] = [];
  async function unit(suffix: string) { const created = await warehouse.createWarehouseUnit(actor, { operationId: op(), evidence: `Synthetic distinct appliance ${suffix}` }); unitIds.push(created.unitId); const lpn = `${prefix}-${suffix}`; await warehouse.linkWarehouseIdentifier(actor, { unitId: created.unitId, kind: "lpn", value: lpn, evidence: "Synthetic physical label identity reviewed." }); return { id: created.unitId, lpn }; }
  const a = await unit("A"), b = await unit("B"), c = await unit("C"), d = await unit("D");
  const line = (key: string, lane: string, id?: string) => ({ lineKey: key, quantity: 1, lane, route: `route-${lane}`, orderReference: "SAME-ORDER", expectedUnits: id ? [{ unitId: id }] : [] });
  async function draft(scope: string, lines: unknown[], asOf = at(0), coverage = "complete") { return service.createDispatchSnapshot(actor, { operationId: op(), day: "2026-11-02", scope: `${prefix}-${scope}`, sourceKind: "manual_reviewed", sourceAsOf: asOf, sourceRef: "Synthetic reviewed dispatch requirements", coverage, note: "Synthetic test demand; not an upstream DMP report.", lines }); }
  async function scan(sessionId: string, lane: string, target: { lpn: string }, offset: number, confirmPlacement = true) { return service.recordFinalsScan(actor, { sessionId, eventId: op(), lane, rawIdentifier: target.lpn, confirmPlacement, capturedAt: at(offset), capturedByUserId: user.id }); }
  let snapshotId = "", finalsId = "", boardId = "", signedId = "", signedHash = "";
  try {
    await t.test("A6 order context never selects all units; quantity slots and reservations are exact", async () => {
      const created = await draft("main", [line("one", "X", a.id), line("two", "Z", b.id), line("order-only", "Q")]); snapshotId = created.snapshotId; boardId = created.boardId;
      await service.approveDispatchSnapshot(actor, { operationId: op(), snapshotId, expectedHeadId: null, evidence: "Synthetic complete manual scope approved." });
      const requirements = await service.reconcileDispatchRequirements(actor, { snapshotId });
      assert.equal(requirements.requirements.find((item) => item.lineKey === "order-only")?.state, "missing");
      assert.equal(requirements.requirements.find((item) => item.lineKey === "one")?.state, "ready");
      await service.allocateDispatchUnit(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["one", 1]), evidence: "Synthetic exact physical match reviewed." });
      await service.allocateDispatchUnit(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["two", 1]), evidence: "Synthetic exact physical match reviewed." });
      await assert.rejects(service.allocateDispatchUnit(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["order-only", 1]), evidence: "Synthetic order-only attempt must fail." }), /Resolve/);
      const other = await draft("other", [line("one", "Y", a.id)]); await service.approveDispatchSnapshot(actor, { operationId: op(), snapshotId: other.snapshotId, expectedHeadId: null, evidence: "Synthetic other dispatch manual scope." });
      await assert.rejects(service.allocateDispatchUnit(actor, { operationId: op(), snapshotId: other.snapshotId, expectedHeadId: other.snapshotId, slotKey: JSON.stringify(["one", 1]), unitId: a.id, evidence: "Synthetic duplicate physical allocation." }), /reserved/);
      const wave = await service.generateDispatchPickWave(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId }); waveIds.push(...wave.waveIds);
      assert.equal(wave.missingSlots, 1); assert.equal(await prisma.pickWaveItem.count({ where: { pickWaveId: wave.waveIds[0] } }), 2);
      await warehouse.linkWarehouseIdentifier(actor, { unitId: a.id, kind: "msn", value: `${prefix}-MSN-A`, evidence: "Synthetic distinct MSN reviewed for A." });
      const exact = await prisma.$transaction((tx) => service.resolveDispatchPickItemInTransaction(tx, { pickWaveId: wave.waveIds[0], rawIdentifier: `${prefix}-MSN-A` })); assert.ok(exact.itemId); assert.equal(exact.unitId, a.id);
      const order = await prisma.$transaction((tx) => service.resolveDispatchPickItemInTransaction(tx, { pickWaveId: wave.waveIds[0], rawIdentifier: "SAME-ORDER" })); assert.equal(order.boundWave, true); assert.equal(order.itemId, null);
      finalsId = (await service.createFinalsSession(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId })).sessionId;
    });
    await t.test("A8 wrong-lane observation retains actual Y; X requires a new destination confirmation; duplicates count once", async () => {
      const wrong = await scan(finalsId, "Z", a, 1000); assert.equal(wrong.outcome, "wrong_lane"); assert.equal(wrong.expectedLane, "X"); assert.equal(wrong.scan.actualLane, "Z"); assert.match(wrong.actionMessage, /WRONG LANE.*MOVE TO LANE X/);
      assert.equal(await prisma.dispatchFinalsCredit.count({ where: { sessionId: finalsId, unitId: a.id, status: "confirmed" } }), 0);
      assert.equal((await scan(finalsId, "X", a, 2000, false)).outcome, "placement_confirmation_required");
      const input = { sessionId: finalsId, eventId: op(), lane: "X", rawIdentifier: a.lpn, confirmPlacement: true, capturedAt: at(3000), capturedByUserId: user.id };
      const results = await Promise.all([service.recordFinalsScan(actor, input), service.recordFinalsScan(actor, input)]); assert.equal(results.filter((result) => result.replayed).length, 1);
      assert.equal((await scan(finalsId, "X", a, 4000)).outcome, "duplicate"); assert.equal(await prisma.dispatchFinalsCredit.count({ where: { sessionId: finalsId, unitId: a.id, status: "confirmed" } }), 1);
      assert.equal((await prisma.dispatchFinalsScan.findUniqueOrThrow({ where: { id: wrong.scan.id } })).reviewStatus, "resolved");
      assert.equal((await scan(finalsId, "Z", b, 5000)).outcome, "confirmed");
      const unidentified = await scan(finalsId, "Z", { lpn: `${prefix}-UNKNOWN` }, 6000); assert.equal(unidentified.outcome, "unidentified"); assert.equal(unidentified.fulfilled, false);
      await warehouse.linkWarehouseIdentifier(actor, { unitId: c.id, kind: "serial", namespace: "synthetic-model", value: `${prefix}-AMBIG`, evidence: "Synthetic ambiguous serial evidence unit C." }); await warehouse.linkWarehouseIdentifier(actor, { unitId: d.id, kind: "serial", namespace: "synthetic-model", value: `${prefix}-AMBIG`, evidence: "Synthetic ambiguous serial evidence unit D." });
      assert.equal((await scan(finalsId, "Z", { lpn: `${prefix}-AMBIG` }, 7000)).outcome, "ambiguous");
      assert.equal((await scan(finalsId, "Z", c, 8000)).outcome, "unexpected");
      const view = await service.getFinalsSession(actor, { sessionId: finalsId }); assert.equal(view.lanes.find((item) => item.lane === "X")?.complete, true); assert.equal(view.lanes.find((item) => item.lane === "Z")?.openExceptions.length, 3);
    });
    await t.test("outside-scope lanes still identify globally; delayed wrong-lane capture needs a newer destination receipt", async () => {
      const outside = await scan(finalsId, "OUTSIDE", a, 2500); assert.equal(outside.outcome, "wrong_lane"); assert.equal(outside.expectedLane, "X");
      const current = await service.getFinalsSession(actor, { sessionId: finalsId }); assert.equal(current.lanes.find((item) => item.lane === "X")?.confirmedCount, 1, "Older physical capture cannot invalidate later X confirmation."); assert.ok(current.lanes.some((item) => item.lane === "OUTSIDE" && item.openExceptions.length === 1));
      const repeated = await scan(finalsId, "X", a, 8500); assert.equal(repeated.outcome, "duplicate"); assert.equal((await prisma.dispatchFinalsScan.findUniqueOrThrow({ where: { id: outside.scan.id } })).reviewStatus, "resolved");
    });
    await t.test("unidentified evidence can be resolved only after exact identity review and a new supported destination confirmation", async () => {
      const unknown = await prisma.dispatchFinalsScan.findFirstOrThrow({ where: { sessionId: finalsId, outcome: "unidentified" } });
      let view = await service.getFinalsSession(actor, { sessionId: finalsId }); await assert.rejects(service.reviewFinalsException(actor, { operationId: op(), scanId: unknown.id, expectedSessionRevision: view.revision, reason: "Synthetic review cannot invent a destination." }), /new exact destination/);
      await warehouse.linkWarehouseIdentifier(actor, { unitId: c.id, kind: "lpn", value: `${prefix}-UNKNOWN`, evidence: "Synthetic inspected label now explicitly links this previously unknown scan to C." });
      await service.allocateDispatchUnit(actor, { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["order-only", 1]), unitId: c.id, evidence: "Synthetic exact unit C decision; order match alone is not used." });
      await scan(finalsId, "Q", c, 9000); view = await service.getFinalsSession(actor, { sessionId: finalsId });
      const resolved = await service.reviewFinalsException(actor, { operationId: op(), scanId: unknown.id, expectedSessionRevision: view.revision, reason: "Synthetic inspected identity and new lane Q confirmation resolve original unknown capture." }); assert.equal(resolved.fulfillmentAdded, false); assert.equal(resolved.scan.reviewStatus, "resolved"); assert.equal(resolved.scan.unitId, null, "The original unresolved identity record must remain original evidence.");
    });
    await t.test("A9 immutable signatures capture manual source; source amendments target changed lanes and retain compatible evidence", async () => {
      const view = await service.getFinalsSession(actor, { sessionId: finalsId }); const signed = await service.signOffDispatchLane(actor, { operationId: op(), sessionId: finalsId, lane: "X", expectedSessionRevision: view.revision, evidence: "Synthetic actual lane X inspection complete." }); signedId = signed.signoff.id; signedHash = signed.signoff.payloadHash;
      assert.match(JSON.stringify(signed.signoff.payload), /not an official DMP finals source/);
      const changed = await draft("main", [line("one", "X", a.id), line("two", "Y", b.id)], at(10_000));
      const approved = await service.approveDispatchSnapshot(actor, { operationId: op(), snapshotId: changed.snapshotId, expectedHeadId: snapshotId, evidence: "Synthetic reviewed route Z moves to Y; order-only line removed." });
      await assert.rejects(service.signOffDispatchLane(actor, { operationId: op(), sessionId: finalsId, lane: "X", expectedSessionRevision: view.revision + 1, evidence: "Synthetic stale scope must not sign." }), /changed/);
      const next = await service.getFinalsSession(actor, { sessionId: approved.finalsSessionId });
      assert.equal(next.lanes.find((item) => item.lane === "X")?.confirmedCount, 1); assert.ok(next.lanes.find((item) => item.lane === "X")?.carriedSignoff); assert.equal(next.lanes.find((item) => item.lane === "X")?.needsRecheck, false);
      assert.equal(next.lanes.find((item) => item.lane === "Y")?.confirmedCount, 0); assert.ok(next.lanes.find((item) => item.lane === "Y")?.amendments.length);
      assert.equal((await prisma.dispatchLaneSignoff.findUniqueOrThrow({ where: { id: signedId } })).payloadHash, signedHash);
      const empty = await service.confirmDispatchLaneEmpty(actor, { operationId: op(), sessionId: approved.finalsSessionId, expectedHeadId: changed.snapshotId, lane: "Z", evidence: "Synthetic physical inspection confirms removed lane Z is empty." }); assert.equal(empty.destinationRequirementsFulfilled, false);
      assert.equal((await service.getFinalsSession(actor, { sessionId: approved.finalsSessionId })).lanes.find((item) => item.lane === "Y")?.confirmedCount, 0);
      await service.allocateDispatchUnit(actor, { operationId: op(), snapshotId: changed.snapshotId, expectedHeadId: changed.snapshotId, slotKey: JSON.stringify(["two", 1]), evidence: "Synthetic amended destination requires exact reallocation." });
      const destination = await scan(approved.finalsSessionId, "Y", b, 11_000); assert.equal(destination.outcome, "confirmed");
      snapshotId = changed.snapshotId; finalsId = approved.finalsSessionId;
    });
    await t.test("later independent movement invalidates proof; an old delayed confirmation cannot restore it", async () => {
      const moved = await warehouse.recordWarehouseObservation(actor, { eventId: op(), rawIdentifier: a.lpn, type: "departure", capturedAt: at(12_000), capturedByUserId: user.id });
      const beforeHook = await service.getFinalsSession(actor, { sessionId: finalsId }); assert.equal(beforeHook.lanes.find((item) => item.lane === "X")?.complete, false);
      await assert.rejects(service.signOffDispatchLane(actor, { operationId: op(), sessionId: finalsId, lane: "X", expectedSessionRevision: beforeHook.revision, evidence: "Synthetic stale physical proof must fail." }), /physical confirmations/);
      assert.deepEqual((await service.reviewDispatchObservation(actor, { observationId: moved.observation.observationId })).affectedSessionIds, [finalsId]);
      assert.equal((await scan(finalsId, "X", a, 11_500)).outcome, "stale_physical_confirmation");
      assert.equal((await scan(finalsId, "X", a, 13_000)).outcome, "confirmed");
      assert.equal((await prisma.dispatchLaneSignoff.findUniqueOrThrow({ where: { id: signedId } })).payloadHash, signedHash);
    });
    await t.test("current office instructions remain visible and block contradictory delivery sign-off", async () => {
      const disposition = await prisma.officeDisposition.create({ data: { unitId: b.id, kind: "hold", reason: "Synthetic exact-unit office hold.", instruction: "Do not dispatch synthetic B until office review completes.", decidedByUserId: user.id } });
      const view = await service.getFinalsSession(actor, { sessionId: finalsId }); const target = view.lanes.find((item) => item.lane === "Y")!; assert.equal(target.officeConflicts[0].id, disposition.id); assert.equal(target.needsRecheck, true);
      await assert.rejects(service.signOffDispatchLane(actor, { operationId: op(), sessionId: finalsId, lane: "Y", expectedSessionRevision: view.revision, evidence: "Synthetic delivery must respect exact office hold." }), /office hold/);
      await prisma.officeDisposition.delete({ where: { id: disposition.id } });
    });
    await t.test("partial/stale drafts cannot erase accepted scope and ordinary operator cannot allocate", async () => {
      const partial = await draft("main", [], at(20_000), "partial"); await assert.rejects(service.approveDispatchSnapshot(actor, { operationId: op(), snapshotId: partial.snapshotId, expectedHeadId: snapshotId, evidence: "Synthetic incomplete report cannot erase demand." }), /partial/);
      const stale = await draft("main", [], at(-1000)); await assert.rejects(service.approveDispatchSnapshot(actor, { operationId: op(), snapshotId: stale.snapshotId, expectedHeadId: snapshotId, evidence: "Synthetic old source must not replace demand." }), /older source/);
      assert.equal((await service.getDispatchBoard(actor, { boardId })).board.headSnapshotId, snapshotId);
      const restricted = { ...actor, capabilities: actor.capabilities.filter((cap) => cap !== "dispatch.allocate") }; await assert.rejects(service.generateDispatchPickWave(restricted, { operationId: op(), snapshotId, expectedHeadId: snapshotId }), /permission/i);
      await assert.rejects(service.createDispatchSnapshot(actor, { operationId: op(), day: "2026-11-02", scope: prefix, sourceKind: "qualified_dmp", sourceAsOf: at(0), sourceRef: "Synthetic false qualification", coverage: "complete", note: "Must reject caller qualification.", lines: [] }));
    });
    await t.test("workbook fallback reuses the existing parser and preserves missing identity instead of guessing MSN/order mappings", async () => {
      const ExcelJS = (await import("exceljs")).default; const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Synthetic dispatch");
      sheet.addRow(["Route", "Order Number", "LPN", "Serial Number", "Tracking Number", "Description"]); sheet.addRow(["R1", "SAME-ORDER", c.lpn, "", "", "Synthetic C"]); sheet.addRow(["R1", "SAME-ORDER", "", "UNNAMESPACED", "NOT-PROVEN-MSN", "Synthetic unresolved distinct unit"]);
      const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      const result = await service.createDispatchWorkbookSnapshot(actor, { operationId: op(), day: "2026-11-02", scope: `${prefix}-workbook`, sourceAsOf: at(0), sourceRef: "Synthetic reviewed workbook source", coverage: "complete", note: "Synthetic one reviewed unit per row; not official finals.", filename: "synthetic.xlsx", workbookBase64: bytes.toString("base64"), routeLanes: [{ route: "R1", lane: "W" }] });
      const requirements = await service.reconcileDispatchRequirements(actor, { snapshotId: result.snapshotId }); assert.equal(requirements.snapshot.sourceKind, "workbook_fallback"); assert.equal(requirements.requirements.length, 2); assert.equal(requirements.requirements[0].candidateUnitIds[0], c.id); assert.equal(requirements.requirements[1].state, "missing"); assert.equal((await service.getDispatchAdapterStatus(actor)).officialFinalsQualified, false);
    });
  } finally {
    const boards = await prisma.dispatchBoard.findMany({ where: { scope: { startsWith: prefix } }, select: { id: true } }); const ids = boards.map((item) => item.id);
    const snapshots = await prisma.dispatchSnapshot.findMany({ where: { boardId: { in: ids } }, select: { id: true } }); const snapshotIds = snapshots.map((item) => item.id);
    const sessions = await prisma.dispatchFinalsSession.findMany({ where: { boardId: { in: ids } }, select: { id: true } }); const sessionIds = sessions.map((item) => item.id);
    await prisma.dispatchFinalsCredit.deleteMany({ where: { sessionId: { in: sessionIds } } }); await prisma.dispatchAmendment.deleteMany({ where: { sessionId: { in: sessionIds } } }); await prisma.dispatchLaneSignoff.deleteMany({ where: { sessionId: { in: sessionIds } } }); await prisma.dispatchFinalsScan.deleteMany({ where: { sessionId: { in: sessionIds } } }); await prisma.dispatchFinalsSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.dispatchWaveItem.deleteMany({ where: { snapshotId: { in: snapshotIds } } }); await prisma.dispatchReservation.deleteMany({ where: { boardId: { in: ids } } }); await prisma.dispatchAllocation.deleteMany({ where: { snapshotId: { in: snapshotIds } } }); await prisma.dispatchBoard.updateMany({ where: { id: { in: ids } }, data: { headSnapshotId: null } }); await prisma.dispatchSnapshot.deleteMany({ where: { boardId: { in: ids } } }); await prisma.dispatchEvent.deleteMany({ where: { boardId: { in: ids } } }); await prisma.dispatchBoard.deleteMany({ where: { id: { in: ids } } }); await prisma.dispatchCommandReceipt.deleteMany({ where: { userId: user.id } });
    await prisma.pickWaveRouteMapping.deleteMany({ where: { pickWaveId: { in: waveIds } } }); await prisma.pickWaveItem.deleteMany({ where: { pickWaveId: { in: waveIds } } }); await prisma.pickWave.deleteMany({ where: { id: { in: waveIds } } });
    await prisma.officeDisposition.deleteMany({ where: { unitId: { in: unitIds }, decidedByUserId: user.id } }); await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: user.id } }); await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: unitIds } } }); await prisma.userSession.deleteMany({ where: { userId: user.id } }); await prisma.userRoleBundle.deleteMany({ where: { userId: user.id } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect();
  }
});
