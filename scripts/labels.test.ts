import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Principal } from "../lib/auth/principal";
import { evaluateLabelRules, fingerprint, LabelError, matchesApprovedLegacyTemplate, renderLabelVersion, validateLabelDraft } from "../lib/labels/model";
import { DEFAULT_TEMPLATE_ZPL } from "../app/tools/rtv-label/marsLabelShared";
import type { LabelDraft, LabelRule } from "../lib/labels/types";

const draft: LabelDraft = { purpose: "put_away", name: "Synthetic handling", zpl: "^XA\n^FO10,10^FD{{lpn}}^FS\n^FO10,60^FD{{deliveryDate}}^FS\n^FO10,110^FD{{routeNumber}}^FS\n^FO10,160^FD{{instructions}}^FS\n^XZ", requiredFields: ["lpn"], rules: [{ id: "default", name: "Current dispatch handling", class: "dispatch", priority: 100, enabled: true, automatic: true, conditions: [] }], widthMm: 102, heightMm: 76, dpi: 203 };
const fields = { lpn: "LPN-DEMO-A", deliveryDate: "2026-11-02", routeNumber: "ROUTE-DEMO", instructions: "Synthetic instruction", identityResolved: "true" };

test("label fingerprints follow rendered date/route/instructions/version, not unrelated source fields or scans", () => {
  const version = { ...draft, id: "version-one" };
  const first = renderLabelVersion(version, fields);
  assert.equal(first.contentFingerprint, renderLabelVersion(version, { ...fields, receivedDate: "changed-but-not-rendered", sourceColumn: "irrelevant", lastPhysicallySeen: "later" }).contentFingerprint);
  for (const change of [{ deliveryDate: "2026-11-03" }, { routeNumber: "OTHER" }, { instructions: "Office handling changed" }]) assert.notEqual(first.contentFingerprint, renderLabelVersion(version, { ...fields, ...change }).contentFingerprint);
  assert.notEqual(first.contentFingerprint, renderLabelVersion({ ...version, id: "version-two" }, fields).contentFingerprint);
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});

test("label rules use hold/disposition/dispatch/default precedence and do not create workflow authority", () => {
  const rules: LabelRule[] = [
    { ...draft.rules[0], id: "dispatch", priority: 1000 },
    { ...draft.rules[0], id: "office", name: "Office handling", class: "unit_disposition", priority: 1, automatic: false, conditions: [{ field: "disposition", operator: "not_empty" }] },
  ];
  assert.equal(evaluateLabelRules(rules, { disposition: "hold for office" }).ruleId, "office");
  assert.equal(evaluateLabelRules(rules, { disposition: "hold for office" }).automaticAllowed, false);
  assert.equal(evaluateLabelRules(rules, {}).ruleId, "dispatch");
  assert.equal(evaluateLabelRules(rules, { hold: "true" }).automaticAllowed, false);
  assert.equal(evaluateLabelRules(rules, { identityResolved: "false" }).automaticAllowed, false);
  assert.equal(evaluateLabelRules([], {}).automaticAllowed, false);
  assert.throws(() => validateLabelDraft({ ...draft, rules: [draft.rules[0], draft.rules[0]] }), LabelError);
});

test("RTV labels retain submission barcode and operator fields cannot inject printer commands", () => {
  assert.ok(validateLabelDraft({ ...draft, purpose: "rtv_submission", zpl: DEFAULT_TEMPLATE_ZPL, requiredFields: ["submissionNumber"] }));
  assert.throws(() => validateLabelDraft({ ...draft, purpose: "rtv_submission", requiredFields: ["submissionNumber"] }), LabelError);
  assert.throws(() => renderLabelVersion({ ...draft, id: "version" }, {}), LabelError);
  const safe = renderLabelVersion({ ...draft, id: "version" }, { ...fields, instructions: "^XZ~JA\x04\nInjected" });
  assert.ok(!safe.zpl.includes("~JA"));
  const template = "^XA^FD{{lpn}}^FS^XZ";
  assert.equal(matchesApprovedLegacyTemplate("^XA^FDLPN-DEMO^FS^XZ\x04", [{ zpl: template }]), true);
  assert.equal(matchesApprovedLegacyTemplate("^XA^FDLPN-DEMO^FS^JUS^XZ\x04", [{ zpl: template }]), false);
});

