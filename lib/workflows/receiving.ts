/** Synthetic-only receiving exercise. These functions never call WMS, printers or warehouse services. */
import { copyWorkflowJson, stableWorkflowJson, validateWorkflowDefinition, workflowId, workflowCorrelationId, WorkflowError, type JsonValue } from "./definition";
import type { WorkflowActionResult, WorkflowEffectIntent, WorkflowProviderSnapshot, WorkflowRuntime } from "./engine";

export type ReceivingActor = { userId: string; at: string };
export type SyntheticExpectedLine = { lineId: string; quantity: number; units: Array<{ unitId: string; barcode: string; aliases?: string[] }> };
export type SyntheticReceivingCapture = { eventId: string; rawValue: string; selectedUnitId?: string; unitId?: string; status: "matched" | "duplicate" | "unexpected" | "ambiguous"; actorUserId: string; at: string; resolution?: { reason: string; actorUserId: string; at: string } };
export type SyntheticReceivingOperation = { id: string; kind: "label" | "receipt" | "close"; unitId?: string; status: "pending" | "acknowledged" | "physically_confirmed" | "confirmed" | "failed" | "unknown"; receiptId?: string; noEffectConfirmed?: boolean; reconciliation?: { reason: string; actorUserId: string; at: string }; actorUserId: string; at: string };
export type SyntheticReceivingState = {
  mode: "synthetic"; siteId: string; deliveryId: string; lines: SyntheticExpectedLine[];
  captures: SyntheticReceivingCapture[]; operations: SyntheticReceivingOperation[]; closed: boolean;
};
function actor(value: ReceivingActor) { if (!workflowId.safeParse(value.userId).success || !Number.isFinite(Date.parse(value.at))) throw new WorkflowError("Provide the server actor/time for this synthetic exercise."); }
function checkOpen(state: SyntheticReceivingState) { if (state.mode !== "synthetic" || state.closed) throw new WorkflowError("Only an open synthetic delivery can change.", "receiving_not_open", 409); }
function units(state: SyntheticReceivingState) { return state.lines.flatMap(line => line.units.map(unit => ({ ...unit, lineId: line.lineId }))); }
function unit(state: SyntheticReceivingState, unitId: string) { const found = units(state).find(value => value.unitId === unitId); if (!found) throw new WorkflowError("Unit is not an exact member of this synthetic delivery."); return found; }
function seen(state: SyntheticReceivingState, unitId: string) { return state.captures.some(capture => capture.status === "matched" && capture.unitId === unitId); }
function operation(state: SyntheticReceivingState, id: string) { const found = state.operations.find(value => value.id === id); if (!found) throw new WorkflowError("Synthetic operation not found."); return found; }
function latest(state: SyntheticReceivingState, kind: SyntheticReceivingOperation["kind"], unitId?: string) { return [...state.operations].reverse().find(value => value.kind === kind && value.unitId === unitId); }
function review(reason: string) { if (!reason || reason.trim().length < 5 || reason.length > 500) throw new WorkflowError("Record a bounded review/reconciliation reason."); }
export function createSyntheticReceiving(siteId: string, deliveryId: string, lines: SyntheticExpectedLine[]): SyntheticReceivingState {
  if (!workflowId.safeParse(siteId).success || !workflowId.safeParse(deliveryId).success || !Array.isArray(lines) || !lines.length || lines.length > 100) throw new WorkflowError("Provide a bounded synthetic delivery.");
  const keys = new Set<string>(), unitKeys = new Set<string>(); let count = 0;
  for (const line of lines) {
    if (!workflowId.safeParse(line.lineId).success || keys.has(line.lineId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100 || !Array.isArray(line.units) || line.units.length !== line.quantity) throw new WorkflowError("Each synthetic line needs exact distinct unit slots matching its quantity.");
    keys.add(line.lineId);
    for (const value of line.units) {
      if (!workflowId.safeParse(value.unitId).success || unitKeys.has(value.unitId) || typeof value.barcode !== "string" || !value.barcode.trim() || value.barcode.length > 500 || (value.aliases && (value.aliases.length > 8 || value.aliases.some(alias => !alias || alias.length > 500)))) throw new WorkflowError("Synthetic unit identities must be bounded and unique.");
      unitKeys.add(value.unitId); count++;
    }
  }
  if (count > 500) throw new WorkflowError("Use at most 500 exact unit slots per receiving run.");
  return { mode: "synthetic", siteId, deliveryId, lines: copyWorkflowJson(lines), captures: [], operations: [], closed: false };
}
export function recordSyntheticReceivingScan(previous: SyntheticReceivingState, input: { eventId: string; rawValue: string; selectedUnitId?: string }, by: ReceivingActor) {
  actor(by);
  if (!workflowId.safeParse(input.eventId).success || typeof input.rawValue !== "string" || !input.rawValue.trim() || input.rawValue.length > 500) throw new WorkflowError("Provide a bounded synthetic scan event.");
  const existing = previous.captures.find(value => value.eventId === input.eventId);
  if (existing) {
    if (existing.rawValue !== input.rawValue || existing.selectedUnitId !== input.selectedUnitId) throw new WorkflowError("A scan event ID was reused with different identity input.", "receiving_event_conflict", 409);
    return { state: copyWorkflowJson(previous), capture: copyWorkflowJson(existing), replayed: true };
  }
  checkOpen(previous);
  if (previous.captures.length >= 1000) throw new WorkflowError("The synthetic capture buffer is full.");
  const state = copyWorkflowJson(previous), value = input.rawValue.trim(), candidates = units(state).filter(valueUnit => [valueUnit.barcode, ...(valueUnit.aliases ?? [])].includes(value));
  const selected = input.selectedUnitId ? candidates.find(valueUnit => valueUnit.unitId === input.selectedUnitId) : candidates.length === 1 ? candidates[0] : undefined;
  if (input.selectedUnitId && !selected) throw new WorkflowError("Manual selection must be an exact candidate for the captured identifier.");
  const status: SyntheticReceivingCapture["status"] = selected ? seen(state, selected.unitId) ? "duplicate" : "matched" : candidates.length > 1 ? "ambiguous" : "unexpected";
  const capture: SyntheticReceivingCapture = { eventId: input.eventId, rawValue: input.rawValue, ...(input.selectedUnitId ? { selectedUnitId: input.selectedUnitId } : {}), ...(selected ? { unitId: selected.unitId } : {}), status, actorUserId: by.userId, at: by.at };
  state.captures.push(capture);
  return { state, capture: copyWorkflowJson(capture), replayed: false };
}
export function resolveSyntheticReceivingDiscrepancy(previous: SyntheticReceivingState, eventId: string, reason: string, by: ReceivingActor) {
  actor(by); review(reason); checkOpen(previous); const state = copyWorkflowJson(previous), capture = state.captures.find(value => value.eventId === eventId);
  if (!capture || !["unexpected", "ambiguous"].includes(capture.status) || capture.resolution) throw new WorkflowError("Choose an unresolved synthetic discrepancy.");
  capture.resolution = { reason, actorUserId: by.userId, at: by.at }; return state;
}
function request(previous: SyntheticReceivingState, kind: SyntheticReceivingOperation["kind"], operationId: string, by: ReceivingActor, unitId?: string) {
  actor(by);
  if (!workflowCorrelationId.safeParse(operationId).success) throw new WorkflowError("Provide a stable synthetic operation ID.");
  const found = previous.operations.find(value => value.id === operationId);
  if (found) {
    if (found.kind !== kind || found.unitId !== unitId) throw new WorkflowError("An operation ID was reused for another effect/unit.", "receiving_operation_conflict", 409);
    return { state: copyWorkflowJson(previous), operation: copyWorkflowJson(found), replayed: true };
  }
  checkOpen(previous);
  if (previous.operations.length >= 1500) throw new WorkflowError("Synthetic operation limit reached.");
  if (unitId) { unit(previous, unitId); if (!seen(previous, unitId)) throw new WorkflowError("Scan and confirm the exact expected unit before an effect request.", "receiving_unit_not_seen", 409); }
  if (latest(previous, kind, unitId)) throw new WorkflowError("This effect already has a retained operation; inspect or reconcile it instead of issuing another.", "receiving_effect_exists", 409);
  const state = copyWorkflowJson(previous), item: SyntheticReceivingOperation = { id: operationId, kind, ...(unitId ? { unitId } : {}), status: "pending", actorUserId: by.userId, at: by.at };
  state.operations.push(item); return { state, operation: copyWorkflowJson(item), replayed: false };
}
export const requestSyntheticReceivingLabel = (state: SyntheticReceivingState, unitId: string, operationId: string, by: ReceivingActor) => request(state, "label", operationId, by, unitId);
export const requestSyntheticWmsReceipt = (state: SyntheticReceivingState, unitId: string, operationId: string, by: ReceivingActor) => request(state, "receipt", operationId, by, unitId);
function settle(previous: SyntheticReceivingState, operationId: string, status: SyntheticReceivingOperation["status"], receiptId: string, by: ReceivingActor, reconciliationReason?: string) {
  actor(by);
  if (!workflowCorrelationId.safeParse(receiptId).success) throw new WorkflowError("Provide the specific synthetic receipt identity.");
  const state = copyWorkflowJson(previous), item = operation(state, operationId);
  if (item.status === status && item.receiptId === receiptId) return state;
  checkOpen(previous);
  if (reconciliationReason !== undefined) { review(reconciliationReason); if (item.status !== "unknown" || !["confirmed", "physically_confirmed", "failed"].includes(status)) throw new WorkflowError("Reconcile an unknown synthetic result with a specific known outcome."); item.reconciliation = { reason: reconciliationReason, actorUserId: by.userId, at: by.at }; }
  else if (item.kind === "label" && item.status === "acknowledged" && status === "physically_confirmed") { /* Explicit separate synthetic human confirmation. */ }
  else if (item.status !== "pending") throw new WorkflowError("The retained effect cannot be overwritten or replayed; reconcile unknown results.", "receiving_result_conflict", 409);
  if (item.kind === "label" ? !["acknowledged", "physically_confirmed", "failed", "unknown"].includes(status) : !["confirmed", "failed", "unknown"].includes(status)) throw new WorkflowError("Outcome does not belong to this effect type.");
  if (item.kind === "close" && status === "confirmed" && !syntheticReceivingReadiness(state).prerequisitesSatisfied) throw new WorkflowError("Receipt, label and discrepancy completion rules are not met.", "receiving_close_blocked", 409);
  item.status = status; item.receiptId = receiptId;
  if (item.kind === "close" && status === "confirmed") state.closed = true;
  return state;
}
export function settleSyntheticReceivingLabel(state: SyntheticReceivingState, operationId: string, status: "acknowledged" | "physically_confirmed" | "failed" | "unknown", receiptId: string, by: ReceivingActor) {
  if (operation(state, operationId).kind !== "label") throw new WorkflowError("Choose the exact label operation.");
  return settle(state, operationId, status, receiptId, by);
}
export function settleSyntheticWmsReceipt(state: SyntheticReceivingState, operationId: string, status: "confirmed" | "failed" | "unknown", receiptId: string, by: ReceivingActor) {
  if (operation(state, operationId).kind !== "receipt") throw new WorkflowError("Choose the exact unit-receipt operation.");
  return settle(state, operationId, status, receiptId, by);
}
export function reconcileSyntheticReceivingOperation(state: SyntheticReceivingState, operationId: string, status: "confirmed" | "physically_confirmed" | "failed", receiptId: string, reason: string, by: ReceivingActor) { return settle(state, operationId, status, receiptId, by, reason); }
export function syntheticReceivingReadiness(state: SyntheticReceivingState) {
  const expected = units(state), missingUnits = expected.filter(value => !seen(state, value.unitId)).map(value => value.unitId);
  const labelsUnconfirmed = expected.filter(value => latest(state, "label", value.unitId)?.status !== "physically_confirmed").map(value => value.unitId);
  const receiptsUnconfirmed = expected.filter(value => latest(state, "receipt", value.unitId)?.status !== "confirmed").map(value => value.unitId);
  const unresolvedCaptures = state.captures.filter(value => ["unexpected", "ambiguous"].includes(value.status) && !value.resolution).map(value => value.eventId);
  const priorClose = latest(state, "close"), closeUnknown = priorClose?.status === "unknown";
  const blockers = [
    ...(missingUnits.length ? ["Expected units have no qualifying exact scan."] : []),
    ...(labelsUnconfirmed.length ? ["Labels lack separate simulated physical confirmation; a send/ACK is insufficient."] : []),
    ...(receiptsUnconfirmed.length ? ["Individual WMS receipt results are not all confirmed."] : []),
    ...(unresolvedCaptures.length ? ["Unexpected/ambiguous captures require an attributed review."] : []),
  ];
  return { mode: "synthetic" as const, complete: state.closed, prerequisitesSatisfied: blockers.length === 0, readyToClose: !state.closed && !priorClose && blockers.length === 0, status: blockers.length || closeUnknown || priorClose?.status === "failed" ? "red" as const : !state.closed && priorClose ? "yellow" as const : "green" as const, missingUnits, labelsUnconfirmed, receiptsUnconfirmed, unresolvedCaptures, closeUnknown, blockers: [...blockers, ...(closeUnknown ? ["Delivery closure result is unknown; inspect/reconcile the retained close operation."] : []), ...(priorClose?.status === "failed" ? ["Delivery closure failed; inspect the retained close operation."] : [])] };
}
export function requestSyntheticDeliveryClose(state: SyntheticReceivingState, operationId: string, by: ReceivingActor) {
  if (state.operations.some(value => value.id === operationId)) return request(state, "close", operationId, by);
  if (!syntheticReceivingReadiness(state).readyToClose) throw new WorkflowError("Exact scans, physical-label confirmation, individual receipts and discrepancy review must complete before closure.", "receiving_close_blocked", 409);
  return request(state, "close", operationId, by);
}
export function settleSyntheticDeliveryClose(state: SyntheticReceivingState, operationId: string, status: "confirmed" | "failed" | "unknown", receiptId: string, by: ReceivingActor) {
  if (operation(state, operationId).kind !== "close") throw new WorkflowError("Choose the exact close operation.");
  return settle(state, operationId, status, receiptId, by);
}

export const SYNTHETIC_RECEIVING_DELIVERY = {
  id: "SYNTHETIC-INBOUND-001", lines: [
    { lineId: "SYNTHETIC-LINE-1", quantity: 2, units: [{ unitId: "SYNTHETIC-UNIT-A", barcode: "SYNTHETIC-LPN-A01" }, { unitId: "SYNTHETIC-UNIT-B", barcode: "SYNTHETIC-LPN-B01" }] },
  ],
} satisfies { id: string; lines: SyntheticExpectedLine[] };
export const SYNTHETIC_RECEIVING_CONFIG_VERSION = "synthetic-receiving-config-v1";
const action = (name: string, effect: "read" | "write" | "print", providerBinding: string) => ({ id: `synthetic.receiving.${name}`, versionId: `synthetic-${name}-v1`, configurationVersion: SYNTHETIC_RECEIVING_CONFIG_VERSION, capability: "workflow.read", effect, providerBinding });
export const SYNTHETIC_RECEIVING_DEFINITION = validateWorkflowDefinition({
  id: "synthetic-receiving", versionId: "synthetic-receiving-v1", version: 1, configurationVersion: SYNTHETIC_RECEIVING_CONFIG_VERSION, name: "Receiving practice — synthetic only", mode: "synthetic",
  description: "No WMS writes or real printing. Scans, label send/ACK, physical confirmation, individual WMS receipts and closure remain separate simulated facts.",
  startRequirements: [
    { id: "expected-contract", kind: "action", label: "Synthetic expected-delivery reader", fix: "Enable the synthetic adapter; live WMS mappings are unqualified.", actionId: "synthetic.receiving.expected", versionId: "synthetic-expected-v1", configurationVersion: SYNTHETIC_RECEIVING_CONFIG_VERSION },
    { id: "printer-warning", kind: "provider", label: "Authorized synthetic label provider", fix: "Reconnect the pinned synthetic printer before the label step.", binding: "printer", providerType: "synthetic_printer", level: "advisory" },
  ],
  steps: [
    { id: "select", kind: "form", title: "Select a synthetic inbound delivery", saveAs: "selection", fields: [{ key: "deliveryId", label: "Synthetic inbound delivery", type: "choice", choices: [SYNTHETIC_RECEIVING_DELIVERY.id] }] },
    { id: "expected", kind: "action", title: "Load synthetic expected unit slots", action: action("expected", "read", "wms"), parameters: { deliveryId: { source: "data", path: ["selection", "deliveryId"] } } },
    { id: "scan", kind: "scan", title: "Scan exact expected units", description: "Duplicates remain evidence and never count twice. Unexpected or ambiguous captures require review.", expected: { source: "step", stepId: "expected", path: ["units"] }, keyField: "unitId", valueField: "barcode", identityMode: "unit", maxCaptures: 500, bufferWhenProviderBlocked: false },
    { id: "labels", kind: "action", title: "Prepare simulated labels", action: action("labels", "print", "printer"), parameters: { captures: { source: "step", stepId: "scan", path: ["captures"] } } },
    { id: "verifyLabels", kind: "confirm", title: "Confirm simulated label application", prompt: "In this exercise, confirm each synthetic label is physically applied. A browser send/ACK alone is insufficient.", saveAs: "labelsVerified", handoff: "human" },
    { id: "receipts", kind: "action", title: "Submit simulated individual unit receipts", action: action("receipts", "write", "wms"), parameters: { labelsVerified: { source: "data", path: ["labelsVerified"] } } },
    { id: "close", kind: "action", title: "Close only the completed synthetic delivery", action: action("close", "write", "wms"), parameters: {} },
  ],
  completion: { all: [{ operator: "equals", left: { source: "step", stepId: "close", path: ["closed"] }, right: { source: "literal", value: true } }] },
});
export const LIVE_RECEIVING_QUALIFICATION_NEEDED = [
  "Actual WMS upstream identity and warehouse binding, exact inbound-list/detail read contract and completeness rules.",
  "Exact physical-unit/line identifiers and quantity relationships; no order-only identity joins.",
  "Unit-receipt request/result, duplicate protection, uncertain-result lookup/reconciliation and partial-success semantics.",
  "Delivery-close request/result and evidenced completion rules, plus specific live-trial authority.",
  "An authorized label provider/printer with separate send/ACK/physical outcome semantics; live printing remains disabled in this pilot.",
] as const;
/** Demo/test context only. Real services must resolve current memberships, action versions and grants themselves. */
export function createSyntheticReceivingRuntime(siteId: string, actorUserId: string, now: string, options: { printerConnected?: boolean } = {}): WorkflowRuntime {
  const provider = (providerId: string, providerType: string, connected: boolean): WorkflowProviderSnapshot => ({ providerId, providerVersionId: "synthetic-provider-v1", authorizationVersionId: "synthetic-authorization-v1", siteId, providerType, authorizedForActor: true, connected, authenticated: true, actionReady: connected, leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(), authorizationExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(), actionIds: SYNTHETIC_RECEIVING_DEFINITION.steps.filter(step => step.kind === "action").map(step => step.action.id), reason: "Synthetic local provider only; no real upstream authentication or printer status." });
  return { siteId, actorUserId, now, configurationVersion: SYNTHETIC_RECEIVING_CONFIG_VERSION, origin: "operator", capabilities: ["workflow.read", "workflows.manage"], runPermitted: true,
    providers: [provider("synthetic-wms", "synthetic_wms", true), provider("synthetic-printer", "synthetic_printer", options.printerConnected !== false)],
    actions: SYNTHETIC_RECEIVING_DEFINITION.steps.filter(step => step.kind === "action").map(step => ({ id: step.action.id, versionId: step.action.versionId, configurationVersion: step.action.configurationVersion, effect: step.action.effect, siteId, enabled: true, permitted: true, ready: true, qualification: "synthetic" })),
  };
}
export const SYNTHETIC_RECEIVING_BINDINGS = { wms: { providerId: "synthetic-wms", providerVersionId: "synthetic-provider-v1", authorizationVersionId: "synthetic-authorization-v1" }, printer: { providerId: "synthetic-printer", providerVersionId: "synthetic-provider-v1", authorizationVersionId: "synthetic-authorization-v1" } };

/** Actual local simulation, with no HTTP/printer/database side effects. Retain returned state before settling the engine intent. */
export function executeSyntheticReceivingIntent(previous: SyntheticReceivingState, intent: WorkflowEffectIntent, by: ReceivingActor, options: { unknownReceiptUnitIds?: string[]; unknownClose?: boolean } = {}): { state: SyntheticReceivingState; result: WorkflowActionResult } {
  actor(by);
  const step = SYNTHETIC_RECEIVING_DEFINITION.steps.find(value => value.kind === "action" && value.action.id === intent.actionId);
  if (previous.mode !== "synthetic" || intent.mode !== "synthetic" || intent.siteId !== previous.siteId || !step || step.kind !== "action" || step.action.versionId !== intent.actionVersionId || step.action.configurationVersion !== intent.actionConfigurationVersion || intent.configurationVersion !== SYNTHETIC_RECEIVING_CONFIG_VERSION || intent.effect !== step.action.effect) throw new WorkflowError("Only the exact versioned synthetic receiving actions may use this simulator.", "receiving_not_synthetic", 403);
  let state = copyWorkflowJson(previous); let output: JsonValue;
  if (intent.actionId.endsWith(".expected")) {
    if (intent.parameters.deliveryId !== state.deliveryId) throw new WorkflowError("Choose the expected synthetic delivery.");
    output = { deliveryId: state.deliveryId, units: units(state).map(value => ({ unitId: value.unitId, barcode: value.barcode, lineId: value.lineId, quantity: 1 })), source: "synthetic" };
  } else if (intent.actionId.endsWith(".labels")) {
    if (!Array.isArray(intent.parameters.captures)) throw new WorkflowError("The exact captured evidence is required.");
    for (const raw of intent.parameters.captures) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.status !== "matched") continue;
      if (typeof raw.eventId !== "string" || typeof raw.rawValue !== "string" || typeof raw.matchedKey !== "string") throw new WorkflowError("Synthetic captures are malformed.");
      state = recordSyntheticReceivingScan(state, { eventId: raw.eventId, rawValue: raw.rawValue, selectedUnitId: raw.matchedKey }, by).state;
    }
    for (const value of units(state)) {
      const requested = requestSyntheticReceivingLabel(state, value.unitId, `${intent.id}:${value.unitId}`, by); state = requested.state;
      if (!requested.replayed) state = settleSyntheticReceivingLabel(state, requested.operation.id, "acknowledged", `SYNTHETIC-LABEL-ACK:${value.unitId}`, by);
    }
    output = { simulated: true, labels: units(state).map(value => ({ unitId: value.unitId, status: latest(state, "label", value.unitId)!.status })), physicallyConfirmed: false };
  } else if (intent.actionId.endsWith(".receipts")) {
    if (intent.parameters.labelsVerified !== true) throw new WorkflowError("The explicit synthetic label confirmation is missing.");
    for (const value of units(state)) {
      const label = latest(state, "label", value.unitId); if (!label) throw new WorkflowError("A synthetic label operation is missing.");
      if (label.status === "acknowledged") state = settleSyntheticReceivingLabel(state, label.id, "physically_confirmed", `SYNTHETIC-LABEL-CONFIRMED:${value.unitId}`, by);
      const requested = requestSyntheticWmsReceipt(state, value.unitId, `${intent.id}:${value.unitId}`, by); state = requested.state;
      if (!requested.replayed) state = settleSyntheticWmsReceipt(state, requested.operation.id, options.unknownReceiptUnitIds?.includes(value.unitId) ? "unknown" : "confirmed", `SYNTHETIC-UNIT-RECEIPT:${value.unitId}`, by);
    }
    output = { simulated: true, results: units(state).map(value => ({ unitId: value.unitId, status: latest(state, "receipt", value.unitId)!.status })) };
    if (units(state).some(value => latest(state, "receipt", value.unitId)?.status === "unknown")) return { state, result: { outcome: "unknown", output, receiptId: `${intent.id}:batch`, reason: "Some individual synthetic unit receipts are unknown; retain known successes and reconcile only the stopped trail." } };
  } else {
    const requested = requestSyntheticDeliveryClose(state, intent.id, by); state = requested.state;
    if (!requested.replayed) state = settleSyntheticDeliveryClose(state, intent.id, options.unknownClose ? "unknown" : "confirmed", "SYNTHETIC-CLOSE-RECEIPT", by);
    output = { simulated: true, closed: state.closed };
    if (!state.closed) return { state, result: { outcome: "unknown", output, receiptId: `${intent.id}:close`, reason: "Synthetic close result is unknown; do not submit it again." } };
  }
  return { state, result: { outcome: "succeeded", output, receiptId: `${intent.id}:result` } };
}
export function syntheticReceivingStateEqual(left: SyntheticReceivingState, right: SyntheticReceivingState) { return stableWorkflowJson(left) === stableWorkflowJson(right); }
