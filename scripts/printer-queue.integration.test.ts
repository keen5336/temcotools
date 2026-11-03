import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { withPrincipalSite } from "../lib/sites/context";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import type { PrinterQueueDecision } from "../lib/labels/printer-queue";

const url = process.env.WAREHOUSE_SCOPE_TEST_DATABASE_URL;
test("PostgreSQL printer gate coordinates actual LabelIssuance rows without physical sends", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.equal(target.pathname, "/temcotools_v2_warehouse_scope_test");
  process.env.DATABASE_URL = url;
  const previousMode = process.env.TEMCO_PILOT_MODE;
  // Only this disposable fixture process permits local preparation/claims. No
  // printer HTTP call is made, and deployed pilot configuration is untouched.
  delete process.env.TEMCO_PILOT_MODE;
  const [{ prisma }, deviceService, issuanceService, queue] = await Promise.all([import("../lib/db"), import("../lib/labels/devices"), import("../lib/labels/issuance"), import("../lib/labels/printer-queue")]);
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID();
  const sites = await Promise.all(["a", "b"].map(name => owner.warehouseSite.create({ data: { slug: `printer-queue-${ns}-${name}`, name: `Synthetic queue ${name}` } })));
  const people = await Promise.all(["requester-a", "requester-b", "provider-a", "provider-b"].map(name => owner.user.create({ data: { username: `printer-queue-${ns}-${name}`, displayName: `Synthetic ${name}`, role: "user", pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin-value" } })));
  const role = await owner.warehouseRole.create({ data: { siteId: sites[0].id, name: "Synthetic print fixture", capabilities: ["labels.read", "labels.print", "labels.manage"] } });
  await Promise.all(people.map(person => owner.warehouseMembership.create({ data: { siteId: sites[0].id, userId: person.id, roles: { create: { roleId: role.id } } } })));
  const otherRole = await owner.warehouseRole.create({ data: { siteId: sites[1].id, name: "Synthetic other-site printer fixture", capabilities: ["labels.read", "labels.print"] } });
  await owner.warehouseMembership.create({ data: { siteId: sites[1].id, userId: people[2].id, roles: { create: { roleId: otherRole.id } } } });
  const sessions = await Promise.all(people.map(person => owner.userSession.create({ data: { id: randomUUID(), userId: person.id, authVersion: 1, activeSiteId: sites[0].id, expiresAt: new Date(Date.now() + 3600_000), deviceLabel: "Synthetic queue test", mfaVerifiedAt: new Date() } })));
  async function principal(index: number, siteId = sites[0].id): Promise<Principal> {
    const session = sessions[index], p = await resolvePrincipal({ userId: session.userId, sessionId: session.id, authVersion: session.authVersion, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, userId => owner.user.findUnique({ where: { id: userId }, select: CURRENT_USER_SELECT }), Date.now(), siteId); assert.ok(p); return { ...p, sessionId: session.id };
  }
  const principals = await Promise.all(people.map((_, i) => principal(i))), otherSiteProvider = await principal(2, sites[1].id);
  const as = <T>(p: Principal, run: () => T) => withPrincipalSite(p, run);
  await owner.labelTemplate.create({ data: { siteId: sites[0].id, name: `Synthetic queue ${ns}`, kind: "pick_wave", zpl: "^XA^FD{{lpn}}^FS^XZ" } });
  let counter = 0;
  type Device = Awaited<ReturnType<typeof deviceService.registerPrintingDevice>>;
  async function fixture(alias = false) {
    const suffix = randomUUID(), endpoint = `http://${suffix}.fakeprinter.invalid/queue`;
    const printer = await owner.labelPrinter.create({ data: { siteId: sites[0].id, name: `Synthetic physical ${suffix}`, endpoint } });
    const same = alias ? await owner.labelPrinter.create({ data: { siteId: sites[0].id, name: `Synthetic same endpoint ${suffix}`, endpoint: `http://${suffix.toUpperCase()}.fakeprinter.invalid:80/queue` } }) : printer;
    const devices = await Promise.all([2, 3].map(i => as(principals[i], () => deviceService.registerPrintingDevice(principals[i], { deviceId: randomUUID(), name: "Synthetic queue provider", mode: "relay", printerIds: [...new Set([printer.id, same.id])] }))));
    return { printer, same, devices };
  }
  async function prepare(requesterIndex: number, device: Device, printerId: string, sequence: number) {
    const p = principals[requesterIndex], prepared = await as(p, () => issuanceService.prepareLabelIssuance(p, { operationId: randomUUID(), purpose: "legacy_manual", printerId, mode: "relay", deviceId: device.device.id, legacyZpl: `^XA^FDSYNTHETIC-QUEUE-${++counter}^FS^XZ` }));
    await owner.labelIssuance.update({ where: { id: prepared.issuance.id }, data: { createdAt: new Date(Date.now() - 60_000 + sequence * 1000) } }); return prepared.issuance.id;
  }
  /** This is the real writer integration contract: gate + native row claim in one DB transaction. */
  async function claim(providerIndex: number, device: Device, issuanceId: string, hold?: () => Promise<void>) {
    const p = principals[providerIndex], reportToken = randomBytes(32).toString("base64url");
    return as(p, () => prisma.$transaction(async tx => {
      const decision = await queue.gatePrinterQueueDispatch(tx, p, { issuanceId, deviceId: device.device.id, deviceToken: device.deviceToken });
      if (decision.kind === "ready") {
        if (hold) await hold();
        const updated = await tx.labelIssuance.updateMany({ where: { id: decision.row.id, siteId: p.siteId, state: "queued" }, data: { state: "dispatching", dispatchedAt: new Date(), claimTokenHash: deviceService.hashDeviceToken(reportToken) } });
        assert.equal(updated.count, 1);
      }
      return { decision, reportToken };
    }));
  }
  async function report(providerIndex: number, device: Device, issuanceId: string, reportToken: string, status: "sent_unconfirmed" | "unknown" | "not_sent") {
    return as(principals[providerIndex], () => issuanceService.reportLabelDelivery(principals[providerIndex], { issuanceId, deviceId: device.device.id, deviceToken: device.deviceToken, reportToken, status, note: "Synthetic transaction result only; no printer was contacted" }));
  }
  const isBlocked = (value: PrinterQueueDecision, code: string) => assert.equal(value.kind === "blocked" && value.code, code);
  try {
    await t.test("deployed pilot effect mask remains enforced even at this helper", async () => {
      const f = await fixture(), issuanceId = await prepare(0, f.devices[0], f.printer.id, 1);
      process.env.TEMCO_PILOT_MODE = "read_only_dmp";
      try { await assert.rejects(claim(2, f.devices[0], issuanceId), /disabled/); } finally { delete process.env.TEMCO_PILOT_MODE; }
      assert.equal((await owner.labelIssuance.findUniqueOrThrow({ where: { id: issuanceId } })).state, "queued");
    });
    await t.test("native claim/report/reconcile writers apply the same queue gate without issuing a physical send", async () => {
      const f = await fixture(), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.printer.id, 2);
      const nativeClaim = (i: number, d: Device, id: string) => as(principals[i], () => issuanceService.claimLabelDispatch(principals[i], { issuanceId: id, deviceId: d.device.id, deviceToken: d.deviceToken }));
      const blocked = await nativeClaim(3, f.devices[1], second); assert.equal(blocked.dispatch, false); if (!blocked.dispatch) assert.equal(blocked.issuance.state, "queued");
      const claimed = await nativeClaim(2, f.devices[0], first); assert.equal(claimed.dispatch, true); if (!claimed.dispatch) throw new Error("Native first claim unavailable");
      assert.equal((await nativeClaim(3, f.devices[1], second)).dispatch, false);
      await report(2, f.devices[0], first, claimed.reportToken, "sent_unconfirmed");
      const receipt = await owner.labelIssuance.findUniqueOrThrow({ where: { id: first } }); assert.equal(receipt.physicallyConfirmedAt, null);
      const next = await nativeClaim(3, f.devices[1], second); assert.equal(next.dispatch, true); if (!next.dispatch) throw new Error("Native second claim unavailable");
      await report(3, f.devices[1], second, next.reportToken, "unknown");
      const third = await prepare(0, f.devices[0], f.printer.id, 3); assert.equal((await nativeClaim(2, f.devices[0], third)).dispatch, false);
      await as(principals[1], () => issuanceService.reconcileLabelIssuance(principals[1], { issuanceId: second, outcome: "not_printed", reason: "Synthetic native result explicitly reconciled; no printer was contacted" }));
      assert.equal((await nativeClaim(2, f.devices[0], third)).dispatch, true);
    });
    await t.test("the same configured destination cannot overlap across warehouses or expose sibling data", async () => {
      const f = await fixture(), original = await prepare(0, f.devices[0], f.printer.id, 1), claimA = await claim(2, f.devices[0], original);
      await owner.labelTemplate.create({ data: { siteId: sites[1].id, name: `Synthetic other-site label ${ns}`, kind: "pick_wave", zpl: "^XA^FD{{lpn}}^FS^XZ" } });
      const remotePrinter = await owner.labelPrinter.create({ data: { siteId: sites[1].id, name: `Synthetic same physical endpoint ${ns}`, endpoint: f.printer.endpoint } });
      const device = await as(otherSiteProvider, () => deviceService.registerPrintingDevice(otherSiteProvider, { deviceId: randomUUID(), name: "Synthetic other site", mode: "relay", printerIds: [remotePrinter.id] }));
      const prepared = await as(otherSiteProvider, () => issuanceService.prepareLabelIssuance(otherSiteProvider, { operationId: randomUUID(), purpose: "legacy_manual", printerId: remotePrinter.id, mode: "relay", deviceId: device.device.id, legacyZpl: "^XA^FDSYNTHETIC-OTHER-SITE^FS^XZ" }));
      const native = () => as(otherSiteProvider, () => issuanceService.claimLabelDispatch(otherSiteProvider, { issuanceId: prepared.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken }));
      const blocked = await native(); assert.equal(blocked.dispatch, false); assert.ok(!JSON.stringify(blocked).includes(original));
      await report(2, f.devices[0], original, claimA.reportToken, "unknown"); assert.equal((await native()).dispatch, false);
      await as(principals[0], () => issuanceService.reconcileLabelIssuance(principals[0], { issuanceId: original, outcome: "not_printed", reason: "Synthetic known destination verified no output; no physical printer contacted" }));
      const claimed = await native(); assert.equal(claimed.dispatch, true);
      assert.equal(await as(otherSiteProvider, () => prisma.labelIssuance.findUnique({ where: { id: original } })), null);
    });
    await t.test("two requesters/providers on one printer preserve FIFO and never overlap concurrent claims", async () => {
      const f = await fixture(), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.printer.id, 2);
      const [later, earlier] = await Promise.all([claim(3, f.devices[1], second), claim(2, f.devices[0], first)]);
      assert.equal(earlier.decision.kind, "ready"); assert.equal(later.decision.kind, "blocked");
      assert.equal(await owner.labelIssuance.count({ where: { printerId: f.printer.id, state: "dispatching" } }), 1);
      const again = await claim(2, f.devices[0], first); assert.equal(again.decision.kind, "existing");
      isBlocked((await claim(3, f.devices[1], second)).decision, "printer_busy");
      const sent = await report(2, f.devices[0], first, earlier.reportToken, "sent_unconfirmed"); assert.equal(sent.physicalOutput, "unconfirmed");
      const next = await claim(3, f.devices[1], second); assert.equal(next.decision.kind, "ready");
      const row = await owner.labelIssuance.findUniqueOrThrow({ where: { id: second } }); assert.equal(row.actorUserId, principals[1].userId); assert.equal(row.actorSessionId, principals[1].sessionId); assert.equal(row.deviceId, f.devices[1].device.id);
      const reservation = await owner.labelIssuanceEvent.findFirstOrThrow({ where: { issuanceId: second, action: "physical_printer_queue_reserved" } }), binding = JSON.parse(reservation.note);
      assert.equal(binding.requesterUserId, principals[1].userId); assert.equal(binding.deviceOwnerUserId, principals[3].userId); assert.equal(binding.physicalPrintConfirmed, false); assert.equal("runId" in binding, false);
    });
    await t.test("unknown blocks all new jobs and replay until the original is explicitly reconciled", async () => {
      const f = await fixture(), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.printer.id, 2), dispatched = await claim(2, f.devices[0], first);
      await report(2, f.devices[0], first, dispatched.reportToken, "unknown");
      isBlocked((await claim(3, f.devices[1], second)).decision, "printer_unknown"); assert.equal((await claim(2, f.devices[0], first)).decision.kind, "existing");
      await as(principals[0], () => issuanceService.reconcileLabelIssuance(principals[0], { issuanceId: first, outcome: "not_printed", reason: "Synthetic original inspected; no physical send occurred" }));
      assert.equal((await claim(3, f.devices[1], second)).decision.kind, "ready");
    });
    await t.test("identical normalized endpoints share one queue and retain original destination after managed edits", async () => {
      const f = await fixture(true), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.same.id, 2);
      assert.equal(queue.normalizedPrinterQueueEndpoint(f.printer.endpoint), queue.normalizedPrinterQueueEndpoint(f.same.endpoint));
      isBlocked((await claim(3, f.devices[1], second)).decision, "earlier_queued_job");
      const started = await claim(2, f.devices[0], first); await report(2, f.devices[0], first, started.reportToken, "unknown");
      await owner.labelPrinter.update({ where: { id: f.printer.id }, data: { endpoint: `http://${randomUUID()}.fakeprinter.invalid/changed` } });
      isBlocked((await claim(3, f.devices[1], second)).decision, "printer_unknown");
    });
    await t.test("different managed destinations remain independent while one transaction holds its printer lock", async () => {
      const a = await fixture(), b = await fixture(), first = await prepare(0, a.devices[0], a.printer.id, 1), second = await prepare(1, b.devices[1], b.printer.id, 1);
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const firstClaim = claim(2, a.devices[0], first, async () => { entered(); await held; });
      await enteredPromise;
      try { const next = await Promise.race([claim(3, b.devices[1], second), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("An unrelated printer was blocked by the first printer's transaction")), 1500))]); assert.equal(next.decision.kind, "ready"); }
      finally { release(); await firstClaim; }
    });
    await t.test("revoked requester is retired exactly; revoked/wrong provider never silently reroutes a queued job", async () => {
      const f = await fixture(), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.printer.id, 2);
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { revokedAt: new Date() } });
      isBlocked((await claim(3, f.devices[1], second)).decision, "earlier_queued_job");
      isBlocked((await claim(2, f.devices[0], first)).decision, "requester_authority_ended");
      assert.equal((await owner.labelIssuance.findUniqueOrThrow({ where: { id: first } })).state, "not_sent"); assert.equal((await claim(3, f.devices[1], second)).decision.kind, "ready");
      await owner.userSession.update({ where: { id: sessions[0].id }, data: { revokedAt: null } });
      const g = await fixture(), assigned = await prepare(0, g.devices[0], g.printer.id, 1);
      await owner.printingDevice.update({ where: { id: g.devices[0].device.id }, data: { revokedAt: new Date() } });
      await assert.rejects(claim(2, g.devices[0], assigned), /unavailable/); await assert.rejects(claim(3, g.devices[1], assigned), /original authorized printing device/);
      assert.equal((await owner.labelIssuance.findUniqueOrThrow({ where: { id: assigned } })).deviceId, g.devices[0].device.id);
    });
    await t.test("site/token/session isolation and transaction rollback preserve original claims", async () => {
      const f = await fixture(), issuanceId = await prepare(0, f.devices[0], f.printer.id, 1);
      await assert.rejects(as(otherSiteProvider, () => prisma.$transaction(tx => queue.gatePrinterQueueDispatch(tx, otherSiteProvider, { issuanceId, deviceId: f.devices[0].device.id, deviceToken: f.devices[0].deviceToken }))), /unavailable|warehouse/);
      await assert.rejects(as(principals[2], () => prisma.$transaction(tx => queue.gatePrinterQueueDispatch(tx, principals[2], { issuanceId, deviceId: f.devices[0].device.id, deviceToken: "synthetic-wrong-device-token" }))), /unavailable/);
      await assert.rejects(claim(2, f.devices[0], issuanceId, async () => { throw new Error("Synthetic rollback before native claim commit"); }), /Synthetic rollback/);
      assert.equal((await owner.labelIssuance.findUniqueOrThrow({ where: { id: issuanceId } })).state, "queued");
      assert.equal(await owner.labelIssuanceEvent.count({ where: { issuanceId, action: "physical_printer_queue_reserved" } }), 0);
      assert.equal((await claim(2, f.devices[0], issuanceId)).decision.kind, "ready");
    });
    await t.test("settlement uses the same native transaction lock and unknown state cannot become automatic physical proof", async () => {
      const f = await fixture(), first = await prepare(0, f.devices[0], f.printer.id, 1), second = await prepare(1, f.devices[1], f.printer.id, 2);
      await owner.labelIssuance.update({ where: { id: first }, data: { state: "unsupported_synthetic_state" } });
      isBlocked((await claim(3, f.devices[1], second)).decision, "printer_state_unknown");
      const row = await as(principals[0], () => prisma.$transaction(tx => queue.lockPrinterQueueSettlement(tx, principals[0], first)));
      assert.equal(row.id, first); assert.equal(queue.printerQueueReceipt(row).physicalOutput, "unconfirmed");
      assert.equal(row.physicallyConfirmedAt, null); assert.equal(row.appliedAt, null);
    });
  } finally { if (previousMode === undefined) delete process.env.TEMCO_PILOT_MODE; else process.env.TEMCO_PILOT_MODE = previousMode; await Promise.all([owner.$disconnect(), prisma.$disconnect()]); }
});