test("database label versions and device-bound receipts preserve unknown-no-replay and current authority", { skip: !process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/temcotools_v2_test", "Dedicated local test database required.");
  const [{ prisma }, workflow, effect, deviceCommands, { resolvePrincipal, CURRENT_USER_SELECT }] = await Promise.all([import("../lib/db"), import("../lib/labels/workflows"), import("../lib/labels/issuance"), import("../lib/labels/devices"), import("../lib/auth/principal")]);
  assert.equal(await prisma.labelWorkflow.count({ where: { purpose: draft.purpose } }), 0, "Preserve any existing workflow fixture rather than overwrite it.");
  const suffix = randomUUID(), userIds: string[] = [], bundleIds: string[] = [], unitIds: string[] = [], observationIds: string[] = [], oauthClientIds: string[] = [];
  const oauthEnvironment = { MCP_ISSUER_URL: process.env.MCP_ISSUER_URL, MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL, NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL };
  Object.assign(process.env, { MCP_ISSUER_URL: "http://127.0.0.1:3997", MCP_RESOURCE_URL: "http://127.0.0.1:3997/mcp", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3997" });
  let printerId = "", legacyTemplateId = "", workflowCreated = false;
  async function actor(role: "admin" | "user", capabilities: string[]) {
    const bundle = await prisma.roleBundle.create({ data: { name: `Label fixture ${randomUUID()}`, capabilities } }); bundleIds.push(bundle.id);
    const user = await prisma.user.create({ data: { username: `label-fixture-${randomUUID()}`, displayName: "Synthetic label operator", role, pinHash: "not-a-usable-credential", roleBundles: { create: { bundleId: bundle.id } } } }); userIds.push(user.id);
    const at = new Date();
    const session = await prisma.userSession.create({ data: { id: randomUUID(), userId: user.id, authVersion: user.authVersion, createdAt: at, lastActivityAt: at, lastStrongAuthenticatedAt: at, mfaVerifiedAt: at, expiresAt: new Date(at.getTime() + 60 * 60_000), deviceLabel: "Synthetic label test" } });
    const principal = await resolvePrincipal({ userId: user.id, authVersion: user.authVersion, sessionId: session.id, issuedAt: at.getTime(), expiresAt: session.expiresAt.getTime() }, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    assert.ok(principal);
    return { ...principal, sessionId: session.id, strongAuthenticatedAt: at.getTime(), mfaVerifiedAt: at.getTime() } as Principal;
  }
  try {
    const admin = await actor("admin", ["labels.read", "labels.print", "labels.manage", "inventory.read", "workflow.read"]), requester = await actor("user", ["labels.read", "labels.print", "inventory.read", "workflow.read"]), receiver = await actor("user", ["labels.read", "labels.print"]);
    const printer = await prisma.labelPrinter.create({ data: { name: `Synthetic printer ${suffix}`, endpoint: "http://printer.invalid:9100", contentType: "text/plain" } }); printerId = printer.id;
    for (let i = 0; i < 4; i++) { const unit = await prisma.warehouseUnit.create({ data: { creationEvidence: "Synthetic label test only" } }); unitIds.push(unit.id); await prisma.warehouseIdentifier.create({ data: { unitId: unit.id, kind: "lpn", namespace: "wms", value: `SYNTHETIC-${suffix}-${i}`.toUpperCase(), rawValue: `SYNTHETIC-${suffix}-${i}`, evidence: "Synthetic actual unit alias for native operational label tests" } }); }
    await assert.rejects(workflow.saveLabelWorkflow(requester, { ...draft, expectedRevision: 0, note: "Unauthorized" }));
    const saved = await workflow.saveLabelWorkflow(admin, { ...draft, expectedRevision: 0, note: "Synthetic first draft" }); workflowCreated = true;
    const published = await workflow.publishLabelWorkflow(admin, { purpose: draft.purpose, expectedRevision: saved.revision, note: "Synthetic first publication" });
    await assert.rejects(prisma.labelWorkflowVersion.update({ where: { id: published.published.id }, data: { zpl: "changed" } }));
    const device = await deviceCommands.registerPrintingDevice(receiver, { deviceId: randomUUID(), name: "Synthetic relay", mode: "relay", printerIds: [printer.id] });
    const legacyTemplate = await prisma.labelTemplate.create({ data: { name: `Synthetic legacy ${suffix}`, kind: "pick_wave", zpl: "^XA^FD{{lpn}}^FS^XZ" } }); legacyTemplateId = legacyTemplate.id;
    const legacy = await effect.prepareLabelIssuance(requester, { operationId: randomUUID(), purpose: "legacy_manual", printerId, legacyZpl: "^XA^FDLPN-LEGACY-DEMO^FS^XZ", mode: "relay", deviceId: device.device.id });
    await prisma.labelTemplate.update({ where: { id: legacyTemplate.id }, data: { isActive: false } });
    const disabledLegacy = await effect.claimLabelDispatch(receiver, { issuanceId: legacy.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken });
    assert.equal(disabledLegacy.dispatch, false); assert.equal("issuance" in disabledLegacy && disabledLegacy.issuance.state, "not_sent");
    const base = { operationId: randomUUID(), unitId: unitIds[0], purpose: draft.purpose, printerId: printer.id, fields, mode: "relay", deviceId: device.device.id, automatic: false };
    await assert.rejects(effect.prepareLabelIssuance(requester, { ...base, automatic: true }), /qualifying physical observation/);
    const schedule = async (nextDeliveryDate: string) => prisma.officeScheduleFact.create({ data: { unitId: unitIds[0], deliveryDate: null, nextDeliveryDate, complete: true, sourceAsOf: new Date(), sourceRef: "Synthetic reviewed complete schedule", evidence: "Synthetic authoritative schedule change; caller fields are not operational facts", recordedByUserId: admin.userId } });
    await schedule("2026-11-02");
    const prepared = await effect.prepareLabelIssuance(requester, base);
    assert.equal(prepared.created, true);
    assert.equal((await effect.prepareLabelIssuance(requester, { ...base, fields: Object.fromEntries(Object.entries(fields).reverse()) })).issuance.id, prepared.issuance.id);
    await assert.rejects(effect.prepareLabelIssuance(requester, { ...base, fields: { ...fields, routeNumber: "OTHER" } }));
    const repeated = await effect.prepareLabelIssuance(requester, { ...base, operationId: randomUUID(), fields: { ...fields, vendor: "Unused field changed" } });
    assert.equal(repeated.created, false); assert.equal(repeated.issuance.id, prepared.issuance.id);
    const claimInput = { issuanceId: prepared.issuance.id, deviceId: device.device.id, deviceToken: device.deviceToken };
    await assert.rejects(effect.claimLabelDispatch(requester, claimInput));
    await assert.rejects(effect.claimLabelDispatch(receiver, { ...claimInput, deviceToken: "not-the-correct-device-token-00000000" }));
    const claim = await effect.claimLabelDispatch(receiver, claimInput); assert.ok(claim.dispatch);
    assert.equal((await effect.claimLabelDispatch(receiver, claimInput)).dispatch, false);
    const report = { ...claimInput, reportToken: claim.reportToken, status: "sent_unconfirmed", note: "Synthetic browser ACK; no physical print tested" };
    const sent = await effect.reportLabelDelivery(receiver, report);
    assert.equal(sent.state, "sent_unconfirmed"); assert.equal(sent.physicalOutput, "unconfirmed");
    assert.equal((await effect.getLabelIssuance({ ...requester, capabilities: ["labels.read"] }, sent.id)).id, sent.id, "Viewing your receipt does not require executing another print.");
    assert.equal((await effect.getLabelIssuance({ ...requester, capabilities: ["labels.print"] }, sent.id)).id, sent.id, "A print-only caller can recover its own original receipt.");
    await assert.rejects(effect.getLabelIssuance({ ...receiver, capabilities: ["labels.print"] }, sent.id), "Print-only authority does not read somebody else's receipt.");
    assert.equal((await effect.reportLabelDelivery(receiver, report)).id, sent.id);
    await assert.rejects(effect.reportLabelDelivery(receiver, { ...report, status: "not_sent" }));
    await schedule("2026-11-03");
    const updated = await effect.prepareLabelIssuance(requester, { ...base, operationId: randomUUID(), fields: { ...fields, deliveryDate: "2026-11-03" } });
    assert.equal(updated.created, true);
    const changedClaim = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: updated.issuance.id }); assert.ok(changedClaim.dispatch);
    await effect.reportLabelDelivery(receiver, { ...claimInput, issuanceId: updated.issuance.id, reportToken: changedClaim.reportToken, status: "unknown", note: "Synthetic lost result" });
    await schedule("2026-11-04");
    await assert.rejects(effect.prepareLabelIssuance(requester, { ...base, operationId: randomUUID(), fields: { ...fields, deliveryDate: "2026-11-04" } }), (error: unknown) => error instanceof LabelError && error.code === "unknown_effect");
    const reprint = await effect.reprintLabelIssuance(requester, { operationId: randomUUID(), issuanceId: updated.issuance.id, mode: "relay", deviceId: device.device.id, reason: "Synthetic explicit inspected reprint authorization" });
    assert.equal(reprint.issuance.reprintOf, updated.issuance.id); assert.equal(reprint.issuance.automatic, false);
    await effect.reconcileLabelIssuance(requester, { issuanceId: sent.id, outcome: "applied", reason: "Synthetic operator confirmation only" });
    await schedule("2026-11-03");
    const state = await workflow.evaluateLabel(admin, { purpose: draft.purpose, unitId: unitIds[0], fields });
    await assert.rejects(workflow.evaluateLabel({ ...admin, capabilities: ["labels.read"] }, { purpose: draft.purpose, unitId: unitIds[0], fields }), "Label-template read scope does not reveal warehouse physical observations.");
    assert.ok((await deviceCommands.listPrintingDevices(admin)).every(item => !("sessionId" in item)), "Shared device diagnostics do not expose another user's session binding.");
    assert.equal(state.lastObserved, null); assert.equal(await prisma.warehousePhysicalObservation.count({ where: { unitId: unitIds[0] } }), 0);
    const unknownSnapshot = await prisma.labelIssuance.findUniqueOrThrow({ where: { id: updated.issuance.id } });
    await prisma.labelIssuance.createMany({ data: Array.from({ length: 21 }, (_, index) => ({ ...unknownSnapshot, id: randomUUID(), operationId: randomUUID(), state: "verified_not_printed", createdAt: new Date(Date.now() + index + 1), claimTokenHash: null, reportFingerprint: null })) });
    const olderUnknown = await workflow.evaluateLabel(admin, { purpose: draft.purpose, unitId: unitIds[0], fields });
    assert.equal(olderUnknown.available && olderUnknown.blockedByUnknownIssuanceId, updated.issuance.id, "An old uncertain send must not disappear behind the displayed history page.");
    assert.equal(olderUnknown.available && olderUnknown.due, false, "An older same-content issuance still prevents repetitive printing.");
    const observation = await prisma.warehousePhysicalObservation.create({ data: { userId: requester.userId, eventId: randomUUID(), fingerprint: randomUUID(), rawIdentifier: "LPN-SYNTHETIC-OBSERVATION", identifierType: "lpn", type: "presence", captureMethod: "manual", capturedAt: new Date(), unitId: unitIds[1], resolution: "resolved", candidateUnitIds: [] } }); observationIds.push(observation.id);
    assert.equal((await workflow.evaluateLabel(admin, { purpose: draft.purpose, unitId: unitIds[1], fields })).lastObserved?.id, observation.id);
    await prisma.warehouseObservationCorrection.create({ data: { observationId: observation.id, unitId: unitIds[2], reason: "Synthetic identity-association correction", userId: admin.userId, revision: 1 } });
    assert.equal((await workflow.evaluateLabel(admin, { purpose: draft.purpose, unitId: unitIds[1], fields })).lastObserved, null);
    assert.equal((await workflow.evaluateLabel(admin, { purpose: draft.purpose, unitId: unitIds[2], fields })).lastObserved?.id, observation.id);
    const pendingOld = await effect.prepareLabelIssuance(requester, { ...base, unitId: unitIds[1], operationId: randomUUID() });
    const secondDraft = await workflow.saveLabelWorkflow(admin, { ...draft, zpl: draft.zpl.replace("^FO10,10", "^FO20,20"), expectedRevision: published.workflow.revision, note: "Synthetic version-two draft" });
    assert.equal((await workflow.getLabelWorkflow(admin, draft.purpose)).publishedVersionId, published.published.id);
    const second = await workflow.publishLabelWorkflow(admin, { purpose: draft.purpose, expectedRevision: secondDraft.revision, note: "Synthetic version-two publication" });
    const stalePublication = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: pendingOld.issuance.id });
    assert.equal(stalePublication.dispatch, false); assert.equal("issuance" in stalePublication && stalePublication.issuance.state, "not_sent");
    await workflow.rollbackLabelWorkflow(admin, { purpose: draft.purpose, expectedRevision: second.workflow.revision, versionId: published.published.id, note: "Synthetic rollback" });
    const grant = await prisma.appAccessGrant.create({ data: { userId: requester.userId, sessionId: requester.sessionId, authVersion: requester.authVersion, tokenHash: `synthetic-${suffix}`, clientName: "Synthetic print client", scopes: ["labels.print", "inventory.read", "workflow.read"], expiresAt: new Date(Date.now() + 60_000) } });
    const delegated: Principal = { ...requester, grantId: grant.id, capabilities: ["labels.print", "inventory.read", "workflow.read"] };
    const grantPending = await effect.prepareLabelIssuance(delegated, { ...base, unitId: unitIds[2], operationId: randomUUID() });
    await prisma.appAccessGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    const revokedGrant = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: grantPending.issuance.id });
    assert.equal(revokedGrant.dispatch, false); assert.equal("issuance" in revokedGrant && revokedGrant.issuance.state, "not_sent");
    const oauthClient = await prisma.oAuthClient.create({ data: { id: `synthetic-label-${suffix}`, name: "Synthetic OAuth print client", metadata: {} } }); oauthClientIds.push(oauthClient.id);
    const oauthGrant = await prisma.oAuthGrant.create({ data: { requestId: randomUUID(), clientId: oauthClient.id, userId: requester.userId, sessionId: requester.sessionId!, authVersion: requester.authVersion, issuer: "http://127.0.0.1:3997/", resource: "http://127.0.0.1:3997/mcp", scopes: ["labels.print", "inventory.read", "workflow.read"], expiresAt: new Date(Date.now() + 60_000) } });
    const oauthPrincipal: Principal = { ...requester, grantId: `oauth:${oauthGrant.id}`, capabilities: ["labels.print", "inventory.read", "workflow.read"] };
    const oauthPending = await effect.prepareLabelIssuance(oauthPrincipal, { ...base, unitId: unitIds[2], operationId: randomUUID() });
    const oauthClaim = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: oauthPending.issuance.id }); assert.ok(oauthClaim.dispatch);
    await effect.reportLabelDelivery(receiver, { ...claimInput, issuanceId: oauthPending.issuance.id, reportToken: oauthClaim.reportToken, status: "not_sent", note: "Synthetic no physical dispatch" });
    const rescopedPending = await effect.prepareLabelIssuance(oauthPrincipal, { ...base, unitId: unitIds[2], operationId: randomUUID() });
    await prisma.oAuthGrant.update({ where: { id: oauthGrant.id }, data: { scopes: [] } });
    const rescoped = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: rescopedPending.issuance.id });
    assert.equal(rescoped.dispatch, false); assert.equal("issuance" in rescoped && rescoped.issuance.state, "not_sent");
    const accountPending = await effect.prepareLabelIssuance(requester, { ...base, unitId: unitIds[3], operationId: randomUUID() });
    await prisma.user.update({ where: { id: requester.userId }, data: { isActive: false } });
    const inactiveRequester = await effect.claimLabelDispatch(receiver, { ...claimInput, issuanceId: accountPending.issuance.id });
    assert.equal(inactiveRequester.dispatch, false);
    assert.equal((await effect.getLabelIssuance(admin, accountPending.issuance.id)).state, "not_sent");
    await prisma.roleBundle.update({ where: { id: bundleIds[0] }, data: { capabilities: ["labels.read", "labels.print"] } });
    await assert.rejects(effect.cancelQueuedLabel(admin, { issuanceId: reprint.issuance.id, reason: "Synthetic stale manager authority must fail" }));
    await assert.rejects(effect.reconcileLabelIssuance(admin, { issuanceId: sent.id, outcome: "printed", reason: "Synthetic stale manager authority must fail" }));
  } finally {
    const rows = await prisma.labelIssuance.findMany({ where: { actorUserId: { in: userIds } }, select: { id: true } });
    await prisma.labelIssuanceEvent.deleteMany({ where: { issuanceId: { in: rows.map(row => row.id) } } });
    await prisma.labelIssuance.deleteMany({ where: { id: { in: rows.map(row => row.id) } } });
    await prisma.printingDevice.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.warehouseObservationCorrection.deleteMany({ where: { observationId: { in: observationIds } } });
    await prisma.warehousePhysicalObservation.deleteMany({ where: { id: { in: observationIds } } });
    if (workflowCreated) { await prisma.labelWorkflow.update({ where: { purpose: draft.purpose }, data: { publishedVersionId: null } }); await prisma.labelWorkflowAudit.deleteMany({ where: { purpose: draft.purpose } }); await prisma.labelWorkflowVersion.deleteMany({ where: { purpose: draft.purpose } }); await prisma.labelWorkflow.delete({ where: { purpose: draft.purpose } }); }
    await prisma.officeScheduleFact.deleteMany({ where: { unitId: { in: unitIds } } });
    await prisma.warehouseIdentifier.deleteMany({ where: { unitId: { in: unitIds } } });
    await prisma.warehouseUnit.deleteMany({ where: { id: { in: unitIds } } });
    if (printerId) await prisma.labelPrinter.delete({ where: { id: printerId } });
    if (legacyTemplateId) await prisma.labelTemplate.delete({ where: { id: legacyTemplateId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await prisma.roleBundle.deleteMany({ where: { id: { in: bundleIds } } });
    await prisma.oAuthClient.deleteMany({ where: { id: { in: oauthClientIds } } });
    await prisma.$disconnect();
    for (const [name, value] of Object.entries(oauthEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
