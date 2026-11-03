import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkflowJson, copyWorkflowJson, evaluateWorkflowCondition, mapWorkflowParameters,
  validateWorkflowDefinition, validateWorkflowFields, workflowField, WorkflowError,
  type JsonValue, type WorkflowDefinition,
} from "../lib/workflows/definition";
import {
  advanceWorkflowRun, createWorkflowRun, workflowReadiness,
  type WorkflowCommand, type WorkflowCommandInput, type WorkflowRun, type WorkflowRuntime, type WorkflowTransition,
} from "../lib/workflows/engine";
import {
  createSyntheticReceiving, createSyntheticReceivingRuntime, executeSyntheticReceivingIntent,
  reconcileSyntheticReceivingOperation, recordSyntheticReceivingScan, requestSyntheticDeliveryClose,
  requestSyntheticReceivingLabel, requestSyntheticWmsReceipt, resolveSyntheticReceivingDiscrepancy,
  settleSyntheticDeliveryClose, settleSyntheticReceivingLabel, settleSyntheticWmsReceipt, syntheticReceivingReadiness,
  SYNTHETIC_RECEIVING_BINDINGS, SYNTHETIC_RECEIVING_DEFINITION, SYNTHETIC_RECEIVING_DELIVERY,
  type SyntheticReceivingState,
} from "../lib/workflows/receiving";

const now = "2026-11-03T12:00:00.000Z", siteId = "SITE-A", actorUserId = "USER-A";
const by = { userId: actorUserId, at: now };
function runtime(overrides: Partial<WorkflowRuntime> = {}): WorkflowRuntime {
  return { siteId, actorUserId, now, configurationVersion: "config-v1", origin: "operator", runPermitted: true, capabilities: ["workflow.read", "workflows.manage"], providers: [], actions: [], ...overrides };
}
function definition(steps: unknown[], extra: Record<string, unknown> = {}): WorkflowDefinition {
  return validateWorkflowDefinition({ id: "test-workflow", versionId: "definition-v1", version: 1, configurationVersion: "config-v1", name: "Synthetic test workflow", mode: "synthetic", steps, ...extra });
}
function formStep() { return { id: "form", kind: "form", title: "Typed input", saveAs: "selection", fields: [{ key: "enabled", label: "Enabled", type: "boolean" }] }; }
function actionStep(effect: "read" | "write" | "print" | "local" = "write", extra: Record<string, unknown> = {}) {
  return { id: "effect", kind: "action", title: "Pinned action", action: { id: "test.effect", versionId: "action-v1", configurationVersion: "config-v1", capability: "workflow.read", effect }, ...extra };
}
function effectRuntime(effect: "read" | "write" | "print" | "local" = "write", overrides: Partial<WorkflowRuntime> = {}) {
  return runtime({ actions: [{ id: "test.effect", versionId: "action-v1", configurationVersion: "config-v1", siteId, effect, enabled: true, permitted: true, ready: true, qualification: "synthetic" }], ...overrides });
}
class Exercise {
  run: WorkflowRun;
  last: WorkflowTransition;
  sequence = 0;
  constructor(def: WorkflowDefinition, readonly context: WorkflowRuntime, bindings = {}) {
    this.last = createWorkflowRun({ id: "run-1", siteId, definition: def, providerBindings: bindings }, context); this.run = this.last.run;
  }
  input(command: WorkflowCommand): WorkflowCommandInput { return { commandId: `command-${++this.sequence}`, expectedRevision: this.run.revision, definitionVersionId: this.run.definitionVersionId, command }; }
  command(command: WorkflowCommand, overrides: Partial<WorkflowRuntime> = {}) {
    this.last = advanceWorkflowRun(this.run, this.input(command), { ...this.context, ...overrides }); this.run = this.last.run; return this.last;
  }
}
function scanDefinition(rows: JsonValue[], extra: Record<string, unknown> = {}) {
  return definition([{ id: "scan", kind: "scan", title: "Scan units", expected: { source: "literal", value: rows }, keyField: "unitId", valueField: "barcode", ...extra }]);
}
function receivingExercise() {
  const context = createSyntheticReceivingRuntime(siteId, actorUserId, now);
  const exercise = new Exercise(SYNTHETIC_RECEIVING_DEFINITION, context, SYNTHETIC_RECEIVING_BINDINGS);
  let state = createSyntheticReceiving(siteId, SYNTHETIC_RECEIVING_DELIVERY.id, SYNTHETIC_RECEIVING_DELIVERY.lines);
  function execute(options?: Parameters<typeof executeSyntheticReceivingIntent>[3]) {
    assert.equal(exercise.last.intents.length, 1);
    const intent = exercise.last.intents[0], settled = executeSyntheticReceivingIntent(state, intent, by, options); state = settled.state;
    exercise.command({ kind: "action_result", intentId: intent.id, result: settled.result }, { origin: "executor" }); return intent;
  }
  return { exercise, execute, get state() { return state; }, set state(value: SyntheticReceivingState) { state = value; } };
}

