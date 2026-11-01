import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CAPABILITIES, type Principal } from "../lib/auth/principal";
import { businessDay } from "../lib/office/domain";

const testUrl = process.env.OFFICE_TEST_DATABASE_URL;
test("shared RTV guard rechecks exact prior authority, corrected physical proof and conditional schedule evidence", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!); assert.equal(url.protocol, "postgresql:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55439"); assert.equal(url.pathname, "/temcotools_v2_test"); assert.equal(url.search, ""); process.env.DATABASE_URL = testUrl;
  const { prisma } = await import("../lib/db"); const office = await import("../lib/office/service"); const warehouse = await import("../lib/warehouse/units");
  const prefix = `RTV-GUARD-${randomUUID()}`; const base = Date.now() - 120_000; const stamp = (offset: number) => new Date(base + offset).toISOString();
  const bundle = await prisma.roleBundle.create({ data: { name: prefix, capabilities: [...CAPABILITIES] } });
  const user = await prisma.user.create({ data: { username: prefix, displayName: "Synthetic RTV reviewer", role: "user", pinHash: "not-a-credential", roleBundles: { create: { bundleId: bundle.id } } } });
  const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, deviceLabel: "Synthetic RTV guard test", expiresAt: new Date(Date.now() + 3_600_000), mfaVerifiedAt: new Date() } });
  const actor: Principal = { userId: user.id, username: user.username, displayName: user.displayName, role: user.role, authVersion: user.authVersion, capabilities: [...CAPABILITIES], sessionId: session.id, strongAuthenticatedAt: Date.now(), mfaVerifiedAt: Date.now() };
  const units = [];
  for (let index = 0; index < 4; index++) { const unit = await prisma.warehouseUnit.create({ data: { createdByUserId: user.id } }); units.push(unit); await warehouse.linkWarehouseIdentifier(actor, { unitId: unit.id, kind: "lpn", value: `${prefix}-${index}`, evidence: "Synthetic exact appliance LPN identity." }); }
  const [a, b, c, d] = units; const unitIds = units.map((unit) => unit.id);
  const observed = (index: number, type: "presence" | "check_in" | "placement" | "departure", offset: number, location = "WAREHOUSE") => warehouse.recordWarehouseObservation(actor, { eventId: randomUUID(), rawIdentifier: `${prefix}-${index}`, capturedAt: stamp(offset), capturedByUserId: user.id, type, location });
  const authorization = (unitId: string, extra: object = {}) => prisma.officeDisposition.create({ data: { unitId, kind: "rtv", reason: "Synthetic prior exact-unit office RTV authority.", instruction: "Route this synthetic appliance through reviewed RTV.", decidedByUserId: user.id, authorizedByUserId: user.id, authorizedAt: new Date(base + 1000), expiresAt: new Date(Date.now() + 86_400_000), ...extra } });
  const check = (unitId: string, dispositionId: string) => prisma.$transaction((tx) => office.assertCurrentRtvAuthorization(tx, unitId, dispositionId));
  const rtv = await authorization(a.id); let conditionalId = "";
  try {
    await t.test("prior rows/instructions cannot substitute current post-authorization physical evidence or exact identity", async () => {
      await observed(0, "presence", 500); await assert.rejects(check(a.id, rtv.id), /qualifying scan/); await assert.rejects(check(b.id, rtv.id), /exact physical unit/);
      const seen = await observed(0, "presence", 2000); const eligible = await check(a.id, rtv.id); assert.equal(eligible.id, rtv.id); assert.equal(eligible.eligibility.physicalObservationId, seen.observation.observationId); assert.match(eligible.eligibility.meaning, /no MARS submission/);
      assert.equal(await prisma.officeDispositionExecution.count({ where: { dispositionId: rtv.id } }), 0);
    });
    await t.test("hold/property, later departure and corrected-away presence independently block current eligibility", async () => {
      const hold = await office.createOfficeDisposition(actor, { operationId: randomUUID(), unitId: a.id, kind: "customer_property", reason: "Synthetic customer-property review supersedes routine RTV.", instruction: "Hold synthetic A for an office decision." }); await assert.rejects(check(a.id, rtv.id), /hold\/customer-property/);
      await office.revokeOfficeDisposition(actor, { operationId: randomUUID(), dispositionId: hold.disposition.id, expectedRevision: 1, reason: "Synthetic reviewed conflict has been resolved." }); await check(a.id, rtv.id);
      await observed(0, "departure", 3000); await assert.rejects(check(a.id, rtv.id), /qualifying scan/);
      const present = await observed(0, "check_in", 4000); await check(a.id, rtv.id);
      await warehouse.correctWarehouseObservation(actor, { operationId: randomUUID(), observationId: present.observation.observationId, unitId: b.id, expectedRevision: 0, reason: "Synthetic correction: this original scan actually identified appliance B." }); await assert.rejects(check(a.id, rtv.id), /qualifying scan/);
      await warehouse.correctWarehouseObservation(actor, { operationId: randomUUID(), observationId: present.observation.observationId, unitId: a.id, expectedRevision: 1, reason: "Synthetic second inspection restores the actual original A association with evidence." }); await check(a.id, rtv.id);
    });
    await t.test("conditional authority requires the original effective qualifying trigger; placement execution still permits later submission review", async () => {
      const conditional = await authorization(c.id, { kind: "conditional_rtv", triggerAt: new Date(base + 5000), targetLocation: "RTV" }); conditionalId = conditional.id;
      const trigger = await observed(2, "presence", 6000); await assert.rejects(check(c.id, conditional.id), /qualifying-scan trigger/);
      await office.reviewOfficeObservation(actor, { observationId: trigger.observation.observationId }); const triggered = await check(c.id, conditional.id); assert.equal(triggered.status, "triggered"); assert.equal(triggered.eligibility.conditionalTriggerObservationId, trigger.observation.observationId);
      const placed = await observed(2, "placement", 7000, "RTV"); await office.recordOfficeDispositionExecution(actor, { operationId: randomUUID(), dispositionId: conditional.id, observationId: placed.observation.observationId, evidence: "Synthetic actual authorized C placement is confirmed independently." }); assert.equal((await check(c.id, conditional.id)).status, "executed");
      await warehouse.correctWarehouseObservation(actor, { operationId: randomUUID(), observationId: trigger.observation.observationId, unitId: null, expectedRevision: 0, reason: "Synthetic original trigger identity has been disproved; later placement is separate evidence." }); await assert.rejects(check(c.id, conditional.id), /original conditional trigger/);
      await warehouse.correctWarehouseObservation(actor, { operationId: randomUUID(), observationId: trigger.observation.observationId, unitId: c.id, expectedRevision: 1, reason: "Synthetic reviewed original trigger proof identifies C after all." }); await check(c.id, conditional.id);
    });
    await t.test("no-upcoming-date condition needs the latest complete current schedule and rejects later reschedule/incomplete evidence", async () => {
      const limited = await authorization(d.id, { requireNoUpcomingDate: true }); await observed(3, "presence", 2000); await assert.rejects(check(d.id, limited.id), /complete current schedule/);
      const now = Date.now(); const statement = { unitId: d.id, deliveryDate: businessDay(new Date(now - 2 * 86_400_000)), nextDeliveryDate: null, sourceRef: "Synthetic reviewed current office schedule", evidence: "Synthetic schedule statement is manual, not qualified DMP." };
      await office.recordOfficeSchedule(actor, { ...statement, operationId: randomUUID(), complete: true, sourceAsOf: new Date(now).toISOString() }); assert.ok((await check(d.id, limited.id)).eligibility.scheduleFactId);
      await office.recordOfficeSchedule(actor, { ...statement, operationId: randomUUID(), complete: true, nextDeliveryDate: businessDay(new Date(now + 86_400_000)), sourceAsOf: new Date(now + 1000).toISOString() }); await assert.rejects(check(d.id, limited.id), /complete current schedule/);
      await office.recordOfficeSchedule(actor, { ...statement, operationId: randomUUID(), complete: false, sourceAsOf: new Date(now + 2000).toISOString() }); await assert.rejects(check(d.id, limited.id), /complete current schedule/);
    });
    await t.test("expired and revoked prior authority remain unusable after physical placement", async () => {
      await prisma.officeDisposition.update({ where: { id: rtv.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); await assert.rejects(check(a.id, rtv.id), /unexpired RTV/);
      const current = await prisma.officeDisposition.findUniqueOrThrow({ where: { id: conditionalId } }); await office.revokeOfficeDisposition(actor, { operationId: randomUUID(), dispositionId: conditionalId, expectedRevision: current.revision, reason: "Synthetic office explicitly revokes prior conditional RTV authority." }); await assert.rejects(check(c.id, conditionalId), /unrevoked/);
    });
  } finally {
    await prisma.officeCaseEvent.deleteMany({ where: { case: { unitId: { in: unitIds } } } }); await prisma.officeDispositionExecution.deleteMany({ where: { disposition: { unitId: { in: unitIds } } } }); await prisma.officeDisposition.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.officeCase.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.officeScheduleFact.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.officeCommandReceipt.deleteMany({ where: { userId: user.id } });
    await prisma.warehouseObservationCorrection.deleteMany({ where: { userId: user.id } }); await prisma.warehousePhysicalObservation.deleteMany({ where: { userId: user.id } }); await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: unitIds } } }); await prisma.userSession.deleteMany({ where: { userId: user.id } }); await prisma.userRoleBundle.deleteMany({ where: { userId: user.id } }); await prisma.user.delete({ where: { id: user.id } }); await prisma.roleBundle.delete({ where: { id: bundle.id } }); await prisma.$disconnect();
  }
});
