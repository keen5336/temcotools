import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { withPrincipalSite } from "../lib/sites/context";
import { businessDay } from "../lib/office/domain";
import { PICK_WAVE_STAGING_LOCATIONS } from "../lib/pick-wave-constants";

const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("retained warehouse workflow uses current site authority and canonical identity through pick, finals and Office", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.protocol, "postgresql:"); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test"); assert.equal(target.search, "");
  process.env.DATABASE_URL = url; delete process.env.TEMCO_PILOT_MODE;
  const [{ prisma }, application, dispatch, warehouse, reports, office] = await Promise.all([import("../lib/db"), import("../lib/application/actions"), import("../lib/dispatch/service"), import("../lib/warehouse/units"), import("../lib/warehouse/reports"), import("../lib/office/service")]);
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID(), base = Date.now() - 120_000, stamp = (offset: number) => new Date(base + offset).toISOString(), op = () => randomUUID();
  const [site, other] = await Promise.all(["source", "foreign"].map(name => owner.warehouseSite.create({ data: { slug: `retained-${ns}-${name}`, name: `Synthetic retained ${name}` } })));
  const people = await Promise.all(["lead", "floor", "foreign"].map((name, index) => owner.user.create({ data: { username: `retained-${ns}-${name}`, displayName: `Synthetic retained ${name}`, role: "admin", isPlatformAdmin: false, pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin", siteMemberships: { create: { siteId: index === 2 ? other.id : site.id, roles: { create: { roleId: index === 1 ? "warehouse-operator" : "warehouse-manager" } } } } } })));
  const sessions = await Promise.all(people.map((person, index) => owner.userSession.create({ data: { id: randomUUID(), userId: person.id, authVersion: person.authVersion, activeSiteId: index === 2 ? other.id : site.id, expiresAt: new Date(Date.now() + 3600_000), deviceLabel: "Synthetic retained scanner", mfaVerifiedAt: index === 1 ? null : new Date() } })));
  const actors = await Promise.all(people.map(async (person, index) => { const session = sessions[index], p = await resolvePrincipal({ userId: person.id, authVersion: person.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), index === 2 ? other.id : site.id); assert.ok(p); return { ...p, sessionId: session.id }; }));
  const [lead, floor, foreign] = actors, as = <T>(p: Principal, fn: () => T) => withPrincipalSite(p, fn);
  function call<K extends keyof typeof application.applicationActions>(p: Principal, name: K, input: unknown) { return application.executeApplicationAction(p, name, input) as Promise<Awaited<ReturnType<(typeof application.applicationActions)[K]["run"]>>>; }
  const [laneA, laneB, laneNext, missingLane] = PICK_WAVE_STAGING_LOCATIONS, order = `SYNTHETIC-SHARED-${ns}`, lpns = ["A", "B", "UNALLOCATED"].map(name => `SYNTHETIC-RETAINED-${ns}-${name}`.toUpperCase());
  const unitIds: string[] = []; let snapshotId = "", boardId = "", finalsId = "", waveId = "", signedId = "", signedHash = "", exchangeId = "", watchedCaseId = "";
  const lines = () => [{ lineKey: "original", quantity: 1, lane: laneA, route: "SYNTHETIC-A", orderReference: order, expectedUnits: [{ identifiers: [{ kind: "lpn", namespace: "wms", value: lpns[0] }] }] }, { lineKey: "replacement", quantity: 1, lane: laneB, route: "SYNTHETIC-B", orderReference: order, expectedUnits: [{ identifiers: [{ kind: "lpn", namespace: "wms", value: lpns[1] }] }] }, { lineKey: "order-context-only", quantity: 1, lane: missingLane, route: "SYNTHETIC-MISSING", orderReference: order, expectedUnits: [] }];
  const capture = (rawIdentifier: string, offset: number, type: "presence" | "check_in" | "departure" = "presence", pickWaveId?: string) => ({ eventId: op(), rawIdentifier, capturedAt: stamp(offset), capturedByUserId: floor.userId, type, captureMethod: "scanner", ...(pickWaveId ? { pickWaveId } : {}) });
  const finalsScan = (index: number, lane: string, offset: number, confirmPlacement = true) => call(floor, "finals.scan", { sessionId: finalsId, eventId: op(), rawIdentifier: lpns[index], lane, confirmPlacement, capturedAt: stamp(offset), capturedByUserId: floor.userId });
  try {
    await t.test("one shared WMS import keeps same-order A/B separate and creates exact native Pick Wave rows", async () => {
      const imported = await call(lead, "warehouse.import", { filename: "synthetic-retained.csv", sourceAsOf: stamp(0), coverage: "complete", rows: lpns.map((lpn, index) => ({ LPN: lpn, Status: "Received", "Order Number": index < 2 ? order : `SYNTHETIC-OTHER-${ns}`, Vendor: "Synthetic appliance", "Received Date": businessDay(new Date()), Description: `Synthetic physical appliance ${index}`, "Deliver to:": "SYNTHETIC", "Private source field": "PRIVATE-RETAINED-SOURCE" })) });
      assert.equal(imported.identityUnresolvedCount, 0); assert.equal(imported.rowCount, 3);
      const rows = await as(lead, () => prisma.inventoryAuditItem.findMany({ where: { lpn: { in: lpns } }, orderBy: { lpn: "asc" } }));
      for (const lpn of lpns) { const row = rows.find(row => row.lpn === lpn); assert.ok(row?.unitId); unitIds.push(row.unitId); }
      assert.equal(new Set(unitIds).size, 3); assert.notEqual(unitIds[0], unitIds[1]);
      const created = await call(lead, "dispatch.snapshot.create", { operationId: op(), day: businessDay(new Date()), scope: `synthetic-${ns}`, sourceKind: "manual_reviewed", sourceAsOf: stamp(100), sourceRef: "Synthetic manually reviewed requirements", coverage: "complete", note: "Synthetic manual demand; no DMP or official-finals qualification", lines: lines() }); snapshotId = created.snapshotId; boardId = created.boardId;
      await call(lead, "dispatch.snapshot.approve", { operationId: op(), snapshotId, expectedHeadId: null, evidence: "Synthetic complete manual demand reviewed" });
      const requirements = await call(lead, "dispatch.requirements", { snapshotId }); assert.equal(requirements.requirements.find(item => item.lineKey === "order-context-only")!.state, "missing");
      assert.deepEqual(requirements.requirements.find(item => item.lineKey === "original")!.candidateUnitIds, [unitIds[0]]);
      for (const lineKey of ["original", "replacement"]) await call(lead, "dispatch.allocate", { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify([lineKey, 1]), evidence: "Synthetic exact alias/quantity-one allocation" });
      await assert.rejects(call(lead, "dispatch.allocate", { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["order-context-only", 1]), evidence: "An order cannot select all appliances" }), /Resolve/);
      const wave = await call(lead, "dispatch.pick-wave", { operationId: op(), snapshotId, expectedHeadId: snapshotId }); assert.equal(wave.missingSlots, 1); assert.equal(wave.allocated, 2); assert.match(wave.sourceNotice, /not an official DMP finals source/); waveId = wave.waveIds[0];
      const picks = await as(lead, () => prisma.pickWaveItem.findMany({ where: { pickWaveId: waveId }, orderBy: { rowNumber: "asc" } })); assert.deepEqual(picks.map(item => item.lpn).sort(), lpns.slice(0, 2).sort()); assert.ok(picks.every(item => item.orderNumber === order));
      finalsId = (await call(floor, "finals.create", { operationId: op(), snapshotId, expectedHeadId: snapshotId })).sessionId;
      const qualification = await call(floor, "dispatch.adapter", {}); assert.equal(qualification.officialFinalsQualified, false); assert.equal(qualification.qualifiedDmpAdapterEnabled, false);
    });
    await t.test("broad picking scans save global presence without fulfilling finals or order-only picks", async () => {
      const outside = await call(floor, "warehouse.scan", capture(lpns[2], 1000, "presence", waveId)); assert.equal(outside.resolution, "resolved"); assert.equal(outside.unitId, unitIds[2]); assert.ok("task" in outside && !outside.task.matched);
      const orderScan = await call(floor, "warehouse.scan", capture(order, 2000, "presence", waveId)); assert.ok("task" in orderScan && !orderScan.task.matched);
      const input = capture(lpns[0], 3000, "presence", waveId), scanned = await call(floor, "warehouse.scan", input); assert.ok("task" in scanned && scanned.task.matched); assert.ok("stagingLocation" in scanned.task); assert.equal(scanned.task.stagingLocation, laneA);
      const replay = await call(floor, "warehouse.scan", input); assert.equal(replay.replayed, true);
      assert.equal(await as(lead, () => prisma.warehousePhysicalObservation.count({ where: { userId: floor.userId, eventId: input.eventId } })), 1);
      await call(floor, "warehouse.scan", capture(lpns[1], 4000, "presence", waveId));
      assert.equal(await as(lead, () => prisma.pickWaveItem.count({ where: { pickWaveId: waveId, scannedAt: { not: null } } })), 2);
      const view = await call(floor, "finals.get", { sessionId: finalsId }); assert.equal(view.lanes.find(item => item.lane === laneA)!.confirmedCount, 0); assert.equal(view.lanes.find(item => item.lane === laneB)!.confirmedCount, 0);
    });
    await t.test("wrong lane, explicit destination confirmation and signed demand amendments preserve original evidence", async () => {
      const wrong = await finalsScan(0, laneB, 5000); assert.equal(wrong.outcome, "wrong_lane"); assert.equal(wrong.scan.actualLane, laneB); assert.equal(wrong.expectedLane, laneA); assert.match(wrong.actionMessage, /WRONG LANE/);
      assert.equal((await finalsScan(0, laneA, 6000, false)).outcome, "placement_confirmation_required");
      assert.equal((await finalsScan(0, laneA, 7000)).outcome, "confirmed"); assert.equal((await finalsScan(0, laneA, 8000)).outcome, "duplicate"); assert.equal((await finalsScan(1, laneB, 9000)).outcome, "confirmed");
      const view = await call(lead, "finals.get", { sessionId: finalsId });
      const signed = await call(lead, "finals.signoff", { operationId: op(), sessionId: finalsId, lane: laneA, expectedSessionRevision: view.revision, evidence: "Synthetic exact physical lane inspected" }); signedId = signed.signoff.id; signedHash = signed.signoff.payloadHash; assert.match(JSON.stringify(signed.signoff.payload), /not an official DMP finals source/);
      const changedLines = lines().slice(0, 2).map((line, index) => index ? { ...line, lane: laneNext } : line);
      const changed = await call(lead, "dispatch.snapshot.create", { operationId: op(), day: businessDay(new Date()), scope: `synthetic-${ns}`, sourceKind: "manual_reviewed", sourceAsOf: stamp(10_000), sourceRef: "Synthetic amended manual requirements", coverage: "complete", note: "Synthetic replacement lane changes; original lane remains", lines: changedLines });
      const accepted = await call(lead, "dispatch.snapshot.approve", { operationId: op(), snapshotId: changed.snapshotId, expectedHeadId: snapshotId, evidence: "Synthetic complete amendment reviewed" }); snapshotId = changed.snapshotId; const oldFinalsId = finalsId; finalsId = accepted.finalsSessionId;
      const amended = await call(lead, "finals.get", { sessionId: finalsId }); assert.equal(amended.lanes.find(item => item.lane === laneA)!.confirmedCount, 1); assert.ok(amended.lanes.find(item => item.lane === laneA)!.carriedSignoff); assert.equal(amended.lanes.find(item => item.lane === laneNext)!.confirmedCount, 0); assert.ok(amended.lanes.find(item => item.lane === laneNext)!.needsRecheck);
      await assert.rejects(call(lead, "finals.signoff", { operationId: op(), sessionId: oldFinalsId, lane: laneA, expectedSessionRevision: view.revision + 1, evidence: "Stale demand cannot receive fresh signoff" }), /changed/);
      await call(lead, "dispatch.allocate", { operationId: op(), snapshotId, expectedHeadId: snapshotId, slotKey: JSON.stringify(["replacement", 1]), evidence: "Synthetic changed destination explicitly reallocated" }); assert.equal((await finalsScan(1, laneNext, 11_000)).outcome, "confirmed");
      const preserved = await as(lead, () => prisma.dispatchLaneSignoff.findUniqueOrThrow({ where: { id: signedId } })); assert.equal(preserved.payloadHash, signedHash); assert.equal(preserved.snapshotId, signed.signoff.snapshotId);
    });
    await t.test("missed exchange defers original A, expects B back and creates one durable replacement watch after check-in", async () => {
      await call(floor, "warehouse.scan", capture(lpns[0], 12_000, "departure")); await call(floor, "warehouse.scan", capture(lpns[1], 13_000, "departure"));
      const exchange = await call(lead, "office.exchange.create", { operationId: op(), originalUnitId: unitIds[0], replacementUnitId: unitIds[1], orderReference: order, evidence: "Synthetic original A at customer; B delivered only if exchange succeeds" }); exchangeId = exchange.exchange.id;
      await call(lead, "office.attempt.record", { operationId: op(), exchangeId, outcome: "missed", occurredAt: stamp(14_000), sourceAsOf: stamp(15_000), expectedBackAt: stamp(16_000), evidence: "Synthetic customer not home; no exchange occurred" });
      let work = await call(lead, "office.returns", { unitIds: unitIds.slice(0, 2) }); assert.ok(work.items.some(item => item.unitId === unitIds[1] && item.kind === "expected_return_not_checked_in")); assert.equal(work.items.some(item => item.unitId === unitIds[0] && item.kind === "expected_return_not_checked_in"), false);
      const schedule = { unitId: unitIds[1], deliveryDate: businessDay(new Date(Date.now() - 86_400_000)), nextDeliveryDate: null, complete: true, sourceAsOf: new Date().toISOString(), sourceRef: "Synthetic manually reviewed complete schedule", evidence: "Manual source qualification only; replacement has no new date" };
      await call(lead, "office.schedule.record", { ...schedule, operationId: op() }); assert.equal((await call(lead, "office.cases", { unitId: unitIds[1] })).cases.some(item => item.reason === "replacement_awaiting_reschedule"), false);
      await call(floor, "warehouse.scan", capture(lpns[1], 17_000, "check_in")); await call(lead, "office.evaluate", { unitIds: unitIds.slice(0, 2) });
      const cases = await call(lead, "office.cases", { unitId: unitIds[1], status: "all" }), issue = cases.cases.find(item => item.reason === "replacement_awaiting_reschedule"); assert.ok(issue); watchedCaseId = issue.id;
      await call(lead, "office.case.manage", { operationId: op(), caseId: issue.id, expectedRevision: issue.revision, action: "watch", reason: "Synthetic office is arranging replacement reschedule", responsibleUserId: lead.userId, nextAction: "Keep B for reschedule; A still awaits a successful future exchange", reviewTrigger: "conflict_only" });
      await call(lead, "office.evaluate", { unitIds: unitIds.slice(0, 2) }); const same = await call(lead, "office.cases", { unitId: unitIds[1], status: "all" }); assert.equal(same.cases.filter(item => item.reason === "replacement_awaiting_reschedule").length, 1); assert.equal((await call(lead, "office.case", { caseId: watchedCaseId })).status, "watching");
      const original = await call(lead, "office.unit", { unitId: unitIds[0] }); assert.equal(original.expectations.find(item => item.exchangeId === exchangeId)!.status, "deferred"); assert.equal(original.exchanges[0].attempts[0].outcome, "missed"); assert.match(original.sourceQualification, /not a qualified live DMP/);
      await call(lead, "office.schedule.record", { ...schedule, operationId: op(), nextDeliveryDate: businessDay(new Date(Date.now() + 86_400_000)), sourceAsOf: new Date(Date.now() + 10).toISOString() }); assert.equal((await call(lead, "office.case", { caseId: watchedCaseId })).status, "resolved");
      work = await call(lead, "office.returns", { unitIds: unitIds.slice(0, 2) }); assert.equal(work.items.some(item => item.unitId === unitIds[1] && item.kind === "expected_return_not_checked_in"), false);
      await call(lead, "office.disposition.create", { operationId: op(), unitId: unitIds[0], kind: "hold", reason: "Synthetic future original handling only", instruction: "Hold original A for reviewed office handling; not replacement B" }); const replacement = await call(floor, "warehouse.scan", capture(lpns[1], 18_000)); assert.ok("instructions" in replacement.office); assert.equal(replacement.office.instructions.some(item => item.action === "hold"), false);
      assert.equal(await as(lead, () => prisma.marsSubmissionIntent.count({ where: { unitId: { in: unitIds } } })), 0); assert.equal(await as(lead, () => prisma.labelIssuance.count({ where: { unitId: { in: unitIds } } })), 0);
    });
    await t.test("foreign warehouse, revoked membership and persisted read-only client grant cannot bypass shared commands", async () => {
      await assert.rejects(call(foreign, "dispatch.board", { boardId }), /not found/); await assert.rejects(call(foreign, "warehouse.unit", { unitId: unitIds[0] }), /not found/); assert.equal(await as(foreign, () => prisma.inventoryAuditItem.count({ where: { lpn: { in: lpns } } })), 0);
      await assert.rejects(call(foreign, "warehouse.unit.export", { unitId: unitIds[0] }), /not found/);
      const grant = await owner.appAccessGrant.create({ data: { siteId: site.id, userId: floor.userId, sessionId: floor.sessionId!, authVersion: floor.authVersion, clientName: "Synthetic retained read-only MCP fixture", tokenHash: op(), scopes: ["inventory.read", "workflow.read"], expiresAt: new Date(Date.now() + 3600_000) } }); const scoped = { ...floor, grantId: grant.id };
      const lookup = await call(scoped, "warehouse.resolve", { value: lpns[1], kind: "lpn" }) as Awaited<ReturnType<typeof warehouse.resolveWarehouseIdentifier>>; assert.equal(lookup.unitId, unitIds[1]); await assert.rejects(call(scoped, "warehouse.scan", capture(lpns[1], 19_000)), /permission/); assert.equal(await as(lead, () => prisma.warehousePhysicalObservation.count({ where: { userId: floor.userId, capturedAt: new Date(stamp(19_000)) } })), 0);
      await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: site.id, userId: floor.userId } }, data: { isActive: false } }); await assert.rejects(call(floor, "finals.get", { sessionId: finalsId }), /access|warehouse|permission/); await assert.rejects(call(scoped, "warehouse.resolve", { value: lpns[1] }), /access|warehouse|permission/);
      assert.equal((await as(lead, () => prisma.dispatchLaneSignoff.findUniqueOrThrow({ where: { id: signedId } }))).payloadHash, signedHash);
      assert.equal((await as(lead, () => reports.getWarehouseImportMembership(lead, { lpn: lpns[1] }))).membership, "included");
      assert.equal((await as(lead, () => warehouse.getWarehouseUnit(lead, { unitId: unitIds[0] }))).unitId, unitIds[0]); assert.equal((await as(lead, () => office.getOfficeUnitContext(lead, { unitId: unitIds[1] }))).exchanges[0].originalUnitId, unitIds[0]);
      assert.equal((await as(lead, () => dispatch.getDispatchAdapterStatus(lead))).officialFinalsQualified, false);
    });
  } finally { await owner.$disconnect(); await prisma.$disconnect(); }
});