test("definitions are bounded typed data, reject unsafe paths/loops/forward mappings and do not coerce fields", () => {
  const def = definition([formStep()]);
  assert.equal(def.steps[0].kind, "form");
  assert.throws(() => assertWorkflowJson(JSON.parse('{"constructor":{}}')), WorkflowError);
  assert.throws(() => assertWorkflowJson(new Date()), WorkflowError);
  assert.throws(() => definition([{ ...formStep(), next: "form" }]), /later existing step/);
  assert.throws(() => definition([{ ...actionStep(), parameters: { value: { source: "step", stepId: "effect", path: [] } } }]), /earlier existing/);
  assert.throws(() => definition([{ ...actionStep(), parameters: { value: { source: "javascript", code: "return fetch('https://example.com')" } } }]), /typed workflow/);
  assert.throws(() => definition([formStep()], { completion: { all: [{ operator: "exists", left: { source: "step", stepId: "missing", path: [] } }] } }), /earlier existing/);
  const fields = [workflowField.parse({ key: "ok", label: "Confirmed", type: "boolean" }), workflowField.parse({ key: "count", label: "Count", type: "integer", minimum: 1, maximum: 3 })];
  assert.deepEqual(validateWorkflowFields(fields, { ok: false, count: 2 }), { ok: false, count: 2 });
  assert.throws(() => validateWorkflowFields(fields, { ok: "false", count: 2 }), /true or false/);
  assert.throws(() => validateWorkflowFields(fields, { ok: true, count: "2" }), /integer limits/);
  assert.throws(() => validateWorkflowFields(fields, { ok: true, count: 2, surprise: true }), /Unknown form field/);
  assert.throws(() => mapWorkflowParameters({ required: { source: "data", path: ["missing"] } }, { data: {}, steps: {} }), /unavailable/);
  assert.equal(evaluateWorkflowCondition({ all: [{ operator: "equals", left: { source: "data", path: ["missing"] }, right: { source: "data", path: ["alsoMissing"] } }] }, { data: {}, steps: {} }), false);
});

test("Receiving practice completes exact unit slots while scan, label ACK, confirmation and receipt remain distinct", () => {
  const fixture = receivingExercise(), e = fixture.exercise;
  e.command({ kind: "submit", values: { deliveryId: SYNTHETIC_RECEIVING_DELIVERY.id } }); fixture.execute();
  assert.equal(e.run.currentStepId, "scan");
  e.command({ kind: "scan", eventId: "scan-A", rawValue: "SYNTHETIC-LPN-A01" });
  e.command({ kind: "scan", eventId: "duplicate-A", rawValue: "SYNTHETIC-LPN-A01" });
  assert.equal(e.run.steps.scan.captures?.[1].status, "duplicate");
  assert.throws(() => e.command({ kind: "finish_scan" }), /Exact required quantities/);
  e.command({ kind: "scan", eventId: "scan-B", rawValue: "SYNTHETIC-LPN-B01", source: "manual" });
  e.command({ kind: "finish_scan" }); fixture.execute();
  assert.equal(e.run.currentStepId, "verifyLabels");
  assert.equal(fixture.state.captures.length, 2);
  assert.deepEqual(fixture.state.operations.map(value => value.status), ["acknowledged", "acknowledged"]);
  assert.equal(syntheticReceivingReadiness(fixture.state).readyToClose, false);
  assert.equal(fixture.state.operations.some(value => value.kind === "receipt"), false);
  e.command({ kind: "confirm", accepted: true, note: "Synthetic labels applied" }); fixture.execute();
  assert.equal(e.run.currentStepId, "close");
  assert.equal(fixture.state.operations.filter(value => value.kind === "label").every(value => value.status === "physically_confirmed"), true);
  assert.equal(syntheticReceivingReadiness(fixture.state).readyToClose, true);
  const closeIntent = fixture.execute();
  assert.equal(e.run.status, "completed"); assert.equal(fixture.state.closed, true);
  assert.equal(e.run.definitionVersionId, SYNTHETIC_RECEIVING_DEFINITION.versionId);
  assert.deepEqual(closeIntent.provider, SYNTHETIC_RECEIVING_BINDINGS.wms);
  assert.equal(closeIntent.actorUserId, actorUserId);
});

