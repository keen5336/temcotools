import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";
import { businessDay, fingerprint } from "../lib/office/domain";

const testUrl = process.env.OFFICE_TEST_DATABASE_URL;
test("native Office refresh covers all observed units with resumable receipts and honest freshness", { skip: !testUrl }, async t => {
  const target = new URL(testUrl!);
  assert.equal(target.protocol, "postgresql:"); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_test"); assert.equal(target.search, "");
  process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db");
  const office = await import("../lib/office/service");
  const refresh = await import("../lib/office/refresh");
  const { importSharedWarehouseReport } = await import("../lib/warehouse/reports");
  const { getOperationalDashboard } = await import("../lib/dashboard");
  const { executeApplicationAction } = await import("../lib/application/actions");
  const prefix = `z-refresh-${randomUUID()}`, now = new Date(), day = 86_400_000;
  const bundle = await prisma.roleBundle.create({ data: { name: prefix, capabilities: [...CAPABILITIES] } });
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic refresh operator", pinHash: "disabled:test", role: "admin", roleBundles: { create: { bundleId: bundle.id } } } });
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic refresh test", expiresAt: new Date(now.getTime() + 60 * 60_000), mfaVerifiedAt: now } });
  const principal: Principal = { userId: user.id, username: user.username, displayName: user.displayName, role: "admin", authVersion: user.authVersion, sessionId: session.id, capabilities: [...CAPABILITIES], strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
  const ids = Array.from({ length: 112 }, (_, index) => `${prefix}-${index.toString().padStart(3, "0")}`);
  const allIds = [...ids];
  const row = (receivedDate: string) => ({ LPN: `${prefix}-SOURCE`, Status: "Placing", "Order Number": `${prefix}-ORDER`, Vendor: "Synthetic", "Received Date": receivedDate, Description: "Synthetic appliance", "Deliver to:": "Synthetic fixture" });
  const accept = (receivedDate: string) => importSharedWarehouseReport(principal, { filename: "synthetic-refresh.xlsx", rows: [row(receivedDate)], scope: prefix, coverage: "partial", sourceAsOf: now.toISOString() });
  async function completePass(start?: Awaited<ReturnType<typeof refresh.advanceOfficeRefresh>>) {
    let result = start ?? await refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), cause: "manual", limit: 50 });
    let pages = 1;
    while (!result.receipt.complete) { assert.ok(pages++ < 40, "Finite test pass must terminate"); result = await refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), runId: result.status.checkpoint!.runId, expectedCheckpoint: result.status.checkpoint!.checkpoint, limit: 50 }); }
    return result;
  }
  async function fixtureObservation(unitId: string, type = "check_in") {
    return prisma.warehousePhysicalObservation.create({ data: { userId: user.id, unitId, eventId: randomUUID(), fingerprint: "synthetic", rawIdentifier: unitId, identifierType: "lpn", type, location: "SYNTHETIC WAREHOUSE", captureMethod: "manual", capturedAt: new Date(now.getTime() - 25 * day), resolution: "resolved", candidateUnitIds: [unitId] } });
  }
  try {
    await prisma.warehouseUnit.createMany({ data: ids.map(id => ({ id, creationEvidence: "Synthetic standalone physical unit; no upstream mapping." })) });
    for (const id of ids) await fixtureObservation(id);
    await t.test("the old bounded evaluation leaves real aging cases unprocessed; normal import starts a resumable all-unit pass", async () => {
      await office.evaluateOfficeWork(principal, { limit: 100 });
      assert.ok(await prisma.officeCase.count({ where: { unitId: { in: ids }, reason: "warehouse_over_20_days" } }) < ids.length);
      const before = await prisma.warehousePhysicalObservation.count({ where: { userId: user.id } });
      const batch = await accept(businessDay(now)); assert.ok(batch.officeRefresh); assert.equal(batch.officeRefreshError, null);
      const source = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: `${prefix}-SOURCE`.toUpperCase() } }); allIds.push(source.unitId!);
      assert.equal(batch.officeRefresh.coverage, "incomplete");
      const finished = await completePass(); assert.equal(finished.status.coverage, "fresh", JSON.stringify({ reasons: finished.status.staleReasons, watermark: finished.receipt.watermark })); assert.ok(finished.receipt.processed >= 112);
      assert.equal(await prisma.officeCase.count({ where: { unitId: { in: ids }, reason: "warehouse_over_20_days" } }), ids.length);
      assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: user.id } }), before, "Evaluation never manufactures a physical scan.");
      assert.equal((await getOperationalDashboard(principal)).officeRefresh?.coverage, "fresh");
    });
    await t.test("lost acknowledgement retries preserve original page, cursor races fail and new input is visibly stale", async () => {
      const input = { operationId: randomUUID(), restart: true, limit: 7 };
      const first = await refresh.advanceOfficeRefresh(principal, input);
      const next = await refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), runId: first.receipt.runId, expectedCheckpoint: first.receipt.checkpoint, limit: 7 });
      const replay = await refresh.advanceOfficeRefresh(principal, input); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt); assert.equal(replay.status.checkpoint?.checkpoint, next.receipt.checkpoint);
      await assert.rejects(refresh.advanceOfficeRefresh(principal, { ...input, limit: 8 }), /already used/);
      await assert.rejects(refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), expectedCheckpoint: first.receipt.checkpoint }), /advanced/);
      const later = `${prefix}-zzz`; allIds.push(later); await prisma.warehouseUnit.create({ data: { id: later } }); await fixtureObservation(later);
      const finished = await completePass(next); assert.equal(finished.status.coverage, "stale"); assert.ok(finished.status.staleReasons.some(reason => reason.includes("facts changed")));
      assert.equal(await prisma.officeCase.count({ where: { unitId: later } }), 0, "Fixed upper bound excludes a later unit.");
      const caughtUp = await completePass(); assert.equal(caughtUp.status.coverage, "fresh"); assert.equal(await prisma.officeCase.count({ where: { unitId: later, reason: "warehouse_over_20_days" } }), 1);
    });
    await t.test("valid durable watches persist, elapsed conditional RTV needs a scan, and rollover/deadlines invalidate coverage", async () => {
      const issue = await prisma.officeCase.findFirstOrThrow({ where: { unitId: ids[0], reason: "warehouse_over_20_days" } });
      await office.manageOfficeCase(principal, { operationId: randomUUID(), caseId: issue.id, expectedRevision: issue.revision, action: "watch", reason: "Synthetic valid office watch", responsibleUserId: user.id, nextAction: "Wait for reviewed owner instruction", reviewTrigger: "conflict_only", reviewAt: new Date(now.getTime() - 1).toISOString() });
      const disposition = await office.createOfficeDisposition(principal, { operationId: randomUUID(), unitId: ids[0], kind: "conditional_rtv", reason: "Synthetic prior exact-unit authorization", instruction: "Only the next qualifying physical scan routes this unit", triggerAt: new Date(now.getTime() - day).toISOString(), expiresAt: new Date(now.getTime() + day).toISOString() });
      await completePass(); assert.equal((await office.getOfficeCase(principal, { caseId: issue.id })).status, "watching");
      assert.equal((await prisma.officeDisposition.findUniqueOrThrow({ where: { id: disposition.disposition.id } })).status, "active");
      assert.equal(await prisma.officeDispositionExecution.count({ where: { dispositionId: disposition.disposition.id } }), 0);
      const dashboard = await getOperationalDashboard(principal); const priorities = dashboard.widgets.find(widget => widget.id === "priorities")!;
      assert.ok(priorities.summary.startsWith(`${(await prisma.officeCase.count({ where: { status: "open" } }))} need review`), "Conflict-only watches with an old date are not due tasks.");
      const timed = await prisma.officeCase.findFirstOrThrow({ where: { unitId: ids[1], reason: "warehouse_over_20_days" } });
      await office.manageOfficeCase(principal, { operationId: randomUUID(), caseId: timed.id, expectedRevision: timed.revision, action: "watch", reason: "Synthetic explicitly timed review", responsibleUserId: user.id, nextAction: "Reevaluate when this review becomes due", reviewTrigger: "date_or_conflict", reviewAt: new Date(now.getTime() + 60_000).toISOString() });
      await completePass();
      const due = await prisma.$transaction(tx => refresh.getOfficeRefreshStatusInTransaction(tx, principal, new Date(now.getTime() + 120_000)));
      assert.equal(due.coverage, "stale"); assert.ok(due.staleReasons.some(reason => reason.includes("time was reached")));
      const future = await prisma.$transaction(tx => refresh.getOfficeRefreshStatusInTransaction(tx, principal, new Date(now.getTime() + 2 * day)));
      assert.equal(future.coverage, "stale"); assert.ok(future.staleReasons.some(reason => reason.includes("day changed")));
    });
    await t.test("changed WMS receipt date clears a weaker source-aging case without asserting physical departure", async () => {
      const oldDay = businessDay(new Date(now.getTime() - 35 * day)); const old = `${oldDay.slice(5, 7)}/${oldDay.slice(8, 10)}/${oldDay.slice(0, 4)}`; await accept(old);
      const source = await prisma.inventoryAuditItem.findUniqueOrThrow({ where: { lpn: `${prefix}-SOURCE`.toUpperCase() } });
      await fixtureObservation(source.unitId!, "presence");
      const changedDuringPass = await completePass(); assert.equal(changedDuringPass.status.coverage, "stale");
      await completePass();
      const warning = await prisma.officeCase.findFirstOrThrow({ where: { unitId: source.unitId!, reason: "aging_basis_review" } }); assert.notEqual(warning.status, "resolved");
      await accept(businessDay(now)); const covered = await completePass(); assert.equal(covered.status.coverage, "fresh");
      assert.equal((await office.getOfficeCase(principal, { caseId: warning.id })).status, "resolved");
      assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: user.id, type: "departure" } }), 0);
    });
    await t.test("explicit subsets page through native evaluate and return actions exactly once without changing global coverage", async () => {
      await prisma.officeReturnExpectation.createMany({ data: ids.map(unitId => ({ unitId, kind: "office_expected_return", status: "expected", condition: "none", activatedAt: new Date(now.getTime() - 2 * day), expectedAt: new Date(now.getTime() - day), evidence: "Synthetic later return obligation; the older warehouse check-in does not confirm this return.", sourceAsOf: now, sourceRef: "Synthetic explicit paging fixture", createdByUserId: user.id })) });
      const before = await refresh.getOfficeRefreshStatus(principal);
      const evaluateIds: string[] = [], returnIds: string[] = [];
      let afterUnitId: string | undefined;
      for (let page = 0; ; page++) {
        assert.ok(page < 4, "Explicit evaluation must finish rather than repeat page one");
        const result = await executeApplicationAction(principal, "office.evaluate", { unitIds: [...ids].reverse(), ...(afterUnitId ? { afterUnitId } : {}) }) as Awaited<ReturnType<typeof office.evaluateOfficeWork>>;
        evaluateIds.push(...result.evaluations.map(item => item.unitId));
        if (!result.hasMore) { assert.equal(result.nextAfterUnitId, null); break; }
        assert.ok(result.nextAfterUnitId); afterUnitId = result.nextAfterUnitId;
      }
      afterUnitId = undefined;
      for (let page = 0; ; page++) {
        assert.ok(page < 4, "Explicit returns must finish rather than repeat page one");
        const result = await executeApplicationAction(principal, "office.returns", { unitIds: [...ids].reverse(), ...(afterUnitId ? { afterUnitId } : {}) }) as Awaited<ReturnType<typeof office.getExpectedReturnWorklist>>;
        returnIds.push(...result.items.filter(item => item.kind === "expected_return_not_checked_in").map(item => item.unitId!));
        if (!result.hasMore) { assert.equal(result.nextAfterUnitId, null); break; }
        assert.ok(result.nextAfterUnitId); afterUnitId = result.nextAfterUnitId;
      }
      assert.deepEqual(evaluateIds, ids); assert.deepEqual(returnIds, ids);
      assert.equal(new Set(evaluateIds).size, 112); assert.equal(new Set(returnIds).size, 112);
      const after = await refresh.getOfficeRefreshStatus(principal);
      assert.deepEqual(after.checkpoint, before.checkpoint); assert.equal(after.coverage, before.coverage); assert.deepEqual(after.staleReasons, before.staleReasons);
    });
    await t.test("expiry reviews unfinished present RTV work, preserves completed departed/linked episodes and tracks executed expiry", async () => {
      async function rtvFixture(suffix: string, state: "executed" | "active", expiresAt: Date, conditional = false) {
        const unitId = `${prefix}-expiry-${suffix}`; allIds.push(unitId);
        await prisma.warehouseUnit.create({ data: { id: unitId, creationEvidence: "Synthetic historical RTV episode" } });
        const seen = await prisma.warehousePhysicalObservation.create({ data: { userId: user.id, unitId, eventId: randomUUID(), fingerprint: "synthetic", rawIdentifier: unitId, identifierType: "lpn", type: "placement", location: "SYNTHETIC RTV", captureMethod: "manual", capturedAt: new Date(now.getTime() - 3_600_000), resolution: "resolved", candidateUnitIds: [unitId] } });
        const disposition = await prisma.officeDisposition.create({ data: { unitId, kind: conditional ? "conditional_rtv" : "rtv", status: state, reason: "Synthetic exact-unit prior RTV authority", instruction: "Synthetic reviewed RTV work; no live submission", decidedByUserId: user.id, authorizedByUserId: user.id, authorizedAt: new Date(now.getTime() - 2 * day), triggerAt: conditional ? new Date(now.getTime() - day) : null, expiresAt, triggeredByObservationId: state === "executed" ? seen.id : null, triggeredAt: state === "executed" ? new Date(now.getTime() - 3_600_000) : null } });
        if (state === "executed") {
          await prisma.officeDispositionExecution.create({ data: { dispositionId: disposition.id, action: "rtv_placement_confirmed", observationId: seen.id, evidence: "Synthetic actual placement completion, separate from submission and departure", executedByUserId: user.id, executedAt: new Date(now.getTime() - 1_800_000) } });
          const ready = await prisma.officeCase.create({ data: { caseKey: fingerprint([unitId, "authorized_rtv_ready", disposition.id]), unitId, reason: "authorized_rtv_ready", episodeKey: disposition.id, status: "resolved", evidence: { qualifyingObservation: seen.id }, conditionSignature: fingerprint({ disposition: disposition.id }), nextAction: disposition.instruction, resolution: "Synthetic RTV placement physically confirmed; submission and departure remain separate", resolvedAt: new Date(now.getTime() - 1_800_000) } });
          return { unitId, seen, disposition, ready };
        }
        return { unitId, seen, disposition, ready: null };
      }
      const expiredAt = new Date(now.getTime() - 60_000);
      const pending = await rtvFixture("pending", "executed", expiredAt);
      const departed = await rtvFixture("departed", "executed", expiredAt);
      const linked = await rtvFixture("linked", "executed", expiredAt);
      const conditional = await rtvFixture("untriggered", "active", expiredAt, true);
      await prisma.warehousePhysicalObservation.create({ data: { userId: user.id, unitId: departed.unitId, eventId: randomUUID(), fingerprint: "synthetic", rawIdentifier: departed.unitId, identifierType: "lpn", type: "departure", location: "SYNTHETIC DOCK", captureMethod: "manual", capturedAt: new Date(now.getTime() - 600_000), resolution: "resolved", candidateUnitIds: [departed.unitId] } });
      await prisma.warehouseIdentifier.create({ data: { unitId: linked.unitId, kind: "submission", namespace: "mars", value: `${prefix}-EXISTING-SUBMISSION`, rawValue: `${prefix}-EXISTING-SUBMISSION`, evidence: "Synthetic explicit existing MARS submission identity link; no reported pickup/departure completion", createdByUserId: user.id } });
      const beforeObservations = await prisma.warehousePhysicalObservation.count({ where: { userId: user.id } });
      const subset = [pending.unitId, departed.unitId, linked.unitId, conditional.unitId];
      await office.evaluateOfficeWork(principal, { unitIds: subset });
      const current = await prisma.officeCase.findUniqueOrThrow({ where: { id: pending.ready!.id } });
      assert.equal(current.status, "open"); assert.match(current.nextAction!, /authorization expired/);
      assert.equal((await prisma.officeDisposition.findUniqueOrThrow({ where: { id: pending.disposition.id } })).status, "expired");
      for (const completed of [departed, linked]) {
        const ready = await prisma.officeCase.findUniqueOrThrow({ where: { id: completed.ready!.id } }); assert.equal(ready.status, "resolved"); assert.equal(ready.revision, 1);
        assert.equal(await prisma.officeCaseEvent.count({ where: { caseId: ready.id, action: "authorization_expired" } }), 0);
      }
      assert.equal(await prisma.officeCase.count({ where: { unitId: conditional.unitId, reason: "authorized_rtv_ready" } }), 0, "Expiry alone never qualifies a conditional RTV scan");
      assert.equal(await prisma.officeDispositionExecution.count({ where: { disposition: { unitId: { in: subset } } } }), 3, "Existing placement completions remain unchanged");
      await office.evaluateOfficeWork(principal, { unitIds: subset });
      assert.equal((await prisma.officeCase.findUniqueOrThrow({ where: { id: current.id } })).revision, current.revision);
      assert.equal(await prisma.warehousePhysicalObservation.count({ where: { userId: user.id } }), beforeObservations);
      const clockExpiry = new Date(Date.now() + 30_000), clock = await rtvFixture("clock", "executed", clockExpiry);
      const covered = await completePass(); assert.equal(covered.status.coverage, "fresh");
      assert.ok(Date.parse(covered.receipt.nextTimeBoundary!) <= clockExpiry.getTime(), "Executed-but-pending authority must contribute its expiry boundary");
      const future = new Date(clockExpiry.getTime() + 1);
      const due = await prisma.$transaction(tx => refresh.getOfficeRefreshStatusInTransaction(tx, principal, future));
      assert.equal(due.coverage, "stale"); assert.ok(due.staleReasons.some(reason => reason.includes("time was reached")));
      await prisma.$transaction(tx => office.evaluateOfficePageInTransaction(tx, principal, { unitIds: [clock.unitId] }, future));
      assert.equal((await prisma.officeCase.findUniqueOrThrow({ where: { id: clock.ready!.id } })).status, "open");
      assert.equal(await prisma.officeDispositionExecution.count({ where: { dispositionId: clock.disposition.id } }), 1);
    });
    await t.test("every page checks current authority and the signed-in actor; read-only coverage cannot mutate", async () => {
      await assert.rejects(refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), expectedActorUserId: "another-person" }), /signed-in person changed/);
      const readonly = { ...principal, capabilities: ["workflow.read"] as Principal["capabilities"] };
      assert.equal((await refresh.getOfficeRefreshStatus(readonly)).canRefresh, false);
      await assert.rejects(refresh.advanceOfficeRefresh(readonly, { operationId: randomUUID() }), /permission/);
      await prisma.roleBundle.update({ where: { id: bundle.id }, data: { capabilities: ["workflow.read"] } });
      assert.equal((await refresh.getOfficeRefreshStatus(principal)).canRefresh, false);
      await assert.rejects(refresh.advanceOfficeRefresh(principal, { operationId: randomUUID(), restart: true }), /permission/);
      await prisma.roleBundle.update({ where: { id: bundle.id }, data: { capabilities: [...CAPABILITIES] } });
      await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await assert.rejects(refresh.advanceOfficeRefresh(principal, { operationId: randomUUID() }));
    });
  } finally {
    await prisma.officeCaseEvent.deleteMany({ where: { case: { unitId: { in: allIds } } } });
    await prisma.officeDispositionExecution.deleteMany({ where: { disposition: { unitId: { in: allIds } } } });
    await prisma.officeDisposition.deleteMany({ where: { unitId: { in: allIds } } });
    await prisma.officeCase.deleteMany({ where: { unitId: { in: allIds } } });
    await prisma.officeReturnExpectation.deleteMany({ where: { unitId: { in: allIds } } });
    await prisma.officeCommandReceipt.deleteMany({ where: { userId: user.id } });
    await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: user.id } });
    await prisma.inventoryImportMembership.deleteMany({ where: { importBatch: { scope: prefix } } });
    await prisma.inventorySourceRevision.deleteMany({ where: { inventoryItem: { lpn: { startsWith: prefix.toUpperCase() } } } });
    await prisma.inventoryAuditItem.deleteMany({ where: { lpn: { startsWith: prefix.toUpperCase() } } });
    await prisma.inventoryAuditImport.deleteMany({ where: { scope: prefix } });
    await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: allIds } } });
    await prisma.warehouseUnit.deleteMany({ where: { id: { in: allIds } } });
    await prisma.user.delete({ where: { id: user.id } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect();
  }
});
