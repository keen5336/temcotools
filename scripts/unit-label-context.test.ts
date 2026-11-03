import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import type { Principal } from "../lib/auth/principal";
import { builtinMarsLabelSource } from "../lib/payloads/builtin";
import { buildMarsLabelBookmarklet, MARS_LABEL_PAYLOAD_ID } from "../lib/mars-label-bookmarklet";
import { businessDay } from "../lib/office/domain";
import { expandDispatchLines } from "../lib/dispatch/model";
import { LabelError } from "../lib/labels/model";

test("MARS stable helper exports reviewed field hints without printer configuration, cookies or external-page printing", () => {
  const bookmark = buildMarsLabelBookmarklet("https://temco.invalid"); assert.ok(bookmark.includes("/api/payloads/mars-label-helper/loader")); assert.ok(!bookmark.includes("endpoint") && !bookmark.includes("template") && !bookmark.includes("^XA"));
  const opened: string[] = [], appended: unknown[] = [], alerts: string[] = [];
  const document = { body: { innerText: "Order #\nORDER-DEMO\nVendor\nSynthetic vendor\nSerial #\nSERIAL-DEMO\nSubmission #\n770000001\nDate Submitted\n2026-10-31", appendChild: (node: unknown) => appended.push(node) }, getElementById: () => null, createElement: () => ({ style: {} }) };
  Object.defineProperty(document, "cookie", { get() { throw new Error("The helper must not read cookies."); } });
  const window = { location: { href: "https://delivery-management.homedepot.com/mars/return-submissions/detail/770000001", origin: "https://delivery-management.homedepot.com", pathname: "/mars/return-submissions/detail/770000001" }, open: (url: string) => opened.push(url), alert: (value: string) => alerts.push(value), fetch: () => { throw new Error("No printer or upstream fetch is permitted."); } };
  new Script(builtinMarsLabelSource("https://temco.invalid").source).runInNewContext({ window, document });
  assert.equal(opened.length, 1); assert.equal(appended.length, 1); const payload = JSON.parse(decodeURIComponent(opened[0].split("#mars-fields=")[1])); assert.equal(payload.fields.submissionNumber, "770000001"); assert.equal(payload.fields.serialNumber, "SERIAL-DEMO"); assert.equal(payload.printerId, undefined); assert.equal(payload.templateId, undefined);
  window.location.href = "https://unapproved.invalid/page"; new Script(builtinMarsLabelSource("https://temco.invalid").source).runInNewContext({ window, document }); assert.equal(opened.length, 1); assert.equal(alerts.length, 1);
});