test("unknown individual receipt retains successful siblings and needs explicit reconciliation, never replay", () => {
  const fixture = receivingExercise(), e = fixture.exercise;
  e.command({ kind: "submit", values: { deliveryId: SYNTHETIC_RECEIVING_DELIVERY.id } }); fixture.execute();
  e.command({ kind: "scan", eventId: "scan-A", rawValue: "SYNTHETIC-LPN-A01" }); e.command({ kind: "scan", eventId: "scan-B", rawValue: "SYNTHETIC-LPN-B01" });
  e.command({ kind: "finish_scan" }); fixture.execute(); e.command({ kind: "confirm", accepted: true });
  const receiptIntent = fixture.execute({ unknownReceiptUnitIds: ["SYNTHETIC-UNIT-B"] });
  assert.equal(e.run.status, "unknown");
  assert.deepEqual(fixture.state.operations.filter(value => value.kind === "receipt").map(value => value.status), ["confirmed", "unknown"]);
  assert.equal(workflowReadiness(e.run, e.context).step.some(value => value.id === "unknown-result" && value.status === "red"), true);
  assert.equal(e.command({ kind: "refresh" }).intents.length, 0);
  assert.equal(e.command({ kind: "pause", reason: "Await specific receipt lookup" }).intents.length, 0);
  assert.equal(e.command({ kind: "resume" }).intents.length, 0); assert.equal(e.run.status, "unknown");
  assert.throws(() => e.command({ kind: "retry_failed", reason: "Try again" }), /unknown outcomes are never retried/);
  const unknown = fixture.state.operations.find(value => value.kind === "receipt" && value.status === "unknown")!;
  assert.throws(() => requestSyntheticWmsReceipt(fixture.state, "SYNTHETIC-UNIT-B", "another-receipt", by), /retained operation/);
  assert.equal(requestSyntheticWmsReceipt(fixture.state, "SYNTHETIC-UNIT-B", unknown.id, by).replayed, true);
  assert.throws(() => settleSyntheticWmsReceipt(fixture.state, unknown.id, "confirmed", "lookup-result", by), /reconcile unknown/);
  fixture.state = reconcileSyntheticReceivingOperation(fixture.state, unknown.id, "confirmed", "synthetic-lookup-B", "Synthetic authoritative receipt lookup", by);
  const result = { outcome: "succeeded" as const, output: { resultsConfirmed: true }, receiptId: "synthetic-batch-reconciled" };
  assert.throws(() => e.command({ kind: "reconcile", intentId: receiptIntent.id, result, reason: "Resolved specific unknown" }), /trusted adapter/);
  e.command({ kind: "reconcile", intentId: receiptIntent.id, result, reason: "Resolved specific unknown" }, { origin: "reconciler" });
  assert.equal(e.last.intents.length, 1); fixture.execute();
  assert.equal(e.run.status, "completed");
});

test("commands use CAS/current authority and durable receipts; published revisions do not hot-swap runs", () => {
  const original = definition([formStep()]), e = new Exercise(original, runtime());
  original.steps[0].title = "Changed draft";
  assert.equal(e.run.definition.steps[0].title, "Typed input");
  const input = e.input({ kind: "submit", values: { enabled: false } });
  const done = advanceWorkflowRun(e.run, input, e.context);
  const replay = advanceWorkflowRun(done.run, input, e.context);
  assert.equal(replay.replayed, true); assert.equal(replay.intents.length, 0); assert.equal(replay.run.revision, done.run.revision);
  assert.throws(() => advanceWorkflowRun(done.run, { ...input, command: { kind: "submit", values: { enabled: true } } }, e.context), /reused with different/);
  assert.throws(() => advanceWorkflowRun(done.run, input, { ...e.context, runPermitted: false }), /authority/);
  assert.throws(() => advanceWorkflowRun(e.run, { ...input, expectedRevision: 99 }, e.context), /changed/);
  assert.throws(() => advanceWorkflowRun(e.run, { ...input, definitionVersionId: "new-v2" }, e.context), /another workflow version/);
  assert.throws(() => advanceWorkflowRun(e.run, input, { ...e.context, siteId: "SITE-B" }), /another warehouse/);
  assert.throws(() => advanceWorkflowRun(e.run, input, { ...e.context, configurationVersion: "config-v2" }), /pinned configuration/);
  assert.throws(() => createWorkflowRun({ id: "run-x", siteId, definition: original, providerBindings: { undeclared: SYNTHETIC_RECEIVING_BINDINGS.wms } }, e.context), /declared provider/);
});

