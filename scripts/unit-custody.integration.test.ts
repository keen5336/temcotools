import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { CURRENT_USER_SELECT, resolvePrincipal, type Principal } from "../lib/auth/principal";
import { withPrincipalSite } from "../lib/sites/context";

const url = process.env.UNIT_CUSTODY_TEST_DATABASE_URL;
test("controlled custody preserves one identity, private histories and independent physical facts", { skip: !url }, async t => {
  const target = new URL(url!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439"); assert.match(target.pathname, /^\/temcotools_v2_unit_custody(?:_[a-z0-9]+)?_test$/);
  process.env.DATABASE_URL = url; delete process.env.TEMCO_PILOT_MODE;
  const [{ prisma }, custody] = await Promise.all([import("../lib/db"), import("../lib/warehouse/custody")]);
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }), ns = randomUUID();
  const sites = await Promise.all(["a", "b", "c"].map(name => owner.warehouseSite.create({ data: { slug: `custody-${ns}-${name}`, name: `Synthetic custody ${name}` } })));
  const people = await Promise.all(sites.map((site, index) => owner.user.create({ data: { username: `custody-${ns}-${index}`, displayName: "Synthetic custodian", role: "admin", isPlatformAdmin: false, pinHash: "disabled:v2", passwordHash: "synthetic-nonlogin", siteMemberships: { create: { siteId: site.id, roles: { create: { roleId: "warehouse-manager" } } } } } })));
  const sessions = await Promise.all(people.map((user, index) => owner.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: 1, activeSiteId: sites[index].id, expiresAt: new Date(Date.now() + 3600_000), deviceLabel: "Synthetic custody fixture" } })));
  async function principal(index: number) { const session = sessions[index], p = await resolvePrincipal({ userId: session.userId, authVersion: 1, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => owner.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), sites[index].id); assert.ok(p); assert.ok(p.capabilities.includes("inventory.custody")); return { ...p, sessionId: session.id }; }
  const principals = await Promise.all(sites.map((_, index) => principal(index))), [a, b, c] = principals;
  const as = <T>(p: Principal, fn: () => T) => withPrincipalSite(p, fn), op = () => randomUUID();
  async function fixture(name: string, index = 0, value = `LPN-${ns}-${name}`) {
    const unit = await owner.warehouseUnit.create({ data: { id: `synthetic-custody:${ns}:${name}`, siteId: sites[index].id, createdByUserId: people[index].id, creationEvidence: `PRIVATE-${name}-${index}`, creationFingerprint: `PRIVATE-FINGERPRINT-${name}` } });
    const alias = await owner.warehouseIdentifier.create({ data: { siteId: sites[index].id, unitId: unit.id, kind: "lpn", namespace: "wms", value: value.toUpperCase(), rawValue: value, evidence: `PRIVATE-ALIAS-${name}` } });
    return { unit, alias };
  }
  async function observe(unitId: string | null, index: number, alias: string, type: "departure" | "check_in", resolution = "resolved", after?: Date | string) {
    const capturedAt = new Date(Math.max(Date.now(), new Date(after ?? 0).getTime()) + 2);
    return owner.warehousePhysicalObservation.create({ data: { siteId: sites[index].id, userId: people[index].id, eventId: op(), fingerprint: op(), rawIdentifier: alias, identifierType: "lpn", identifierNamespace: "wms", type, captureMethod: "manual", location: "SYNTHETIC-CUSTODY-DOCK", capturedAt, unitId, resolution, candidateUnitIds: unitId ? [unitId] : [] } });
  }
  async function proposal(item: Awaited<ReturnType<typeof fixture>>, from = a, destinationSiteId = sites[1].id) { return as(from, () => custody.proposeUnitCustody(from, { operationId: op(), unitId: item.unit.id, destinationSiteId, aliasIds: [item.alias.id], handoff: { description: "Synthetic appliance", handlingInstruction: "Synthetic dock only" }, note: "Synthetic approved movement" })); }
  async function accept(transfer: { id: string; revision: number }, actor = b) { return as(actor, () => custody.acceptUnitCustody(actor, { operationId: op(), transferId: transfer.id, expectedRevision: transfer.revision, note: "Synthetic destination acceptance" })); }
  async function complete(item: Awaited<ReturnType<typeof fixture>>, fromIndex: number, toIndex: number) {
    const from = principals[fromIndex], to = principals[toIndex], started = await proposal(item, from, sites[toIndex].id), accepted = await accept(started.transfer, to);
    const departure = await observe(item.unit.id, fromIndex, item.alias.value, "departure", "resolved", accepted.transfer.acceptedAt!);
    const departed = await as(from, () => custody.departUnitCustody(from, { operationId: op(), transferId: accepted.transfer.id, expectedRevision: accepted.transfer.revision, observationId: departure.id, note: "Synthetic departure confirmation" }));
    const checkIn = await observe(item.unit.id, toIndex, item.alias.value, "check_in", "resolved", departed.transfer.departedAt!);
    return as(to, () => custody.checkInUnitCustody(to, { operationId: op(), transferId: departed.transfer.id, expectedRevision: departed.transfer.revision, observationId: checkIn.id, note: "Synthetic arrival confirmation" }));
  }
  const original = await fixture("original"), replacement = await fixture("replacement"); let transfer: Awaited<ReturnType<typeof custody.proposeUnitCustody>>;
  await t.test("minimal identity and private-origin projection are separate under forced RLS", async () => {
    const raw = await owner.warehouseUnit.findUniqueOrThrow({ where: { id: original.unit.id } }); assert.equal(raw.creationEvidence, null); assert.equal(raw.creationFingerprint, null); assert.equal(raw.createdByUserId, null);
    const origin = await as(a, () => custody.getWarehouseUnitCustody(a, { unitId: original.unit.id })); assert.match(origin.privateOrigin!.creationEvidence!, /PRIVATE-original/); assert.equal(origin.participation!.phase, "unestablished"); assert.equal(origin.participation!.holdsCustody, false);
    await assert.rejects(as(b, () => custody.getWarehouseUnitCustody(b, { unitId: original.unit.id })), /not found/);
    assert.equal(await as(b, () => prisma.warehouseUnitOrigin.findUnique({ where: { unitId: original.unit.id } })), null);
    await assert.rejects(as(a, () => prisma.warehouseUnitSite.update({ where: { siteId_unitId: { siteId: sites[0].id, unitId: original.unit.id } }, data: { holdsCustody: true } })), /permission denied/);
    await assert.rejects(as(a, () => prisma.warehouseUnit.update({ where: { id: original.unit.id }, data: { siteId: sites[1].id } })), /immutable|scope/);
    const roles = await owner.$queryRaw<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; member: boolean }[]>`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,pg_has_role('temco_runtime',oid,'MEMBER') AS member FROM pg_roles WHERE rolname IN ('temco_custody_reader','temco_custody_writer')`;
    assert.equal(roles.length, 2); assert.ok(roles.every(r => !r.rolcanlogin && !r.rolsuper && r.rolbypassrls && !r.member));
  });
  await t.test("native runtime identity creation retains private API compatibility and site-local LPN source rows", async () => {
    const unitId = `synthetic-custody:${ns}:runtime`;
    const unit = await as(a, () => prisma.warehouseUnit.create({ data: { id: unitId, creationEvidence: "PRIVATE-RUNTIME-ORIGIN", createdByUserId: a.userId, creationFingerprint: "PRIVATE-RUNTIME-FINGERPRINT" } }));
    assert.equal(unit.id, unitId); assert.equal(unit.creationEvidence, null);
    const privateOrigin = await as(a, () => prisma.$transaction(tx => custody.getUnitOriginInTransaction(tx, unitId))); assert.equal(privateOrigin!.creationEvidence, "PRIVATE-RUNTIME-ORIGIN");
    await as(a, () => prisma.$executeRaw`INSERT INTO "WarehouseUnit"(id) VALUES(${unitId}) ON CONFLICT(id) DO NOTHING`);
    await as(b, () => prisma.$executeRaw`INSERT INTO "WarehouseUnit"(id) VALUES(${unitId}) ON CONFLICT(id) DO NOTHING`);
    assert.equal(await as(b, () => prisma.warehouseUnit.findUnique({ where: { id: unitId } })), null);
    assert.equal(await as(b, () => prisma.warehouseUnitSite.count({ where: { unitId } })), 0);

    const common = { lpn: `SYNTHETIC-SAME-LPN-${ns}`, status: "reported_only", orderNumber: "SYNTHETIC-ORDER", vendor: "Synthetic", receivedDate: "unknown", description: "Synthetic source", customerName: "SYNTHETIC", sourceData: {}, contentHash: op() };
    await owner.inventoryAuditItem.createMany({ data: sites.slice(0, 2).map(site => ({ ...common, siteId: site.id })) });
    assert.equal(await as(a, () => prisma.inventoryAuditItem.count({ where: { lpn: common.lpn } })), 1); assert.equal(await as(b, () => prisma.inventoryAuditItem.count({ where: { lpn: common.lpn } })), 1);
    await assert.rejects(as(a, () => prisma.inventoryAuditItem.create({ data: { ...common, siteId: sites[2].id, lpn: `FORBIDDEN-${ns}` } })), /row-level security/);
  });
  await t.test("source proposal, current destination acceptance and imports do not imply presence or share rights", async () => {
    await owner.officeExchange.create({ data: { siteId: sites[0].id, originalUnitId: original.unit.id, replacementUnitId: replacement.unit.id, orderReference: "SYNTHETIC-SAME-ORDER", evidence: "PRIVATE-SOURCE-EXCHANGE", createdByUserId: a.userId } });
    await owner.warehouseUnitNote.create({ data: { siteId: sites[0].id, unitId: original.unit.id, authorUserId: a.userId, authorUsername: a.username, authorName: a.displayName, revisions: { create: { siteId: sites[0].id, revision: 1, action: "append", body: "PRIVATE-SOURCE-NOTE", editedByUserId: a.userId, editorUsername: a.username, editorName: a.displayName } } } });
    assert.deepEqual(await as(b, () => prisma.$transaction(tx => custody.getPermittedImportedIdentityInTransaction(tx, original.alias.value))), { unitId: null, conflict: true });
    const input = { operationId: op(), unitId: original.unit.id, destinationSiteId: sites[1].id, aliasIds: [original.alias.id], handoff: { description: "Approved synthetic summary" }, note: "Source plans movement" };
    transfer = await as(a, () => custody.proposeUnitCustody(a, input)); const replay = await as(a, () => custody.proposeUnitCustody(a, input)); assert.equal(replay.replayed, true); assert.equal(replay.transfer.id, transfer.transfer.id);
    await assert.rejects(as(a, () => custody.proposeUnitCustody(a, { ...input, handoff: { description: "Changed operation" } })), /different custody inputs/);
    const pending = await as(b, () => custody.getUnitCustodyTransfer(b, { transferId: transfer.transfer.id })); assert.equal(pending.transfer.state, "proposed"); assert.ok(JSON.stringify(pending.transfer.aliasIds).includes(original.alias.value)); assert.equal(JSON.stringify(pending).includes("PRIVATE"), false);
    assert.equal(await as(b, () => prisma.warehouseUnit.findUnique({ where: { id: original.unit.id } })), null);
    await assert.rejects(accept(transfer.transfer, a), /destination/);
    await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: sites[1].id, userId: b.userId } }, data: { isActive: false } });
    await assert.rejects(accept(transfer.transfer), /access|permission|warehouse/);
    await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: sites[1].id, userId: b.userId } }, data: { isActive: true } });
    transfer = await accept(transfer.transfer);
    const received = await as(b, () => custody.getWarehouseUnitCustody(b, { unitId: original.unit.id })); assert.equal(received.unit.id, original.unit.id); assert.equal(received.privateOrigin, null); assert.equal(received.participation!.phase, "expected"); assert.equal(received.participation!.holdsCustody, false);
    assert.equal(await as(b, () => prisma.warehouseIdentifier.count({ where: { unitId: original.unit.id } })), 0); assert.equal(await as(b, () => prisma.warehouseUnitNote.count({ where: { unitId: original.unit.id } })), 0); assert.equal(await as(b, () => prisma.officeExchange.count({ where: { originalUnitId: original.unit.id } })), 0);
    assert.deepEqual(await as(b, () => prisma.$transaction(tx => custody.getPermittedImportedIdentityInTransaction(tx, original.alias.value))), { unitId: original.unit.id, conflict: false });
    await assert.rejects(as(b, () => prisma.$transaction(tx => custody.assertUnitOperationalCustodyInTransaction(tx, b, original.unit.id))), /no operational custody/);
    const selectors = await as(a, () => custody.listCustodySites(a)); assert.deepEqual(selectors.sites.map(s => s.id), [sites[0].id]);
  });
  await t.test("departure requires exact independent evidence and blocks unresolved label/MARS work", async () => {
    const observation = await observe(original.unit.id, 0, original.alias.value, "departure", "resolved", transfer.transfer.acceptedAt!);
    const input = { operationId: op(), transferId: transfer.transfer.id, expectedRevision: transfer.transfer.revision, observationId: observation.id, note: "Synthetic source departure" };
    process.env.TEMCO_PILOT_MODE = "read_only_dmp"; await assert.rejects(as(a, () => custody.departUnitCustody(a, input)), /disabled in this isolated pilot/); delete process.env.TEMCO_PILOT_MODE;
    const label = await owner.labelIssuance.create({ data: { siteId: sites[0].id, operationId: op(), actorUserId: a.userId, actorSessionId: a.sessionId!, actorAuthVersion: 1, actorAuthSource: "session", actorCapabilities: ["labels.print"], unitId: original.unit.id, purpose: "unit_identity", printerId: "synthetic.fakeprinter.invalid", contentFingerprint: op(), inputFingerprint: op(), renderedZpl: "^XA^FDSYNTHETIC^FS^XZ", mode: "relay", deviceId: "synthetic-device", state: "unknown" } });
    await assert.rejects(as(a, () => custody.departUnitCustody(a, input)), /unresolved label/);
    await owner.labelIssuance.update({ where: { id: label.id }, data: { state: "verified_not_printed" } });
    const mars = await owner.marsSubmissionIntent.create({ data: { siteId: sites[0].id, unitId: original.unit.id, authorizedByUserId: a.userId, authorizationExpiresAt: new Date(Date.now() + 3600_000), preparedByUserId: a.userId, evidence: "Synthetic local intent only", state: "unknown" } });
    await assert.rejects(as(a, () => custody.departUnitCustody(a, input)), /MARS/);
    await owner.marsSubmissionIntent.update({ where: { id: mars.id }, data: { state: "verified_not_submitted" } });
    const board = await owner.dispatchBoard.create({ data: { siteId: sites[0].id, day: "2026-11-03", scope: `synthetic-${ns}` } });
    const snapshot = await owner.dispatchSnapshot.create({ data: { siteId: sites[0].id, boardId: board.id, version: 1, sourceKind: "manual_reviewed", sourceAsOf: new Date(), sourceRef: "synthetic", coverage: "partial", note: "Synthetic active allocation", slots: [], createdByUserId: a.userId } });
    const allocation = await owner.dispatchAllocation.create({ data: { siteId: sites[0].id, snapshotId: snapshot.id, slotKey: "synthetic-slot", unitId: original.unit.id, matchEvidence: {}, createdByUserId: a.userId } });
    await owner.dispatchReservation.create({ data: { siteId: sites[0].id, unitId: original.unit.id, allocationId: allocation.id, boardId: board.id, snapshotId: snapshot.id } });
    await assert.rejects(as(a, () => custody.departUnitCustody(a, input)), /dispatch reservation/);
    await owner.dispatchReservation.delete({ where: { unitId: original.unit.id } });
    await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: sites[0].id, userId: a.userId } }, data: { isActive: false } });
    await assert.rejects(as(a, () => custody.departUnitCustody(a, input)), /access|warehouse|permission/);
    await owner.warehouseMembership.update({ where: { siteId_userId: { siteId: sites[0].id, userId: a.userId } }, data: { isActive: true } });
    transfer = await as(a, () => custody.departUnitCustody(a, input)); assert.equal(transfer.transfer.state, "departed");
    assert.equal((await as(b, () => custody.getWarehouseUnitCustody(b, { unitId: original.unit.id }))).participation!.holdsCustody, false);
    await assert.rejects(as(a, () => custody.cancelUnitCustody(a, { operationId: op(), transferId: transfer.transfer.id, expectedRevision: transfer.transfer.revision, note: "Cannot cancel departed freight" })), /un-departed/);
    await assert.rejects(as(a, () => prisma.labelIssuance.create({ data: { ...label, id: op(), operationId: op(), state: "queued" } })), /custody does not permit/);
  });
  await t.test("ambiguous evidence remains unresolved; concurrent check-ins complete exactly once", async () => {
    const ambiguous = await observe(null, 1, original.alias.value, "check_in", "ambiguous", transfer.transfer.departedAt!);
    await assert.rejects(as(b, () => custody.checkInUnitCustody(b, { operationId: op(), transferId: transfer.transfer.id, expectedRevision: transfer.transfer.revision, observationId: ambiguous.id, note: "Ambiguous scan is not confirmation" })), /uniquely resolved/);
    assert.equal((await owner.warehousePhysicalObservation.findUniqueOrThrow({ where: { id: ambiguous.id } })).unitId, null);
    const observation = await observe(original.unit.id, 1, original.alias.value, "check_in", "resolved", transfer.transfer.departedAt!);
    const input = { operationId: op(), transferId: transfer.transfer.id, expectedRevision: transfer.transfer.revision, observationId: observation.id, note: "Synthetic destination confirmation" };
    const outcomes = await Promise.allSettled([as(b, () => custody.checkInUnitCustody(b, input)), as(b, () => custody.checkInUnitCustody(b, { ...input, operationId: op() }))]); assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const successful = outcomes.find(r => r.status === "fulfilled"); assert.equal(successful!.status, "fulfilled"); transfer = successful!.value;
    assert.equal(transfer.transfer.unitId, original.unit.id); assert.equal(transfer.transfer.state, "checked_in");
    assert.equal(await owner.warehouseUnitSite.count({ where: { unitId: original.unit.id, holdsCustody: true } }), 1);
    const winningEvent = await owner.warehouseUnitTransferEvent.findFirstOrThrow({ where: { transferId: transfer.transfer.id, kind: "checked_in" } });
    const replay = await as(b, () => custody.checkInUnitCustody(b, { ...input, operationId: winningEvent.operationId })); assert.equal(replay.replayed, true); assert.equal(replay.transfer.revision, transfer.transfer.revision);
    await assert.rejects(owner.warehouseObservationCorrection.create({ data: { siteId: sites[1].id, observationId: observation.id, unitId: replacement.unit.id, reason: "Invalid identity rewrite", userId: b.userId, revision: 1 } }), /custody reconciliation/);
    await assert.rejects(as(b, () => prisma.warehousePhysicalObservation.update({ where: { id: observation.id }, data: { type: "departure" } })), /immutable/);

    assert.equal((await owner.warehouseUnitSite.findUniqueOrThrow({ where: { siteId_unitId: { siteId: sites[0].id, unitId: replacement.unit.id } } })).phase, "unestablished");
  });
  await t.test("return movement keeps the identical unit and does not reveal future-site aliases/history", async () => {
    const newAlias = await owner.warehouseIdentifier.create({ data: { siteId: sites[1].id, unitId: original.unit.id, kind: "submission", namespace: "mars", value: `SYNTHETIC-B-${ns}`, rawValue: "Synthetic B only", evidence: "PRIVATE-B-NEW-ALIAS" } });
    assert.equal((await as(a, () => custody.getWarehouseUnitCustody(a, { unitId: original.unit.id }))).aliases.some(alias => alias.id === newAlias.id), false);
    const returned = await complete(original, 1, 0); assert.equal(returned.transfer.unitId, original.unit.id); assert.equal(returned.transfer.state, "checked_in");
    const back = await as(a, () => custody.getWarehouseUnitCustody(a, { unitId: original.unit.id })); assert.equal(back.participation!.holdsCustody, true); assert.match(back.privateOrigin!.creationEvidence!, /PRIVATE-original/); assert.equal(back.aliases.some(alias => alias.id === newAlias.id), false);
    await complete(original, 0, 1);
    const onward = await proposal(original, b, sites[2].id); await accept(onward.transfer, c);
    assert.equal((await as(a, () => custody.listUnitCustodyHistory(a, { unitId: original.unit.id }))).transfers.some(item => item.id === onward.transfer.id), false);
    await assert.rejects(as(a, () => custody.getUnitCustodyTransfer(a, { transferId: onward.transfer.id })), /not found/);
    assert.equal((await as(c, () => custody.getWarehouseUnitCustody(c, { unitId: original.unit.id }))).privateOrigin, null);
    const plain = await as(c, () => custody.getUnitCustodyTransfer(c, { transferId: onward.transfer.id })); assert.equal(JSON.stringify(plain).includes("PRIVATE"), false);
    await assert.rejects(as(b, async () => prisma.warehouseUnitTransferEvent.update({ where: { id: (await owner.warehouseUnitTransferEvent.findFirstOrThrow({ where: { transferId: onward.transfer.id } })).id }, data: { kind: "rewritten" } })), /immutable/);
  });
  await t.test("alias changes, collisions and two competing proposals cannot silently merge units", async () => {
    const item = await fixture("alias-change"), started = await proposal(item), accepted = await accept(started.transfer);
    await owner.warehouseIdentifier.update({ where: { id: item.alias.id }, data: { revokedAt: new Date(), revocationReason: "Synthetic correction" } });
    const observation = await observe(item.unit.id, 0, item.alias.value, "departure", "resolved", accepted.transfer.acceptedAt!);
    await assert.rejects(as(a, () => custody.departUnitCustody(a, { operationId: op(), transferId: accepted.transfer.id, expectedRevision: accepted.transfer.revision, observationId: observation.id, note: "Revoked alias cannot complete" })), /ambiguous|approved transfer alias/);
    const cancelled = await as(a, () => custody.cancelUnitCustody(a, { operationId: op(), transferId: accepted.transfer.id, expectedRevision: accepted.transfer.revision, note: "Cancel before physical departure" })); assert.equal(cancelled.transfer.state, "cancelled");
    const ambiguous = await fixture("collision", 0, replacement.alias.value);
    const resolution = await as(a, () => prisma.$transaction(tx => custody.getPermittedImportedIdentityInTransaction(tx, replacement.alias.value))); assert.deepEqual(resolution, { unitId: null, conflict: true });
    const pending = await Promise.allSettled([proposal(replacement), proposal(replacement)]); assert.equal(pending.filter(r => r.status === "fulfilled").length, 1);
    assert.notEqual(ambiguous.unit.id, replacement.unit.id); assert.notEqual(original.unit.id, replacement.unit.id);
  });
  await t.test("a concurrent alias revocation serializes before departure and cannot leave a stale completed stage", async () => {
    const item = await fixture("concurrent-alias"), proposed = await proposal(item), accepted = await accept(proposed.transfer), observation = await observe(item.unit.id, 0, item.alias.value, "departure", "resolved", accepted.transfer.acceptedAt!);
    let signal!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { signal = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const revocation = owner.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(8100801)`; await tx.warehouseIdentifier.update({ where: { id: item.alias.id }, data: { revokedAt: new Date() } }); signal(); await wait; }, { timeout: 10_000 });
    await held;
    let settled = false;
    const departure = as(a, () => custody.departUnitCustody(a, { operationId: op(), transferId: accepted.transfer.id, expectedRevision: accepted.transfer.revision, observationId: observation.id, note: "Concurrent alias must be current" })).then(value => { settled = true; return { ok: true as const, value }; }, error => { settled = true; return { ok: false as const, error }; });
    await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(settled, false, "The real writer must wait for the held alias/import gate");
    release(); await revocation;
    const result = await departure; assert.equal(result.ok, false); if (!result.ok) assert.match(String(result.error), /ambiguous|approved transfer alias|Pinned transfer aliases changed/);
    assert.equal((await owner.warehouseUnitTransfer.findUniqueOrThrow({ where: { id: accepted.transfer.id } })).state, "accepted");
  });
  await t.test("a held independent observation correction prevents stale custody confirmation for the former unit", async () => {
    const item = await fixture("concurrent-observation"), corrected = await fixture("concurrent-observation-corrected"), proposed = await proposal(item), accepted = await accept(proposed.transfer);
    const observation = await observe(item.unit.id, 0, item.alias.value, "departure", "resolved", accepted.transfer.acceptedAt!);
    let signal!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { signal = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    // Use the real runtime INSERT and BEFORE trigger, not a fixture-side lock.
    // The correction is invisible to another transaction until release/commit.
    const correction = as(a, () => prisma.$transaction(async tx => {
      await tx.warehouseObservationCorrection.create({ data: { id: `synthetic-correction:${op()}`, observationId: observation.id, unitId: corrected.unit.id, reason: "Synthetic independent evidence belongs to the other appliance.", userId: a.userId, revision: 1 } });
      signal(); await wait;
    }, { timeout: 10_000 }));
    await held;
    let settled = false;
    const departure = as(a, () => custody.departUnitCustody(a, { operationId: op(), transferId: accepted.transfer.id, expectedRevision: accepted.transfer.revision, observationId: observation.id, note: "Custody must use the committed current observation association." })).then(value => { settled = true; return { ok: true as const, value }; }, error => { settled = true; return { ok: false as const, error }; });
    try { await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(settled, false, "The real custody writer must wait for the held observation-correction lock"); }
    finally { release(); }
    await correction;
    const result = await departure; assert.equal(result.ok, false); if (!result.ok) assert.match(String(result.error), /uniquely resolved|exact-unit physical observation/);
    const current = await owner.warehouseUnitTransfer.findUniqueOrThrow({ where: { id: accepted.transfer.id } }); assert.equal(current.state, "accepted"); assert.equal(current.departureObservationId, null);
    assert.equal(await owner.warehouseUnitTransferEvent.count({ where: { transferId: current.id, kind: "departed" } }), 0);
    assert.equal((await owner.warehouseObservationCorrection.findFirstOrThrow({ where: { observationId: observation.id } })).unitId, corrected.unit.id);
  });
  await t.test("actual WMS import/lookup/history consumers retain a foreign gap then bind accepted identity without private leakage", async () => {
    const [{ importInventoryReport }, units, gaps] = await Promise.all([import("../lib/inventory-audit"), import("../lib/warehouse/units"), import("../lib/warehouse/identity-gaps")]);
    const lpn = `SYNTHETIC-CONSUMER-${ns}`.toUpperCase(), row = { LPN: lpn, Status: "Received", "Order Number": "SYNTHETIC-CONSUMER-ORDER", Vendor: "Synthetic appliance", "Received Date": "2026-11-03", Description: "Synthetic receiving appliance", "Deliver to:": "SYNTHETIC", "Private source field": "PRIVATE-CONSUMER-SOURCE-A" };
    const importedA = await as(a, () => importInventoryReport({ rows: [row], filename: "synthetic-a.csv", uploadedByName: a.displayName, uploadedByUserId: a.userId, actorPrincipal: a })); assert.equal(importedA.identityUnresolvedCount, 0);
    const recordA = await owner.inventoryAuditItem.findUniqueOrThrow({ where: { siteId_lpn: { siteId: sites[0].id, lpn } } }); assert.ok(recordA.unitId);
    const initialUnits = await owner.warehouseUnit.count(), rowB = { ...row, "Private source field": "PRIVATE-CONSUMER-SOURCE-B" };
    const importedB = await as(b, () => importInventoryReport({ rows: [rowB], filename: "synthetic-b.csv", uploadedByName: b.displayName, uploadedByUserId: b.userId, actorPrincipal: b })); assert.equal(importedB.identityUnresolvedCount, 1); assert.equal(await owner.warehouseUnit.count(), initialUnits);
    const pendingB = await owner.inventoryAuditItem.findUniqueOrThrow({ where: { siteId_lpn: { siteId: sites[1].id, lpn } } }); assert.equal(pendingB.unitId, null); assert.notEqual(pendingB.id, recordA.id);
    const unresolved = await as(b, () => gaps.listWarehouseIdentityGaps(b, { limit: 100 })); assert.ok(unresolved.items.some(item => item.lpn === lpn)); assert.equal(JSON.stringify(unresolved).includes(recordA.unitId!), false);
    const canonical = await owner.warehouseUnitAlias.findFirstOrThrow({ where: { unitId: recordA.unitId!, kind: "lpn", value: lpn } });
    await owner.warehouseUnitOrigin.update({ where: { unitId: recordA.unitId! }, data: { creationEvidence: "PRIVATE-CONSUMER-ORIGIN-A" } });
    await owner.warehouseUnitNote.create({ data: { siteId: sites[0].id, unitId: recordA.unitId!, authorUserId: a.userId, authorUsername: a.username, authorName: a.displayName, revisions: { create: { siteId: sites[0].id, revision: 1, action: "append", body: "PRIVATE-CONSUMER-NOTE-A", editedByUserId: a.userId, editorUsername: a.username, editorName: a.displayName } } } });
    const planned = await as(a, () => custody.proposeUnitCustody(a, { operationId: op(), unitId: recordA.unitId!, destinationSiteId: sites[1].id, aliasIds: [canonical.id], handoff: { description: "Approved consumer transfer" }, note: "Synthetic source evidence approval" })); await accept(planned.transfer);
    const refresh = await as(b, () => importInventoryReport({ rows: [rowB], filename: "synthetic-b-refresh.csv", uploadedByName: b.displayName, uploadedByUserId: b.userId, actorPrincipal: b })); assert.equal(refresh.identityUnresolvedCount, 0);
    const boundB = await owner.inventoryAuditItem.findUniqueOrThrow({ where: { siteId_lpn: { siteId: sites[1].id, lpn } } }); assert.equal(boundB.unitId, recordA.unitId); assert.equal(await owner.warehouseUnit.count(), initialUnits);
    const resolution = await as(b, () => units.resolveWarehouseIdentifier(b, { value: lpn, kind: "lpn" })); assert.equal(resolution.unitId, recordA.unitId); assert.equal(resolution.physicalPresence, "not_determined");
    const detail = await as(b, () => units.getWarehouseUnit(b, { unitId: recordA.unitId! })); assert.equal(detail.identityEvidence, null); assert.equal(detail.reportedRows.length, 1); assert.equal(detail.reportedRows[0].inventoryRecordId, boundB.id); assert.equal(detail.physicalState.basis, "no_physical_observation");
    const exported = await as(b, () => units.exportWarehouseUnitHistory(b, { unitId: recordA.unitId! })); assert.equal(exported.json.includes("PRIVATE-CONSUMER-SOURCE-A"), false); assert.equal(exported.json.includes("PRIVATE-CONSUMER-ORIGIN-A"), false); assert.equal(exported.json.includes("PRIVATE-CONSUMER-NOTE-A"), false); assert.equal(exported.json.includes("PRIVATE-CONSUMER-SOURCE-B"), true);
    assert.equal((await as(b, () => gaps.listWarehouseIdentityGaps(b, { limit: 100 }))).items.some(item => item.lpn === lpn), false);
    assert.equal(await owner.warehouseIdentifier.count({ where: { siteId: sites[1].id, unitId: recordA.unitId!, kind: "lpn", value: lpn } }), 0, "Accepted identity must not clone another site's alias claim");
    const { deriveUnitLabelContext } = await import("../lib/labels/unit-context");
    const label = await as(b, () => prisma.$transaction(tx => deriveUnitLabelContext(tx, { unitId: recordA.unitId! })));
    assert.equal(label.fields.lpn, lpn); assert.equal(label.fields.description, rowB.Description);
    assert.equal(JSON.stringify(label).includes("PRIVATE-CONSUMER-SOURCE-A"), false);
    const conflict = await owner.warehouseUnit.create({ data: { siteId: sites[1].id } });
    await owner.warehouseIdentifier.create({ data: { siteId: sites[1].id, unitId: conflict.id, kind: "lpn", namespace: "wms", value: lpn, rawValue: lpn, evidence: "Synthetic duplicate identity must stay ambiguous" } });
    const ambiguousLabel = await as(b, () => prisma.$transaction(tx => deriveUnitLabelContext(tx, { unitId: recordA.unitId! })));
    assert.equal(ambiguousLabel.fields.lpn, undefined); assert.ok(ambiguousLabel.issues.some(issue => issue.code === "ambiguous_identifier_link"));
  });
  await t.test("MARS identity writers wait for the import gate before locking a physical unit", async () => {
    const item = await fixture("mars-gate-order"), submissions = await import("../lib/mars/submissions");
    let linking!: Promise<Awaited<ReturnType<typeof submissions.linkMarsSubmission>>>;
    await owner.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8100801)`;
      linking = as(a, () => submissions.linkMarsSubmission(a, { operationId: op(), unitId: item.unit.id, requestNumber: `SYNTHETIC-MARS-${ns}`, evidence: "Synthetic human-observed identity only; no upstream call" }));
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await owner.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%') AS waiting`;
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, "The native identity writer reached the held import gate");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='500ms'");
      // The old row→gate order deadlocks a gate holder needing the native FK
      // KEY SHARE lock; gate→row permits this real concurrent DB operation.
      await tx.$queryRaw`SELECT id FROM "WarehouseUnit" WHERE id=${item.unit.id} FOR KEY SHARE`;
    }, { timeout: 10_000 });
    assert.equal((await linking).unitId, item.unit.id);
  });
  await owner.$disconnect(); await prisma.$disconnect();
});