test("authoritative unit labels preserve A/B, relevant freshness, exact allocation and unknown-no-replay", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!); assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated synthetic DB required.");
  const [{ prisma }, context, workflows, effects, devices, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/labels/unit-context"), import("../lib/labels/workflows"), import("../lib/labels/issuance"), import("../lib/labels/devices"), import("../lib/auth/principal")]);
  assert.equal(await prisma.labelWorkflow.count({ where: { purpose: "unit_identity" } }), 0, "Do not overwrite another workflow fixture.");
  const suffix = randomUUID(), unitIds: string[] = [], boardIds: string[] = [], waveIds: string[] = [];
  let userId = "", bundleId = "", printerId = "", importId = "", marsId = "", exchangeId = "", workflowCreated = false, payloadCreated = false;
  const now = new Date(), day = businessDay(now), tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), scope = `unit-label-${suffix}`;
  try {
    const bundle = await prisma.roleBundle.create({ data: { name: `Unit labels ${suffix}`, capabilities: ["inventory.read", "inventory.write", "workflow.read", "labels.read", "labels.print", "labels.manage", "payloads.manage"] } }); bundleId = bundle.id;
    const user = await prisma.user.create({ data: { username: `unit-label-${suffix}`, displayName: "Synthetic label operator", role: "admin", pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId: bundle.id } } } }); userId = user.id;
    const session = await prisma.userSession.create({ data: { id: randomUUID(), userId, authVersion: user.authVersion, lastActivityAt: now, lastStrongAuthenticatedAt: now, mfaVerifiedAt: now, expiresAt: new Date(now.getTime() + 3_600_000), deviceLabel: "Synthetic unit label test" } });
    const resolved = await resolvePrincipal({ userId, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(resolved); const principal: Principal = { ...resolved, sessionId: session.id, strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
    for (const role of ["A", "B"]) { const unit = await prisma.warehouseUnit.create({ data: { creationEvidence: `Synthetic separate appliance ${role}` } }); unitIds.push(unit.id); await prisma.warehouseIdentifier.create({ data: { unitId: unit.id, kind: "lpn", namespace: "wms", value: `LPN-${suffix}-${role}`.toUpperCase(), rawValue: `LPN-${suffix}-${role}`, evidence: "Synthetic exact physical alias", createdByUserId: userId } }); }
    const [a, b] = unitIds, lpn = `LPN-${suffix}-B`.toUpperCase();
    const rowData = { lpn, status: "Placing", orderNumber: "ORDER-DEMO-SHARED", vendor: "Synthetic vendor", receivedDate: day, description: "Synthetic replacement B", customerName: "Synthetic recipient", sourceData: { tracking: "MUST-NOT-BECOME-MSN", Customer: "MUST-NOT-BECOME-CONTACT" }, contentHash: suffix, unitId: b };
    const row = await prisma.inventoryAuditItem.create({ data: rowData });
    const revision = await prisma.inventorySourceRevision.create({ data: { inventoryItemId: row.id, revision: 1, lpn, status: row.status, orderNumber: row.orderNumber, vendor: row.vendor, receivedDate: row.receivedDate, description: row.description, customerName: row.customerName, sourceData: rowData.sourceData, contentHash: row.contentHash } });
    const batch = await prisma.inventoryAuditImport.create({ data: { filename: "synthetic-unit-labels.csv", uploadedByName: "Synthetic operator", rowCount: 1, insertedCount: 1, changedCount: 0, unchangedCount: 0, duplicateCount: 0, blankCount: 0, scope, coverage: "complete", sourceAsOf: now } }); importId = batch.id;
    await prisma.inventoryImportMembership.create({ data: { importId, sourceRevisionId: revision.id, lpn } });
    const exchange = await prisma.officeExchange.create({ data: { originalUnitId: a, replacementUnitId: b, orderReference: "ORDER-DEMO-SHARED", evidence: "Synthetic A remains with customer if exchange misses", createdByUserId: userId } }); exchangeId = exchange.id;
    const attempt = await prisma.officeExchangeAttempt.create({ data: { exchangeId, outcome: "missed", occurredAt: new Date(now.getTime() - 86_400_000), sourceAsOf: new Date(now.getTime() - 86_400_000), evidence: "Synthetic customer not home", recordedByUserId: userId } });
    await prisma.officeReturnExpectation.createMany({ data: [{ unitId: a, exchangeId, sourceAttemptId: attempt.id, kind: "original_exchange_return", status: "deferred", condition: "successful_exchange", evidence: "Original remains with customer; obligation remains deferred", createdByUserId: userId }, { unitId: b, exchangeId, sourceAttemptId: attempt.id, kind: "replacement_failed_attempt_return", status: "expected", condition: "none", activatedAt: attempt.occurredAt, expectedAt: attempt.occurredAt, evidence: "Replacement expected back for reschedule", createdByUserId: userId }] });
    await prisma.officeDisposition.create({ data: { unitId: a, kind: "conditional_rtv", reason: "Synthetic original-only future instruction", instruction: "RTV ORIGINAL A ONLY", decidedByUserId: userId, authorizedByUserId: userId, authorizedAt: now, triggerAt: new Date(now.getTime() + 5 * 86_400_000), expiresAt: new Date(now.getTime() + 7 * 86_400_000) } });
    const disposition = await prisma.officeDisposition.create({ data: { unitId: b, kind: "reschedule", reason: "Synthetic replacement instruction", instruction: "KEEP REPLACEMENT B FOR ITS NEXT ROUTE", decidedByUserId: userId } });
    const observation = await prisma.warehousePhysicalObservation.create({ data: { userId, eventId: randomUUID(), fingerprint: suffix, rawIdentifier: lpn, identifierType: "lpn", type: "check_in", capturedAt: new Date(now.getTime() - 60_000), captureMethod: "scanner", unitId: b, resolution: "resolved", candidateUnitIds: [b] } });
    const schedule = await prisma.officeScheduleFact.create({ data: { unitId: b, deliveryDate: day, complete: true, sourceAsOf: new Date(now.getTime() - 30_000), sourceRef: "synthetic-office", evidence: "Synthetic current manual statement", recordedByUserId: userId } });
    const mars = await prisma.marsUnit.create({ data: { requestNumber: `MARS-DEMO-${suffix}`, orderNumber: "ORDER-DEMO-SHARED", serialNumber: "SERIAL-DEMO-ORIGINAL", vendor: "Synthetic vendor", requestStatus: "Submitted", returnStatus: "Pending", lastImportedAt: now } }); marsId = mars.id;
    await prisma.warehouseIdentifier.create({ data: { unitId: a, kind: "submission", namespace: "mars", value: mars.requestNumber.toUpperCase(), rawValue: mars.requestNumber, evidence: "Synthetic explicit original submission link" } });
    async function dispatch(date: string, route: string, lane: string) {
      const board = await prisma.dispatchBoard.create({ data: { day: date, scope: `${scope}-${route}` } }); boardIds.push(board.id);
      const slots = expandDispatchLines([{ lineKey: "line", quantity: 1, lane, route, orderReference: "ORDER-DEMO-SHARED", description: "Synthetic replacement demand", partNumber: "PART-DEMO", expectedUnits: [{ unitId: b, identifiers: [] }] }]);
      const snapshot = await prisma.dispatchSnapshot.create({ data: { boardId: board.id, version: 1, sourceKind: "manual_reviewed", sourceAsOf: now, sourceRef: "synthetic-reviewed-dispatch", coverage: "complete", note: "Synthetic manual demand; not qualified official DMP finals", slots, status: "approved", approvedByUserId: userId, approvedAt: now, createdByUserId: userId } });
      await prisma.dispatchBoard.update({ where: { id: board.id }, data: { headSnapshotId: snapshot.id, nextVersion: 2 } });
      const allocation = await prisma.dispatchAllocation.create({ data: { snapshotId: snapshot.id, slotKey: slots[0].slotKey, unitId: b, matchEvidence: {}, createdByUserId: userId } });
      await prisma.dispatchReservation.upsert({ where: { unitId: b }, create: { unitId: b, allocationId: allocation.id, boardId: board.id, snapshotId: snapshot.id }, update: { allocationId: allocation.id, boardId: board.id, snapshotId: snapshot.id } }); return { board, snapshot, allocation };
    }
    await dispatch(day, "ROUTE-DEMO-1", "LANE-DEMO-1");
    const before = await context.getUnitLabelContext(principal, { unitId: b, wmsScope: scope }); assert.equal(before.fields.msn, undefined); assert.equal(before.fields.contact, undefined); assert.equal(before.fields.trackingNumber, undefined); assert.ok(!before.fields.instructions?.includes("RTV ORIGINAL")); assert.equal(before.mars.submissions.length, 0); assert.equal(before.office.exchanges[0].unitRole, "replacement"); assert.equal(before.office.returnExpectations[0].qualifyingCheckIn?.id, observation.id);
    const original = await context.getUnitLabelContext(principal, { unitId: a, wmsScope: scope }); assert.equal(original.office.returnExpectations[0].status, "deferred"); assert.equal(original.physical.warehouseEvidence, false); assert.equal(original.mars.submissions[0].id, marsId); assert.equal(original.fields.serialNumber, "SERIAL-DEMO-ORIGINAL"); assert.equal(before.fields.serialNumber, undefined);
    const saved = await workflows.saveLabelWorkflow(principal, { purpose: "unit_identity", name: "Synthetic unit handling", zpl: "^XA^FD{{lpn}} {{deliveryDate}} {{routeNumber}} {{instructions}}^FS^XZ", requiredFields: ["lpn"], rules: [{ id: "default", name: "Synthetic observed unit label", class: "default", priority: 1, enabled: true, automatic: true, conditions: [] }], widthMm: 102, heightMm: 76, dpi: 203, expectedRevision: 0, note: "Synthetic source-independent label" }); workflowCreated = true;
    await workflows.publishLabelWorkflow(principal, { purpose: "unit_identity", expectedRevision: saved.revision, note: "Synthetic publication" });
    const printer = await prisma.labelPrinter.create({ data: { name: `Unit context fixture ${suffix}`, endpoint: "http://printer.invalid:9100" } }); printerId = printer.id;
    const device = await devices.registerPrintingDevice(principal, { deviceId: randomUUID(), name: "Synthetic direct device", mode: "direct", printerIds: [printerId] });
    const input = { operationId: randomUUID(), unitId: b, wmsScope: scope, purpose: "unit_identity", printerId, mode: "direct", deviceId: device.device.id, automatic: true, observationId: observation.id };
    const limited: Principal = { ...principal, capabilities: ["labels.read", "labels.print"] };
    await assert.rejects(context.getUnitLabelContext(limited, { unitId: b, wmsScope: scope }));
    await assert.rejects(context.evaluateUnitLabels(limited, { unitId: b, wmsScope: scope }), "Label-only scopes cannot read office or inventory fields through label evaluation.");
    await assert.rejects(context.prepareUnitLabel(limited, input), "Unit printing cannot read source context through a narrower delegated scope.");
    const { listApplicationActions } = await import("../lib/application/actions");
    assert.equal(listApplicationActions(limited, { prefix: "labels.unit." }).length, 0);
    assert.ok(!listApplicationActions({ ...principal, capabilities: ["inventory.read"] }, { prefix: "warehouse.unit.context" }).length);
    const delegatedGrant = await prisma.appAccessGrant.create({ data: { userId, sessionId: session.id, authVersion: principal.authVersion, tokenHash: `synthetic-source-scope-${suffix}`, clientName: "Synthetic unit-print source scope", scopes: ["labels.print", "inventory.read", "workflow.read"], expiresAt: new Date(now.getTime() + 60_000) } });
    const delegated: Principal = { ...principal, grantId: delegatedGrant.id, capabilities: ["labels.print", "inventory.read", "workflow.read"] };
    const delegatedIntent = await context.prepareUnitLabel(delegated, { ...input, operationId: randomUUID() });
    await prisma.appAccessGrant.update({ where: { id: delegatedGrant.id }, data: { scopes: ["labels.print", "inventory.read"] } });
    const revokedSource = await effects.claimLabelDispatch(principal, { issuanceId: delegatedIntent.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken });
    assert.equal(revokedSource.dispatch, false); assert.equal("issuance" in revokedSource && revokedSource.issuance.state, "not_sent", "Queued actual dispatch rechecks source scopes even when labels.print remains granted.");
    // These are the same canonical actions used by MCP; the HTTP evaluation
    // route parses the identical schema. Caller A fields never bind unit B.
    const { executeApplicationAction } = await import("../lib/application/actions");
    const forgedFields = { lpn: "LPN-DEMO-A", instructions: "FORGED ORIGINAL A", deliveryDate: "2099-01-01", routeNumber: "FORGED-ROUTE-A", hold: "false", identityResolved: "true" };
    const evaluation = await executeApplicationAction(principal, "labels.evaluate", { purpose: input.purpose, unitId: b, wmsScope: scope, fields: forgedFields }) as Awaited<ReturnType<typeof workflows.evaluateLabel>>;
    assert.equal(evaluation.context.unitId, b); assert.equal(evaluation.context.fields.lpn, before.fields.lpn); assert.equal(evaluation.context.wmsScope, scope);
    assert.ok(!JSON.stringify(evaluation.context.fields).includes("FORGED"));
    await assert.rejects(effects.prepareLabelIssuance(limited, { ...input, operationId: randomUUID(), fields: forgedFields }), /permission/);
    await assert.rejects(effects.prepareLabelIssuance(principal, { ...input, operationId: randomUUID(), observationId: undefined, fields: forgedFields }), /qualifying physical observation/);
    await assert.rejects(effects.prepareLabelIssuance(principal, { ...input, operationId: randomUUID(), unitId: a, fields: forgedFields }), /qualifying physical observation/);
    await assert.rejects(effects.prepareLabelIssuance(principal, { ...input, operationId: randomUUID(), fields: forgedFields, trustedContext: { unitId: b, fields: forgedFields } }), /unrecognized/i);
    const genericInput = { ...input, operationId: randomUUID(), fields: forgedFields };
    const generic = await executeApplicationAction(principal, "labels.prepare", genericInput) as Awaited<ReturnType<typeof effects.prepareLabelIssuance>>;
    const genericRow = await prisma.labelIssuance.findUniqueOrThrow({ where: { id: generic.issuance.id } });
    assert.ok(genericRow.renderedZpl.includes(before.fields.lpn!)); assert.ok(!genericRow.renderedZpl.includes("FORGED") && !genericRow.renderedZpl.includes("LPN-DEMO-A"));
    const genericBinding = await prisma.labelIssuanceEvent.findFirstOrThrow({ where: { issuanceId: genericRow.id, action: "unit_context_bound" } });
    assert.equal(JSON.parse(genericBinding.note).wmsScope, scope);
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { instruction: "REPLACEMENT B GENERIC QUEUE CHANGED" } });
    const genericClaim = await effects.claimLabelDispatch(principal, { issuanceId: genericRow.id, deviceId: device.device.id, deviceToken: device.deviceToken }); assert.equal(genericClaim.dispatch, false);
    assert.equal((await effects.prepareLabelIssuance(principal, genericInput)).issuance.id, genericRow.id, "Same operation returns its original receipt after context changes; it never emits a replacement.");
    const unbound = await effects.prepareLabelIssuance(principal, { ...genericInput, operationId: randomUUID() });
    await prisma.labelIssuanceEvent.deleteMany({ where: { issuanceId: unbound.issuance.id, action: "unit_context_bound" } });
    assert.equal((await effects.claimLabelDispatch(principal, { issuanceId: unbound.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken })).dispatch, false, "An old unbound operational intent must not dispatch");
    await assert.rejects(context.prepareUnitLabel(principal, { ...input, fields: { deliveryDate: "2099-01-01" } }));
    const first = await context.prepareUnitLabel(principal, input); await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { instruction: "REPLACEMENT B UPDATED HANDLING" } });
    const claim = (id: string) => effects.claimLabelDispatch(principal, { issuanceId: id, deviceId: device.device.id, deviceToken: device.deviceToken });
    const stale = await claim(first.issuance.id); assert.equal(stale.dispatch, false); assert.equal("issuance" in stale && stale.issuance.state, "not_sent");
    const current = await context.prepareUnitLabel(principal, { ...input, operationId: randomUUID() }), dispatched = await claim(current.issuance.id); assert.ok(dispatched.dispatch);
    await effects.reportLabelDelivery(principal, { issuanceId: current.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken, reportToken: dispatched.reportToken, status: "sent_unconfirmed", note: "Synthetic transport only; no actual printer" });
    await prisma.inventoryAuditItem.update({ where: { id: row.id }, data: { sourceData: { irrelevantChanged: true } } });
    await prisma.warehousePhysicalObservation.create({ data: { userId, eventId: randomUUID(), fingerprint: `${suffix}-repeat`, rawIdentifier: lpn, identifierType: "lpn", type: "presence", capturedAt: new Date(), captureMethod: "scanner", unitId: b, resolution: "resolved", candidateUnitIds: [b] } });
    assert.equal((await context.evaluateUnitLabels(principal, { unitId: b, wmsScope: scope })).labels.find(item => item.purpose === "unit_identity")?.due, false);
    const dedupInput = { ...input, operationId: randomUUID() }, dedup = await context.prepareUnitLabel(principal, dedupInput); assert.equal(dedup.created, false); assert.equal(dedup.issuance.id, current.issuance.id);
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { instruction: "REPLACEMENT B THIRD INSTRUCTION" } }); assert.equal((await context.prepareUnitLabel(principal, dedupInput)).issuance.id, current.issuance.id, "Same-event retry returns its original receipt after source changes.");
    const routePending = await context.prepareUnitLabel(principal, { ...input, operationId: randomUUID() }); await dispatch(day, "ROUTE-DEMO-2", "LANE-DEMO-2"); assert.equal((await claim(routePending.issuance.id)).dispatch, false);
    const uncertain = await context.prepareUnitLabel(principal, { ...input, operationId: randomUUID() }), uncertainClaim = await claim(uncertain.issuance.id); assert.ok(uncertainClaim.dispatch);
    await effects.reportLabelDelivery(principal, { issuanceId: uncertain.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken, reportToken: uncertainClaim.reportToken, status: "unknown", note: "Synthetic uncertain result" });
    await assert.rejects(context.prepareUnitLabel(principal, { ...input, operationId: randomUUID() }), (error: unknown) => error instanceof LabelError && error.code === "unknown_effect");
    const snapshotReprint = await effects.reprintLabelIssuance(principal, { operationId: randomUUID(), issuanceId: uncertain.issuance.id, mode: "direct", deviceId: device.device.id, reason: "Synthetic inspected original snapshot requested explicitly" });
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { instruction: "REPLACEMENT B AFTER ORIGINAL SNAPSHOT" } });
    const originalSnapshot = await prisma.labelIssuance.findUniqueOrThrow({ where: { id: uncertain.issuance.id } });
    const reprintClaim = await claim(snapshotReprint.issuance.id); assert.ok(reprintClaim.dispatch); assert.equal(reprintClaim.zpl, originalSnapshot.renderedZpl, "Explicit reprints intentionally preserve the inspected original content");
    await effects.reportLabelDelivery(principal, { issuanceId: snapshotReprint.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken, reportToken: reprintClaim.reportToken, status: "not_sent", note: "Synthetic receipt only; no external printer request" });
    await effects.reconcileLabelIssuance(principal, { issuanceId: uncertain.issuance.id, outcome: "not_printed", reason: "Synthetic fixture confirms no actual device action" });
    await prisma.officeScheduleFact.update({ where: { id: schedule.id }, data: { nextDeliveryDate: tomorrow, sourceAsOf: new Date(now.getTime() + 1000) } });
    const conflict = await context.getUnitLabelContext(principal, { unitId: b, wmsScope: scope }); assert.equal(conflict.fields.hold, "true"); assert.equal(conflict.fields.deliveryDate, tomorrow); assert.equal(conflict.fields.routeNumber, undefined);
    const future = await dispatch(tomorrow, "ROUTE-DEMO-FUTURE", "LANE-DEMO-FUTURE"); await prisma.dispatchSnapshot.update({ where: { id: future.snapshot.id }, data: { sourceAsOf: new Date(now.getTime() + 2000) } });
    const wave = await prisma.pickWave.create({ data: { name: "Synthetic future bound wave", sourceFilename: "synthetic-reviewed" } }); waveIds.push(wave.id); const item = await prisma.pickWaveItem.create({ data: { pickWaveId: wave.id, rowNumber: 2, lpn } });
    await prisma.dispatchWaveItem.create({ data: { allocationId: future.allocation.id, pickWaveId: wave.id, pickWaveItemId: item.id, unitId: b, snapshotId: future.snapshot.id } });
    const bound = await context.prepareUnitLabel(principal, { ...input, operationId: randomUUID(), pickWaveItemId: item.id }); const queued = await prisma.labelIssuance.findUniqueOrThrow({ where: { id: bound.issuance.id } }); assert.ok(queued.renderedZpl.includes(tomorrow) && queued.renderedZpl.includes("ROUTE-DEMO-FUTURE"));
    await prisma.pickWave.update({ where: { id: wave.id }, data: { archivedAt: new Date() } }); assert.equal((await claim(bound.issuance.id)).dispatch, false);
    const payloads = await import("../lib/payloads/service"), { loadPublishedPayload } = await import("../lib/payloads/loader");
    assert.equal(await prisma.payload.count({ where: { id: MARS_LABEL_PAYLOAD_ID } }), 0, "Preserve any existing managed MARS helper fixture.");
    const loaderRequest = new Request("https://temco.invalid/api/payloads/mars-label-helper/loader"), builtinResponse = await loadPublishedPayload(loaderRequest, MARS_LABEL_PAYLOAD_ID); assert.equal(builtinResponse.status, 200); assert.ok((await builtinResponse.text()).includes("#mars-fields="));
    const payload = await payloads.createPayload(principal, { id: MARS_LABEL_PAYLOAD_ID, name: "Synthetic managed MARS helper", purpose: "mars_label_helper", targetOrigins: ["https://delivery-management.homedepot.com"], source: 'document.body.dataset.synthetic="managed";', protocolVersion: 1, operationNames: [], note: "Synthetic central helper source" }); payloadCreated = true;
    const published = await payloads.publishPayload(principal, { id: payload.id, expectedRevision: payload.revision, note: "Synthetic managed publication", reviewedNoSecrets: true });
    const pointer = await loadPublishedPayload(loaderRequest, MARS_LABEL_PAYLOAD_ID); assert.equal(pointer.headers.get("Cache-Control"), "no-store"); assert.ok((await pointer.text()).includes(`/versions/${published.published.id}/${published.published.contentHash}`));
    await payloads.setPayloadEnabled(principal, { id: payload.id, expectedRevision: published.payload.revision, enabled: false, note: "Synthetic disable must not fall back to built-in source" }); assert.equal((await loadPublishedPayload(loaderRequest, MARS_LABEL_PAYLOAD_ID)).status, 404);
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }); await assert.rejects(context.prepareUnitLabel(principal, { ...input, operationId: randomUUID(), automatic: false }));
  } finally {
    if (payloadCreated) { await prisma.payload.update({ where: { id: MARS_LABEL_PAYLOAD_ID }, data: { publishedVersionId: null } }); await prisma.payloadAudit.deleteMany({ where: { payloadId: MARS_LABEL_PAYLOAD_ID } }); await prisma.payloadVersion.deleteMany({ where: { payloadId: MARS_LABEL_PAYLOAD_ID } }); await prisma.payload.delete({ where: { id: MARS_LABEL_PAYLOAD_ID } }); }
    const issuances = await prisma.labelIssuance.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } }); await prisma.labelIssuanceEvent.deleteMany({ where: { issuanceId: { in: issuances.map(item => item.id) } } }); await prisma.labelIssuance.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.printingDevice.deleteMany({ where: { userId } });
    if (workflowCreated) { await prisma.labelWorkflow.updateMany({ where: { purpose: "unit_identity" }, data: { publishedVersionId: null } }); await prisma.labelWorkflowAudit.deleteMany({ where: { purpose: "unit_identity" } }); await prisma.labelWorkflowVersion.deleteMany({ where: { purpose: "unit_identity" } }); await prisma.labelWorkflow.deleteMany({ where: { purpose: "unit_identity" } }); }
    await prisma.dispatchWaveItem.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.pickWave.deleteMany({ where: { id: { in: waveIds } } }); await prisma.dispatchReservation.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.dispatchAllocation.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.dispatchBoard.updateMany({ where: { id: { in: boardIds } }, data: { headSnapshotId: null } }); await prisma.dispatchSnapshot.deleteMany({ where: { boardId: { in: boardIds } } }); await prisma.dispatchBoard.deleteMany({ where: { id: { in: boardIds } } });
    await prisma.officeReturnExpectation.deleteMany({ where: { unitId: { in: unitIds } } }); if (exchangeId) { await prisma.officeExchangeAttempt.deleteMany({ where: { exchangeId } }); await prisma.officeExchange.delete({ where: { id: exchangeId } }); } await prisma.officeDisposition.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.officeScheduleFact.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.warehousePhysicalObservation.deleteMany({ where: { unitId: { in: unitIds } } });
    await prisma.inventoryImportMembership.deleteMany({ where: { importId } }); await prisma.inventorySourceRevision.deleteMany({ where: { inventoryItem: { unitId: { in: unitIds } } } }); await prisma.inventoryAuditItem.deleteMany({ where: { unitId: { in: unitIds } } }); if (importId) await prisma.inventoryAuditImport.delete({ where: { id: importId } }); await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: unitIds } } }); if (marsId) await prisma.marsUnit.delete({ where: { id: marsId } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: unitIds } } });
    if (printerId) await prisma.labelPrinter.delete({ where: { id: printerId } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: userId } }); if (userId) await prisma.user.delete({ where: { id: userId } }); if (bundleId) await prisma.roleBundle.delete({ where: { id: bundleId } }); await prisma.$disconnect();
  }
});