test("pause records an in-flight result without dispatching the next action until resume", () => {
  const step1 = actionStep("read"), step2 = { ...actionStep("read"), id: "second" };
  const e = new Exercise(definition([step1, step2]), effectRuntime("read")), intent = e.last.intents[0];
  e.command({ kind: "pause", reason: "Operator pause" });
  e.command({ kind: "action_result", intentId: intent.id, result: { outcome: "succeeded", receiptId: "first-result", output: { found: true } } }, { origin: "executor" });
  assert.equal(e.run.status, "paused"); assert.equal(e.last.intents.length, 0); assert.equal(e.run.steps.effect.status, "complete");
  assert.equal(e.command({ kind: "resume" }).intents.length, 1); assert.equal(e.run.currentStepId, "second");
});

test("human/device handoff retains original intent and operator cannot manufacture adapter success", () => {
  const e = new Exercise(definition([actionStep()]), effectRuntime()), intent = e.last.intents[0];
  assert.throws(() => e.command({ kind: "action_result", intentId: intent.id, result: { outcome: "succeeded", receiptId: "fake" } }), /trusted adapter/);
  e.command({ kind: "action_result", intentId: intent.id, result: { outcome: "handoff", receiptId: "camera-prompt", reason: "Human must capture on the connected device" } }, { origin: "executor" });
  assert.equal(e.run.status, "human"); assert.equal(e.command({ kind: "refresh" }).intents.length, 0);
  assert.equal(workflowReadiness(e.run, e.context).status, "yellow");
  e.command({ kind: "action_result", intentId: intent.id, result: { outcome: "succeeded", receiptId: "human-completed-original" } }, { origin: "executor" });
  assert.equal(e.run.status, "completed");
});