test("executed exact-unit RTV placement retains pending submission-label instructions without applying them to its replacement", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!); assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated synthetic DB required.");
  const [{ prisma }, context, workflows, effects, devices, office, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/labels/unit-context"), import("../lib/labels/workflows"), import("../lib/labels/issuance"), import("../lib/labels/devices"), import("../lib/office/service"), import("../lib/auth/principal")]);
  const suffix = randomUUID(), unitIds: string[] = [], purpose = "rtv_submission";
  let userId = "", bundleId = "", printerId = "", marsId = "", exchangeId = "", workflowCreated = false;
  try {
    assert.equal(await prisma.labelWorkflow.count({ where: { purpose } }), 0, "Preserve an existing RTV workflow fixture.");
    const bundle = await prisma.roleBundle.create({ data: { name: `Executed RTV labels ${suffix}`, capabilities: ["inventory.read", "workflow.read", "workflow.execute", "labels.read", "labels.print", "labels.manage"] } }); bundleId = bundle.id;
    const user = await prisma.user.create({ data: { username: `executed-rtv-${suffix}`, displayName: "Synthetic RTV operator", role: "admin", pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId } } } }); userId = user.id;
    const now = new Date(), session = await prisma.userSession.create({ data: { id: randomUUID(), userId, authVersion: user.authVersion, lastActivityAt: now, lastStrongAuthenticatedAt: now, mfaVerifiedAt: now, expiresAt: new Date(now.getTime() + 3_600_000), deviceLabel: "Synthetic executed RTV test" } });
    const resolved = await resolvePrincipal({ userId, authVersion: user.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT })); assert.ok(resolved);
    const principal: Principal = { ...resolved, sessionId: session.id, strongAuthenticatedAt: now.getTime(), mfaVerifiedAt: now.getTime() };
    for (const role of ["A", "B"]) { const unit = await prisma.warehouseUnit.create({ data: { creationEvidence: `Synthetic executed RTV ${role}` } }); unitIds.push(unit.id); const lpn = `RTV-${suffix}-${role}`.toUpperCase(); await prisma.warehouseIdentifier.create({ data: { unitId: unit.id, kind: "lpn", namespace: "wms", value: lpn, rawValue: lpn, evidence: "Synthetic exact alias" } }); }
    const [a, b] = unitIds;
    const exchange = await prisma.officeExchange.create({ data: { originalUnitId: a, replacementUnitId: b, orderReference: "SYNTHETIC-SHARED-ORDER", evidence: "Separate original and replacement", createdByUserId: userId } }); exchangeId = exchange.id;
    const mars = await prisma.marsUnit.create({ data: { requestNumber: `RTV-SUB-${suffix}`, orderNumber: "SYNTHETIC-SHARED-ORDER", requestStatus: "Submitted", returnStatus: "Pending" } }); marsId = mars.id;
    await prisma.warehouseIdentifier.create({ data: { unitId: a, kind: "submission", namespace: "mars", value: mars.requestNumber.toUpperCase(), rawValue: mars.requestNumber, evidence: "Synthetic exact original submission" } });
    const placedAt = new Date(now.getTime() - 60_000), placement = await prisma.warehousePhysicalObservation.create({ data: { userId, eventId: randomUUID(), fingerprint: randomUUID(), rawIdentifier: `RTV-${suffix}-A`, identifierType: "lpn", type: "placement", captureMethod: "scanner", capturedAt: placedAt, unitId: a, resolution: "resolved", candidateUnitIds: [a], location: "RTV-A" } });
    const disposition = await prisma.officeDisposition.create({ data: { unitId: a, kind: "conditional_rtv", status: "triggered", reason: "Synthetic original authorized return", instruction: "RTV ORIGINAL A: SUBMISSION AND PICKUP REMAIN PENDING", decidedByUserId: userId, authorizedByUserId: userId, authorizedAt: new Date(now.getTime() - 180_000), triggerAt: new Date(now.getTime() - 120_000), triggeredAt: placedAt, triggeredByObservationId: placement.id, targetLocation: "RTV-A", expiresAt: new Date(now.getTime() + 3_600_000) } });
    await office.recordOfficeDispositionExecution(principal, { operationId: randomUUID(), dispositionId: disposition.id, observationId: placement.id, evidence: "Synthetic actual placement confirmation only; no external operation" });
    assert.equal((await prisma.officeDisposition.findUniqueOrThrow({ where: { id: disposition.id } })).status, "executed");
    const original = await context.getUnitLabelContext(principal, { unitId: a }), replacement = await context.getUnitLabelContext(principal, { unitId: b });
    assert.equal(original.fields.instructions, disposition.instruction); assert.ok(!replacement.fields.instructions?.includes("RTV ORIGINAL A")); assert.equal(replacement.fields.submissionNumber, undefined);
    const saved = await workflows.saveLabelWorkflow(principal, { purpose, name: "Synthetic post-placement RTV label", zpl: "^XA^FD{{lpn}} {{instructions}}^FS^BCN,80,Y,N,N^FD{{submissionNumber}}^FS^XZ", requiredFields: ["lpn", "submissionNumber"], rules: [], widthMm: 102, heightMm: 76, dpi: 203, expectedRevision: 0, note: "Synthetic exact-unit pending RTV" }); workflowCreated = true;
    await workflows.publishLabelWorkflow(principal, { purpose, expectedRevision: saved.revision, note: "Synthetic label qualification" });
    const printer = await prisma.labelPrinter.create({ data: { name: `Synthetic executed RTV ${suffix}`, endpoint: "http://printer.invalid:9100" } }); printerId = printer.id;
    const device = await devices.registerPrintingDevice(principal, { deviceId: randomUUID(), name: "Synthetic RTV device", mode: "direct", printerIds: [printerId] });
    const prepare = { operationId: randomUUID(), unitId: a, purpose, printerId, mode: "direct", deviceId: device.device.id, automatic: false };
    const pending = await context.prepareUnitLabel(principal, prepare), queued = await prisma.labelIssuance.findUniqueOrThrow({ where: { id: pending.issuance.id } });
    assert.ok(queued.renderedZpl.includes(disposition.instruction) && queued.renderedZpl.includes(mars.requestNumber));
    await assert.rejects(context.prepareUnitLabel(principal, { ...prepare, operationId: randomUUID(), unitId: b }), /submissionNumber/);
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { revokedAt: new Date(), status: "revoked" } });
    assert.equal((await context.getUnitLabelContext(principal, { unitId: a })).fields.instructions, undefined);
    const stale = await effects.claimLabelDispatch(principal, { issuanceId: pending.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken }); assert.equal(stale.dispatch, false, "Revoked instructions cannot dispatch a queued old label.");
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { revokedAt: null, status: "executed", kind: "rtv", expiresAt: new Date(now.getTime() + 3_600_000) } });
    assert.equal((await context.getUnitLabelContext(principal, { unitId: a })).fields.instructions, disposition.instruction, "Executed direct RTV instructions remain current too.");
    await prisma.officeDisposition.update({ where: { id: disposition.id }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    assert.equal((await context.getUnitLabelContext(principal, { unitId: a })).fields.instructions, undefined, "Expired execution instructions are not current label content.");
  } finally {
    const issuances = await prisma.labelIssuance.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } }); await prisma.labelIssuanceEvent.deleteMany({ where: { issuanceId: { in: issuances.map(item => item.id) } } }); await prisma.labelIssuance.deleteMany({ where: { unitId: { in: unitIds } } }); if (userId) await prisma.printingDevice.deleteMany({ where: { userId } });
    if (workflowCreated) { await prisma.labelWorkflow.updateMany({ where: { purpose }, data: { publishedVersionId: null } }); await prisma.labelWorkflowAudit.deleteMany({ where: { purpose } }); await prisma.labelWorkflowVersion.deleteMany({ where: { purpose } }); await prisma.labelWorkflow.deleteMany({ where: { purpose } }); }
    await prisma.officeDispositionExecution.deleteMany({ where: { disposition: { unitId: { in: unitIds } } } }); await prisma.officeDisposition.deleteMany({ where: { unitId: { in: unitIds } } }); await prisma.warehousePhysicalObservation.deleteMany({ where: { unitId: { in: unitIds } } }); if (exchangeId) await prisma.officeExchange.delete({ where: { id: exchangeId } }); await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: unitIds } } }); if (marsId) await prisma.marsUnit.delete({ where: { id: marsId } }); await prisma.warehouseUnit.deleteMany({ where: { id: { in: unitIds } } });
    if (printerId) await prisma.labelPrinter.delete({ where: { id: printerId } }); if (userId) { await prisma.officeCommandReceipt.deleteMany({ where: { userId } }); await prisma.identityAudit.deleteMany({ where: { actorUserId: userId } }); await prisma.user.delete({ where: { id: userId } }); } if (bundleId) await prisma.roleBundle.delete({ where: { id: bundleId } }); await prisma.$disconnect();
  }
});