test("known-failure retries require definition opt-in and read/no-effect proof, with attempt limit", () => {
  const e = new Exercise(definition([actionStep("write", { retryKnownFailure: true })]), effectRuntime());
  e.command({ kind: "action_result", intentId: e.last.intents[0].id, result: { outcome: "failed", receiptId: "failed-1" } }, { origin: "executor" });
  assert.throws(() => e.command({ kind: "retry_failed", reason: "Explicit retry" }), /known safe failure/);
  const reader = new Exercise(definition([actionStep("read", { retryKnownFailure: true })]), effectRuntime("read"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(reader.last.intents[0].attempt, attempt);
    reader.command({ kind: "action_result", intentId: reader.last.intents[0].id, result: { outcome: "failed", receiptId: `read-failed-${attempt}` } }, { origin: "executor" });
    if (attempt < 3) reader.command({ kind: "retry_failed", reason: "Retry known read failure" });
  }
  assert.throws(() => reader.command({ kind: "retry_failed", reason: "Retry again" }), /known safe failure/);
});

test("provider readiness separates transport/auth/action and never substitutes another session or new grant/version", () => {
  const base = createSyntheticReceivingRuntime(siteId, actorUserId, now), def = copyWorkflowJson(SYNTHETIC_RECEIVING_DEFINITION);
  const e = new Exercise(def, base, SYNTHETIC_RECEIVING_BINDINGS);
  e.command({ kind: "submit", values: { deliveryId: SYNTHETIC_RECEIVING_DELIVERY.id } }, { providers: base.providers.map(value => ({ ...value, authenticated: false })) });
  assert.equal(e.run.status, "blocked"); assert.equal(e.last.intents.length, 0);
  assert.match(workflowReadiness(e.run, { ...base, providers: base.providers.map(value => ({ ...value, authenticated: false })) }).blocking[0].reason, /not authenticated/);
  const wrongVersions = base.providers.map(value => ({ ...value, authorizationVersionId: "new-grant" }));
  assert.match(workflowReadiness(e.run, { ...base, providers: wrongVersions }).blocking[0].reason, /grant version changed/);
  const otherProvider = { ...base.providers[0], providerId: "another-ready-session" };
  const otherOnly = { ...base, providers: [otherProvider] };
  assert.match(workflowReadiness(e.run, otherOnly).blocking[0].reason, /unavailable/);
  const crossSite = { ...base, providers: base.providers.map(value => ({ ...value, siteId: "SITE-B" })) };
  assert.match(workflowReadiness(e.run, crossSite).blocking[0].reason, /unavailable/);
  const wrongAction = { ...base, actions: base.actions.map(value => ({ ...value, versionId: "action-v2" })) };
  assert.match(workflowReadiness(e.run, wrongAction).blocking[0].reason, /pinned action/);
  const wrongMode = { ...base, actions: base.actions.map(value => ({ ...value, qualification: "qualified" as const })) };
  assert.match(workflowReadiness(e.run, wrongMode).blocking[0].reason, /synthetic run cannot/);
  assert.equal(e.command({ kind: "refresh" }).intents.length, 1);
});

test("start requirements and later printer dependencies are separate; buffering is explicit and bounded", () => {
  const offline = createSyntheticReceivingRuntime(siteId, actorUserId, now, { printerConnected: false });
  const e = new Exercise(SYNTHETIC_RECEIVING_DEFINITION, offline, SYNTHETIC_RECEIVING_BINDINGS);
  assert.equal(e.run.status, "human"); assert.equal(workflowReadiness(e.run, offline).start.find(value => value.id === "printer-warning")?.status, "yellow");
  const provider = { ...offline.providers[1], siteId, actionReady: false };
  const required = { id: "printer", kind: "provider", label: "Pinned printer", fix: "Reconnect it", binding: "printer" };
  const buffered = new Exercise(scanDefinition([{ unitId: "A", barcode: "A" }], { requirements: [required], bufferWhenProviderBlocked: true, maxCaptures: 2 }), runtime({ providers: [provider] }), { printer: SYNTHETIC_RECEIVING_BINDINGS.printer });
  assert.equal(buffered.run.status, "blocked");
  buffered.command({ kind: "scan", eventId: "A-1", rawValue: "A" });
  assert.equal(buffered.run.steps.scan.captures?.[0].buffered, true);
  assert.throws(() => buffered.command({ kind: "finish_scan" }), /disconnected/);
  buffered.command({ kind: "scan", eventId: "A-2", rawValue: "A" });
  assert.throws(() => buffered.command({ kind: "scan", eventId: "A-3", rawValue: "A" }), /buffer is full/);
  const deniedDef = scanDefinition([{ unitId: "A", barcode: "A" }], { requirements: [required, { id: "scope", kind: "capability", capability: "missing.permission", label: "Scope", fix: "Restore scope" }], bufferWhenProviderBlocked: true });
  const denied = new Exercise(deniedDef, runtime({ providers: [provider] }), { printer: SYNTHETIC_RECEIVING_BINDINGS.printer });
  assert.throws(() => denied.command({ kind: "scan", eventId: "A-1", rawValue: "A" }), /disconnected/);
});

test("unit and quantity scans preserve ambiguity, excess and discrepancies without double counting", () => {
  const units = new Exercise(scanDefinition([{ unitId: "A", barcode: "SHARED" }, { unitId: "B", barcode: "SHARED" }]), runtime());
  units.command({ kind: "scan", eventId: "ambiguous", rawValue: "SHARED" });
  assert.equal(units.run.steps.scan.captures?.[0].status, "ambiguous");
  assert.throws(() => units.command({ kind: "scan", eventId: "bad-choice", rawValue: "SHARED", selectedKey: "C" }), /exact candidate/);
  units.command({ kind: "scan", eventId: "A-1", rawValue: "SHARED", selectedKey: "A" });
  units.command({ kind: "scan", eventId: "B-1", rawValue: "SHARED", selectedKey: "B" });
  assert.throws(() => units.command({ kind: "finish_scan" }), /discrepancy review/);
  assert.throws(() => units.command({ kind: "resolve_capture", eventId: "ambiguous", reason: "Recorded both exact units" }, { capabilities: ["workflow.read"] }), /permitted reviewer/);
  units.command({ kind: "resolve_capture", eventId: "ambiguous", reason: "Recorded both exact units" }); units.command({ kind: "finish_scan" });
  assert.equal(units.run.status, "completed");
  const quantities = new Exercise(scanDefinition([{ unitId: "line-A", barcode: "SKU-A", quantity: 3 }], { identityMode: "quantity" }), runtime());
  quantities.command({ kind: "scan", eventId: "two", rawValue: "SKU-A", quantity: 2 });
  quantities.command({ kind: "scan", eventId: "excess", rawValue: "SKU-A", quantity: 2 });
  assert.equal(quantities.run.steps.scan.captures?.[1].status, "excess");
  quantities.command({ kind: "scan", eventId: "one", rawValue: "SKU-A", quantity: 1 });
  quantities.command({ kind: "resolve_capture", eventId: "excess", reason: "Rejected excess scan input" }); quantities.command({ kind: "finish_scan" });
  assert.equal(quantities.run.status, "completed");
  const output = quantities.run.steps.scan.output as { matches: Array<{ observedQuantity: number }> };
  assert.equal(output.matches[0].observedQuantity, 3);
});

function fullyReceived() {
  let state = createSyntheticReceiving(siteId, "inbound-1", [{ lineId: "line-1", quantity: 1, units: [{ unitId: "unit-1", barcode: "LPN-1" }] }]);
  state = recordSyntheticReceivingScan(state, { eventId: "scan-1", rawValue: "LPN-1" }, by).state;
  state = requestSyntheticReceivingLabel(state, "unit-1", "label-1", by).state;
  state = settleSyntheticReceivingLabel(state, "label-1", "acknowledged", "label-ack", by);
  state = requestSyntheticWmsReceipt(state, "unit-1", "receipt-1", by).state;
  state = settleSyntheticWmsReceipt(state, "receipt-1", "confirmed", "receipt-confirmed", by);
  return state;
}
test("Receiving rejects false physical proof, blocks closure on unresolved evidence and never reissues unknown close", () => {
  let state = fullyReceived();
  assert.equal(syntheticReceivingReadiness(state).labelsUnconfirmed.length, 1);
  assert.throws(() => requestSyntheticDeliveryClose(state, "close-1", by), /before closure/);
  state = settleSyntheticReceivingLabel(state, "label-1", "physically_confirmed", "physical-confirmation", by);
  state = recordSyntheticReceivingScan(state, { eventId: "wrong", rawValue: "WRONG" }, by).state;
  assert.throws(() => requestSyntheticDeliveryClose(state, "close-1", by), /before closure/);
  state = resolveSyntheticReceivingDiscrepancy(state, "wrong", "Unrelated fixture label reviewed", by);
  state = requestSyntheticDeliveryClose(state, "close-1", by).state;
  assert.equal(syntheticReceivingReadiness(state).readyToClose, false);
  state = settleSyntheticDeliveryClose(state, "close-1", "unknown", "unknown-close", by);
  assert.equal(syntheticReceivingReadiness(state).closeUnknown, true);
  assert.equal(requestSyntheticDeliveryClose(state, "close-1", by).replayed, true);
  assert.throws(() => requestSyntheticDeliveryClose(state, "close-2", by), /before closure/);
  state = reconcileSyntheticReceivingOperation(state, "close-1", "confirmed", "looked-up-close", "Specific simulated closure lookup", by);
  assert.equal(state.closed, true);
  assert.equal(settleSyntheticDeliveryClose(state, "close-1", "confirmed", "looked-up-close", by).closed, true);
  assert.equal(requestSyntheticDeliveryClose(state, "close-1", by).replayed, true);
  assert.equal(recordSyntheticReceivingScan(state, { eventId: "scan-1", rawValue: "LPN-1" }, by).replayed, true);
  assert.throws(() => recordSyntheticReceivingScan(state, { eventId: "new", rawValue: "LPN-1" }, by), /open synthetic/);
});

test("unseen units cannot receive and same-order/repeated identifiers are not a unique physical unit", () => {
  let state = createSyntheticReceiving(siteId, "inbound-1", [{ lineId: "same-order", quantity: 2, units: [{ unitId: "original-A", barcode: "ORDER-SHARED" }, { unitId: "replacement-B", barcode: "ORDER-SHARED" }] }]);
  assert.throws(() => requestSyntheticWmsReceipt(state, "original-A", "receipt-A", by), /exact expected unit/);
  state = recordSyntheticReceivingScan(state, { eventId: "order-only", rawValue: "ORDER-SHARED" }, by).state;
  assert.equal(state.captures[0].status, "ambiguous");
  assert.equal(syntheticReceivingReadiness(state).missingUnits.length, 2);
  state = recordSyntheticReceivingScan(state, { eventId: "selected-A", rawValue: "ORDER-SHARED", selectedUnitId: "original-A" }, by).state;
  assert.deepEqual(syntheticReceivingReadiness(state).missingUnits, ["replacement-B"]);
  assert.throws(() => recordSyntheticReceivingScan(state, { eventId: "selected-A", rawValue: "ORDER-SHARED", selectedUnitId: "replacement-B" }, by), /reused/);
});
