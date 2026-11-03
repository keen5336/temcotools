import {
  assertWorkflowJson, copyWorkflowJson, evaluateWorkflowCondition, mapWorkflowParameters,
  readWorkflowValue, stableWorkflowJson, validateWorkflowDefinition, validateWorkflowFields,
  workflowId, workflowCorrelationId, WorkflowError, type JsonValue, type WorkflowDefinition, type WorkflowRequirement, type WorkflowStep,
} from "./definition";

export type WorkflowStatus = "running" | "paused" | "blocked" | "human" | "pending" | "failed" | "unknown" | "completed";
export type WorkflowStepStatus = "ready" | "blocked" | "human" | "pending" | "failed" | "unknown" | "complete" | "skipped";
export type EffectKind = "read" | "write" | "print" | "local";
export type ProviderBinding = { providerId: string; providerVersionId: string; authorizationVersionId: string };
/** All runtime snapshots are resolved by trusted server services, never accepted from UI/MCP input. */
export type WorkflowProviderSnapshot = ProviderBinding & {
  siteId: string; providerType: string; authorizedForActor: boolean; connected: boolean; authenticated: boolean; actionReady: boolean;
  leaseExpiresAt: string; authorizationExpiresAt: string; actionIds: string[]; reason?: string; fix?: string;
};
export type WorkflowActionSnapshot = {
  id: string; versionId: string; configurationVersion: string; siteId: string; effect: EffectKind;
  enabled: boolean; permitted: boolean; ready: boolean; qualification: "synthetic" | "application" | "qualified" | "unqualified"; reason?: string; fix?: string;
};
export type WorkflowRuntime = {
  siteId: string; actorUserId: string; capabilities: readonly string[]; runPermitted: boolean; configurationVersion: string; now: string;
  origin: "operator" | "executor" | "reconciler"; providers: readonly WorkflowProviderSnapshot[]; actions: readonly WorkflowActionSnapshot[];
};
export type WorkflowReadinessItem = { id: string; phase: "start" | "step"; kind: "capability" | "provider" | "action" | "run" | "completion"; status: "red" | "yellow" | "green"; label: string; reason: string; fix: string };
export type WorkflowReadiness = { status: "red" | "yellow" | "green"; start: WorkflowReadinessItem[]; step: WorkflowReadinessItem[]; blocking: WorkflowReadinessItem[] };
export type WorkflowCapture = {
  eventId: string; rawValue: string; value: string; quantity: number; source: "scanner" | "manual" | "camera";
  capturedAt: string; recordedAt: string; actorUserId: string; selectedKey?: string;
  status: "matched" | "duplicate" | "unexpected" | "ambiguous" | "excess"; matchedKey?: string;
  buffered: boolean; resolution?: { reason: string; actorUserId: string; at: string };
};
export type WorkflowActionResult = { outcome: "succeeded" | "failed" | "unknown" | "handoff"; output?: JsonValue; receiptId: string; noEffectConfirmed?: boolean; reason?: string };
export type WorkflowEffectIntent = {
  id: string; runId: string; siteId: string; stepId: string; attempt: number; definitionVersionId: string; configurationVersion: string;
  actionId: string; actionVersionId: string; actionConfigurationVersion: string; effect: EffectKind; mode: "synthetic" | "application" | "live";
  actorUserId: string; provider?: ProviderBinding; parameters: Record<string, JsonValue>; createdAt: string;
};
export type WorkflowStepState = { status: WorkflowStepStatus; attempt: number; output?: JsonValue; captures?: WorkflowCapture[]; intent?: WorkflowEffectIntent; result?: WorkflowActionResult; completedAt?: string };
export type WorkflowRun = {
  id: string; siteId: string; definitionId: string; definitionVersionId: string; configurationVersion: string; definition: WorkflowDefinition;
  revision: number; status: WorkflowStatus; started: boolean; paused: boolean; currentStepId: string | null; createdByUserId: string; createdAt: string; updatedAt: string;
  data: Record<string, JsonValue>; providerBindings: Record<string, ProviderBinding>; steps: Record<string, WorkflowStepState>;
  commands: Array<{ id: string; canonicalInput: string; revision: number; intentIds: string[] }>;
  events: Array<{ type: string; stepId: string | null; actorUserId: string; at: string; detail?: string }>;
};
export type WorkflowCommand =
  | { kind: "submit"; values: Record<string, JsonValue> }
  | { kind: "scan"; eventId: string; rawValue: string; quantity?: number; selectedKey?: string; source?: WorkflowCapture["source"]; capturedAt?: string }
  | { kind: "resolve_capture"; eventId: string; reason: string }
  | { kind: "finish_scan" }
  | { kind: "confirm"; accepted: boolean; note?: string; method?: "human" | "manual" }
  | { kind: "refresh" } | { kind: "pause"; reason: string } | { kind: "resume" }
  | { kind: "action_result"; intentId: string; result: WorkflowActionResult }
  | { kind: "reconcile"; intentId: string; result: WorkflowActionResult; reason: string }
  | { kind: "retry_failed"; reason: string };
export type WorkflowCommandInput = { commandId: string; expectedRevision: number; definitionVersionId: string; command: WorkflowCommand };
export type WorkflowTransition = { run: WorkflowRun; intents: WorkflowEffectIntent[]; replayed: boolean; originalRevision?: number; originalIntentIds?: string[] };
const id = (value: string) => { if (!workflowId.safeParse(value).success) throw new WorkflowError("Use a bounded stable workflow ID."); };
const validTime = (value: string) => Number.isFinite(Date.parse(value));
function assertRuntime(run: Pick<WorkflowRun, "siteId" | "configurationVersion">, runtime: WorkflowRuntime) {
  if (run.siteId !== runtime.siteId) throw new WorkflowError("This run belongs to another warehouse.", "workflow_site_mismatch", 403);
  if (run.configurationVersion !== runtime.configurationVersion) throw new WorkflowError("Resolve this run's pinned configuration, not the newest site configuration.", "workflow_configuration_mismatch", 409);
  id(runtime.actorUserId);
  if (!validTime(runtime.now)) throw new WorkflowError("Provide the server execution timestamp.");
}
function stateFor(run: WorkflowRun, step: WorkflowStep) { return run.steps[step.id]; }
function valueContext(run: WorkflowRun) { return { data: run.data, steps: run.steps }; }
function addEvent(run: WorkflowRun, runtime: WorkflowRuntime, type: string, detail?: string) {
  if (run.events.length >= 4096) throw new WorkflowError("Workflow event limit reached. Split the work into bounded runs.", "workflow_limit");
  run.events.push({ type, stepId: run.currentStepId, actorUserId: runtime.actorUserId, at: runtime.now, ...(detail ? { detail } : {}) });
}
function providerReadiness(run: WorkflowRun, runtime: WorkflowRuntime, bindingKey: string): { ready: boolean; reason: string; fix: string } {
  const binding = run.providerBindings[bindingKey];
  if (!binding) return { ready: false, reason: "No provider was explicitly bound to this run.", fix: "Bind an authorized provider when starting the run; another session is not inherited automatically." };
  const provider = runtime.providers.find(value => value.providerId === binding.providerId);
  if (!provider || provider.siteId !== run.siteId) return { ready: false, reason: "The pinned provider is unavailable in this warehouse.", fix: "Reconnect the original provider; do not reroute to another warehouse or person." };
  if (provider.providerVersionId !== binding.providerVersionId || provider.authorizationVersionId !== binding.authorizationVersionId) return { ready: false, reason: "The provider configuration or grant version changed.", fix: "Review the original binding; queued work cannot hot-swap versions or authority." };
  if (!provider.authorizedForActor || !validTime(provider.authorizationExpiresAt) || Date.parse(provider.authorizationExpiresAt) <= Date.parse(runtime.now)) return { ready: false, reason: "Provider sharing is missing, expired or revoked.", fix: "The entitled human must renew or approve the appropriate site-scoped grant." };
  if (!provider.connected || !validTime(provider.leaseExpiresAt) || Date.parse(provider.leaseExpiresAt) <= Date.parse(runtime.now)) return { ready: false, reason: "Provider transport or session lease is disconnected/expired.", fix: provider.fix || "Reconnect the original provider and keep its owning session active." };
  if (!provider.authenticated) return { ready: false, reason: "Transport is connected, but upstream identity is not authenticated.", fix: provider.fix || "The owning person signs in and verifies the correct upstream warehouse." };
  if (!provider.actionReady) return { ready: false, reason: provider.reason || "Provider is not action-ready.", fix: provider.fix || "Resolve the provider's readiness issue." };
  return { ready: true, reason: "The exact bound provider and current grant are ready.", fix: "" };
}
function actionReadiness(run: WorkflowRun, runtime: WorkflowRuntime, actionId: string, versionId: string, configurationVersion: string) {
  const action = runtime.actions.find(value => value.id === actionId && value.versionId === versionId && value.configurationVersion === configurationVersion && value.siteId === run.siteId);
  if (!action) return { ready: false, reason: "The pinned action/configuration version is unavailable.", fix: "Resolve the retained published version; do not substitute a newer action." };
  if (!action.enabled || !action.permitted) return { ready: false, reason: action.reason || "The action is disabled or current authority does not allow it.", fix: action.fix || "Restore permitted site-scoped access or pause this run." };
  const expectedQualification = run.definition.mode === "synthetic" ? "synthetic" : run.definition.mode === "application" ? "application" : "qualified";
  if (action.qualification !== expectedQualification) return { ready: false, reason: run.definition.mode === "synthetic" ? "A synthetic run cannot dispatch a live action." : run.definition.mode === "application" ? "This is not a registered internal application action for this run mode." : "The live upstream contract is unqualified.", fix: run.definition.mode === "synthetic" ? "Use the synthetic action adapter only." : run.definition.mode === "application" ? "Select an exact supported internal action version; external effects remain unavailable." : "Qualify the exact identity/action/site contract and obtain live-trial authority." };
  return { ready: action.ready, reason: action.ready ? "Pinned action is ready." : action.reason || "Action prerequisites are not ready.", fix: action.ready ? "" : action.fix || "Resolve the action's readiness issue." };
}
function requirementItem(run: WorkflowRun, runtime: WorkflowRuntime, requirement: WorkflowRequirement, phase: "start" | "step"): WorkflowReadinessItem {
  const result = requirement.kind === "capability"
    ? { ready: runtime.capabilities.includes(requirement.capability), reason: runtime.capabilities.includes(requirement.capability) ? "Current capability is present." : "Current capability is missing or revoked.", fix: requirement.fix }
    : requirement.kind === "provider" ? providerReadiness(run, runtime, requirement.binding)
      : actionReadiness(run, runtime, requirement.actionId, requirement.versionId, requirement.configurationVersion);
  if (requirement.kind === "provider" && result.ready && requirement.providerType) {
    const provider = runtime.providers.find(value => value.providerId === run.providerBindings[requirement.binding]?.providerId);
    if (provider?.providerType !== requirement.providerType) { result.ready = false; result.reason = "The bound provider has the wrong type."; result.fix = requirement.fix; }
  }
  return { id: requirement.id, phase, kind: requirement.kind, status: result.ready ? "green" : requirement.level === "advisory" ? "yellow" : "red", label: requirement.label, reason: result.reason, fix: result.ready ? "" : result.fix || requirement.fix };
}
export function workflowReadiness(run: WorkflowRun, runtime: WorkflowRuntime): WorkflowReadiness {
  assertRuntime(run, runtime);
  const start = run.definition.startRequirements.map(req => requirementItem(run, runtime, req, "start"));
  const step = run.currentStepId ? run.definition.steps.find(value => value.id === run.currentStepId) : undefined;
  const items = step?.requirements.map(req => requirementItem(run, runtime, req, "step")) ?? [];
  if (!runtime.runPermitted) items.unshift({ id: "run-authority", phase: "step", kind: "run", status: "red", label: "Current warehouse/run authority", reason: "The current actor cannot execute this run.", fix: "Restore current membership, scope and run authority; a saved role is insufficient." });
  if (step?.kind === "confirm" && ["camera", "device"].includes(step.handoff)) items.push({ id: "device-handoff", phase: "step", kind: "provider", status: step.manualFallback ? "yellow" : "red", label: "Actual device handoff", reason: "This workflow has no qualified camera/device capture adapter. No device result has been fabricated.", fix: step.manualFallback ? "Use the explicitly permitted manual fallback and record its actual method." : "A qualified device adapter is required, or publish a new definition permitting a manual fallback. Active definitions remain pinned." });
  if (step?.kind === "action") {
    const ready = actionReadiness(run, runtime, step.action.id, step.action.versionId, step.action.configurationVersion);
    const action = runtime.actions.find(value => value.id === step.action.id && value.versionId === step.action.versionId && value.configurationVersion === step.action.configurationVersion && value.siteId === run.siteId);
    if (action && action.effect !== step.action.effect) { ready.ready = false; ready.reason = "The action's effect differs from the pinned workflow."; ready.fix = "Review the versioned action contract."; }
    if (!runtime.capabilities.includes(step.action.capability)) { ready.ready = false; ready.reason = "Current action capability is missing."; ready.fix = "Restore explicitly permitted action authority."; }
    items.push({ id: `action-${step.id}`, phase: "step", kind: "action", label: step.title, status: ready.ready ? "green" : "red", reason: ready.reason, fix: ready.fix });
    if (step.action.providerBinding) {
      const readyProvider = providerReadiness(run, runtime, step.action.providerBinding);
      const provider = runtime.providers.find(value => value.providerId === run.providerBindings[step.action.providerBinding!]?.providerId);
      if (readyProvider.ready && !provider?.actionIds.includes(step.action.id)) { readyProvider.ready = false; readyProvider.reason = "The provider grant does not permit this named action."; readyProvider.fix = "Obtain a specific human-approved action grant."; }
      items.push({ id: `provider-${step.id}`, phase: "step", kind: "provider", label: "Pinned provider", status: readyProvider.ready ? "green" : "red", reason: readyProvider.reason, fix: readyProvider.fix });
    }
  }
  if (!step && run.definition.completion && !evaluateWorkflowCondition(run.definition.completion, valueContext(run))) items.push({ id: "completion", phase: "step", kind: "completion", status: "red", label: "Completion rules", reason: "The definition's explicit completion rules are not satisfied.", fix: "Reconcile the retained results; do not declare completion from a scheduled action or browser ACK." });
  const retained = step ? run.steps[step.id] : undefined;
  if (retained?.status === "unknown") items.push({ id: "unknown-result", phase: "step", kind: "run", status: "red", label: "Retained unknown outcome", reason: retained.result?.reason || "The external result is uncertain.", fix: "Inspect the retained intent and reconcile its specific result; never automatically resend it." });
  else if (retained?.status === "failed") items.push({ id: "failed-result", phase: "step", kind: "run", status: "red", label: "Retained failed outcome", reason: retained.result?.reason || "The retained action failed.", fix: "Review the failure. An explicitly permitted safe retry requires a new command; unknown effects cannot retry." });
  else if (retained?.status === "pending" || (retained?.status === "human" && retained.intent)) items.push({ id: "awaiting-result", phase: "step", kind: "run", status: "yellow", label: retained.status === "pending" ? "Awaiting action result" : "Human/device handoff", reason: retained.result?.reason || "The original intent is retained and has not completed.", fix: "Wait for or complete the authorized original action; refresh does not dispatch it again." });
  const blocking = [...(!run.started ? start : []), ...items].filter(item => item.status === "red");
  const relevant = [...(!run.started ? start : []), ...items];
  return { status: blocking.length ? "red" : relevant.some(item => item.status === "yellow") ? "yellow" : "green", start, step: items, blocking };
}
function currentStep(run: WorkflowRun): WorkflowStep {
  const step = run.definition.steps.find(value => value.id === run.currentStepId);
  if (!step) throw new WorkflowError("No active step is available.", "workflow_step_unavailable", 409);
  return step;
}
function moveNext(run: WorkflowRun, step: WorkflowStep) {
  const index = run.definition.steps.indexOf(step), nextIndex = step.next ? run.definition.steps.findIndex(value => value.id === step.next) : index + 1;
  for (let i = index + 1; i < nextIndex; i++) if (run.steps[run.definition.steps[i].id].status === "ready") run.steps[run.definition.steps[i].id].status = "skipped";
  run.currentStepId = run.definition.steps[nextIndex]?.id ?? null;
}
function complete(run: WorkflowRun, step: WorkflowStep, runtime: WorkflowRuntime, output?: JsonValue) {
  const state = stateFor(run, step); state.status = "complete"; state.completedAt = runtime.now;
  if (output !== undefined) state.output = copyWorkflowJson(output);
  addEvent(run, runtime, "step_completed"); moveNext(run, step);
}
function progress(run: WorkflowRun, runtime: WorkflowRuntime): WorkflowEffectIntent[] {
  const intents: WorkflowEffectIntent[] = [];
  if (run.paused) { run.status = "paused"; return intents; }
  for (let count = 0; count <= run.definition.steps.length; count++) {
    if (run.currentStepId) {
      const retained = run.steps[run.currentStepId];
      if (["pending", "unknown", "failed"].includes(retained.status) || (retained.status === "human" && retained.intent)) { run.status = retained.status as WorkflowStatus; return intents; }
    }
    const ready = workflowReadiness(run, runtime);
    if (ready.blocking.length) { run.status = "blocked"; if (run.currentStepId && ["ready", "human", "blocked"].includes(run.steps[run.currentStepId].status)) run.steps[run.currentStepId].status = "blocked"; return intents; }
    run.started = true;
    if (!run.currentStepId) { run.status = "completed"; return intents; }
    const step = currentStep(run), state = stateFor(run, step);
    if (["pending", "unknown", "failed"].includes(state.status)) { run.status = state.status as WorkflowStatus; return intents; }
    if (step.kind === "condition") {
      const target = evaluateWorkflowCondition(step.condition, valueContext(run)) ? step.then : step.otherwise;
      state.status = "complete"; state.output = { selectedStepId: target }; state.completedAt = runtime.now;
      const targetIndex = run.definition.steps.findIndex(value => value.id === target), index = run.definition.steps.indexOf(step);
      for (let i = index + 1; i < targetIndex; i++) run.steps[run.definition.steps[i].id].status = "skipped";
      addEvent(run, runtime, "condition_selected", target); run.currentStepId = target; continue;
    }
    if (step.kind !== "action") { state.status = "human"; run.status = "human"; return intents; }
    if (state.intent) throw new WorkflowError("An existing action intent must be reconciled, never silently reissued.", "workflow_intent_exists", 409);
    const provider = step.action.providerBinding ? run.providerBindings[step.action.providerBinding] : undefined;
    const intent: WorkflowEffectIntent = {
      id: `${run.id}:${step.id}:${state.attempt + 1}`, runId: run.id, siteId: run.siteId, stepId: step.id, attempt: state.attempt + 1,
      definitionVersionId: run.definitionVersionId, configurationVersion: run.configurationVersion,
      actionId: step.action.id, actionVersionId: step.action.versionId, actionConfigurationVersion: step.action.configurationVersion,
      effect: step.action.effect, mode: run.definition.mode, actorUserId: runtime.actorUserId,
      ...(provider ? { provider: copyWorkflowJson(provider) } : {}), parameters: mapWorkflowParameters(step.parameters, valueContext(run)), createdAt: runtime.now,
    };
    state.attempt = intent.attempt; state.intent = intent; state.status = "pending"; run.status = "pending";
    addEvent(run, runtime, "intent_prepared", intent.id); intents.push(copyWorkflowJson(intent)); return intents;
  }
  throw new WorkflowError("Workflow transition limit exceeded.");
}
export function createWorkflowRun(input: { id: string; siteId: string; definition: unknown; data?: Record<string, JsonValue>; providerBindings?: Record<string, ProviderBinding> }, runtime: WorkflowRuntime): WorkflowTransition {
  id(input.id); id(input.siteId);
  const definition = validateWorkflowDefinition(input.definition);
  assertWorkflowJson(input.providerBindings ?? {}); assertWorkflowJson(input.data ?? {}, 65_536);
  const bindings = copyWorkflowJson(input.providerBindings ?? {});
  const declaredBindings = new Set([...definition.startRequirements, ...definition.steps.flatMap(step => step.requirements)].flatMap(req => req.kind === "provider" ? [req.binding] : []).concat(definition.steps.flatMap(step => step.kind === "action" && step.action.providerBinding ? [step.action.providerBinding] : [])));
  for (const [key, binding] of Object.entries(bindings)) { if (!declaredBindings.has(key)) throw new WorkflowError("Only declared provider bindings belong to this run."); id(key); id(binding.providerId); id(binding.providerVersionId); id(binding.authorizationVersionId); }
  const data = copyWorkflowJson(input.data ?? {});
  const run: WorkflowRun = {
    id: input.id, siteId: input.siteId, definitionId: definition.id, definitionVersionId: definition.versionId, configurationVersion: definition.configurationVersion,
    definition: copyWorkflowJson(definition), revision: 1, status: "running", started: false, paused: false, currentStepId: definition.steps[0].id,
    createdByUserId: runtime.actorUserId, createdAt: runtime.now, updatedAt: runtime.now, data, providerBindings: bindings,
    steps: Object.fromEntries(definition.steps.map(step => [step.id, { status: "ready", attempt: 0 }])), commands: [], events: [],
  };
  assertRuntime(run, runtime); addEvent(run, runtime, "run_created");
  return { run, intents: progress(run, runtime), replayed: false };
}

type ExpectedScan = { key: string; value: string; quantity: number };
function expectedScans(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "scan" }>): ExpectedScan[] {
  const source = readWorkflowValue(step.expected, valueContext(run));
  if (!Array.isArray(source) || source.length > 1000) throw new WorkflowError("The expected item list is unavailable or exceeds the batch limit.", "workflow_expected_missing");
  const expected = source.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new WorkflowError("Expected items must be typed rows.");
    const key = row[step.keyField], value = row[step.valueField], quantity = row[step.quantityField] ?? 1;
    if (typeof key !== "string" || typeof value !== "string" || !key || key.length > 200 || !value.trim() || value.length > 500 || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 || (step.identityMode === "unit" && quantity !== 1)) throw new WorkflowError("Expected identities/quantities are invalid; unit mode requires exact unit slots.");
    return { key, value: value.trim(), quantity };
  });
  if (new Set(expected.map(row => row.key)).size !== expected.length) throw new WorkflowError("Expected item keys must be unique.");
  return expected;
}
function scanSummary(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "scan" }>) {
  const captures = stateFor(run, step).captures ?? [], expected = expectedScans(run, step);
  const matches = expected.map(row => ({ ...row, observedQuantity: captures.filter(capture => capture.status === "matched" && capture.matchedKey === row.key).reduce((sum, capture) => sum + capture.quantity, 0) }));
  return { captures: copyWorkflowJson(captures), matches, complete: matches.every(row => row.observedQuantity === row.quantity), unresolved: captures.filter(row => ["unexpected", "ambiguous", "excess"].includes(row.status) && !row.resolution).map(row => row.eventId) };
}
function recordScan(run: WorkflowRun, step: Extract<WorkflowStep, { kind: "scan" }>, command: Extract<WorkflowCommand, { kind: "scan" }>, runtime: WorkflowRuntime, buffered: boolean) {
  id(command.eventId);
  if (typeof command.rawValue !== "string" || !command.rawValue.trim() || command.rawValue.length > 500) throw new WorkflowError("Capture a bounded identifier.");
  const quantity = command.quantity ?? 1;
  if (command.source !== undefined && !["scanner", "manual", "camera"].includes(command.source)) throw new WorkflowError("Choose a known capture source.");
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 || (step.identityMode === "unit" && quantity !== 1)) throw new WorkflowError("Unit captures must identify one actual slot; quantity captures need a bounded integer.");
  const state = stateFor(run, step), captures = state.captures ??= [], previous = captures.find(value => value.eventId === command.eventId);
  if (previous) {
    if (previous.rawValue !== command.rawValue || previous.quantity !== quantity || previous.selectedKey !== command.selectedKey || previous.source !== (command.source ?? "scanner")) throw new WorkflowError("A capture event ID was reused with different input.", "workflow_capture_conflict", 409);
    return;
  }
  if (captures.length >= step.maxCaptures) throw new WorkflowError("This step's bounded capture buffer is full.", "workflow_buffer_full");
  const value = command.rawValue.trim(), rows = expectedScans(run, step).filter(row => row.value === value);
  let status: WorkflowCapture["status"] = rows.length ? "matched" : "unexpected", match: ExpectedScan | undefined;
  if (command.selectedKey) { match = rows.find(row => row.key === command.selectedKey); if (!match) throw new WorkflowError("Select only an exact candidate for this captured value."); }
  else if (rows.length > 1) status = "ambiguous";
  else match = rows[0];
  if (match) {
    const observed = captures.filter(row => row.status === "matched" && row.matchedKey === match.key).reduce((sum, row) => sum + row.quantity, 0);
    if (step.identityMode === "unit" && observed) status = "duplicate";
    else if (observed + quantity > match.quantity) status = "excess";
  }
  if (command.capturedAt && !validTime(command.capturedAt)) throw new WorkflowError("Capture timestamp is invalid.");
  captures.push({ eventId: command.eventId, rawValue: command.rawValue, value, quantity, source: command.source ?? "scanner", capturedAt: command.capturedAt ?? runtime.now, recordedAt: runtime.now, actorUserId: runtime.actorUserId, ...(command.selectedKey ? { selectedKey: command.selectedKey } : {}), status, ...(match ? { matchedKey: match.key } : {}), buffered });
  addEvent(run, runtime, "capture_recorded", command.eventId);
}
function validateResult(result: WorkflowActionResult) {
  if (!["succeeded", "failed", "unknown", "handoff"].includes(result.outcome)) throw new WorkflowError("Unknown action result.");
  if (!workflowCorrelationId.safeParse(result.receiptId).success) throw new WorkflowError("Use a bounded stable result receipt ID.");
  if (result.output !== undefined) assertWorkflowJson(result.output, 65_536);
  if (result.reason && result.reason.length > 1000) throw new WorkflowError("Result explanation is too long.");
}
export function advanceWorkflowRun(previous: WorkflowRun, input: WorkflowCommandInput, runtime: WorkflowRuntime): WorkflowTransition {
  assertRuntime(previous, runtime); id(input.commandId); assertWorkflowJson(input, 65_536);
  if (input.definitionVersionId !== previous.definitionVersionId) throw new WorkflowError("The client is using another workflow version.", "workflow_definition_mismatch", 409);
  if (!runtime.runPermitted && !["action_result", "reconcile", "pause"].includes(input.command.kind)) throw new WorkflowError("Current run authority is missing or revoked.", "workflow_authority", 403);
  const canonicalInput = stableWorkflowJson(input), saved = previous.commands.find(command => command.id === input.commandId);
  if (saved) {
    if (saved.canonicalInput !== canonicalInput) throw new WorkflowError("A command ID was reused with different input.", "workflow_command_conflict", 409);
    return { run: copyWorkflowJson(previous), intents: [], replayed: true, originalRevision: saved.revision, originalIntentIds: [...saved.intentIds] };
  }
  if (input.expectedRevision !== previous.revision) throw new WorkflowError("This run changed. Reload before applying another command.", "workflow_revision_conflict", 409);
  if (previous.commands.length >= 2048) throw new WorkflowError("Workflow command limit reached.", "workflow_limit");
  const run = copyWorkflowJson(previous), command = input.command;
  if (run.status === "completed") throw new WorkflowError("Completed runs are immutable; use an explicit amendment/new run.", "workflow_complete", 409);
  if (!runtime.runPermitted && !["action_result", "reconcile", "pause"].includes(command.kind)) throw new WorkflowError("Current run authority is missing or revoked.", "workflow_authority", 403);
  if (command.kind === "pause") {
    if (!command.reason?.trim() || command.reason.length > 500) throw new WorkflowError("Explain why this run is paused.");
    run.paused = true; addEvent(run, runtime, "run_paused", command.reason);
  } else if (command.kind === "resume") { run.paused = false; addEvent(run, runtime, "run_resumed"); }
  else if (command.kind !== "refresh") {
    const step = currentStep(run), state = stateFor(run, step);
    if (["action_result", "reconcile"].includes(command.kind)) {
      if (runtime.origin === "operator" || (command.kind === "reconcile" && runtime.origin !== "reconciler")) throw new WorkflowError("Only the trusted adapter/reconciliation service can settle an external result.", "workflow_result_authority", 403);
      const resultCommand = command as Extract<WorkflowCommand, { kind: "action_result" | "reconcile" }>;
      if (step.kind !== "action" || !state.intent || state.intent.id !== resultCommand.intentId) throw new WorkflowError("The result does not match the retained intent.", "workflow_intent_mismatch", 409);
      if (command.kind === "reconcile") {
        if (state.status !== "unknown" || !command.reason?.trim() || command.reason.length > 500 || !["succeeded", "failed"].includes(command.result.outcome)) throw new WorkflowError("Reconcile an unknown outcome with an explicit known result and reason.");
        addEvent(run, runtime, "unknown_reconciled", command.reason);
      } else if (state.status !== "pending" && !(state.status === "human" && state.result?.outcome === "handoff")) throw new WorkflowError("The intent is already settled or requires explicit reconciliation.", "workflow_result_conflict", 409);
      validateResult(resultCommand.result); state.result = copyWorkflowJson(resultCommand.result);
      if (resultCommand.result.outcome === "succeeded") complete(run, step, runtime, resultCommand.result.output ?? null);
      else if (resultCommand.result.outcome === "handoff") { state.status = "human"; if (resultCommand.result.output !== undefined) state.output = copyWorkflowJson(resultCommand.result.output); addEvent(run, runtime, "action_handoff", resultCommand.result.receiptId); }
      else { state.status = resultCommand.result.outcome; addEvent(run, runtime, `action_${state.status}`, resultCommand.result.receiptId); }
    } else if (command.kind === "retry_failed") {
      if (step.kind !== "action" || !step.retryKnownFailure || state.status !== "failed" || (step.action.effect !== "read" && state.result?.noEffectConfirmed !== true) || state.attempt >= 3 || !command.reason?.trim() || command.reason.length > 500) throw new WorkflowError("Only an explicit bounded retry of a known safe failure is permitted; unknown outcomes are never retried.", "workflow_retry_forbidden", 409);
      delete state.intent; delete state.result; state.status = "ready"; addEvent(run, runtime, "known_failure_retry_authorized", command.reason);
    } else {
      if (run.paused) throw new WorkflowError("Resume the run before new operator work.", "workflow_paused", 409);
      const ready = workflowReadiness(run, runtime), canBuffer = command.kind === "scan" && step.kind === "scan" && step.bufferWhenProviderBlocked && ready.blocking.length > 0 && ready.blocking.every(item => item.kind === "provider");
      if (ready.blocking.length && !canBuffer) throw new WorkflowError(ready.blocking[0].reason, "workflow_blocked", 409);
      if (command.kind === "submit" && step.kind === "form") {
        const values = validateWorkflowFields(step.fields, command.values); run.data[step.saveAs] = values; complete(run, step, runtime, values);
      } else if (command.kind === "scan" && step.kind === "scan") recordScan(run, step, command, runtime, canBuffer);
      else if (command.kind === "resolve_capture" && step.kind === "scan") {
        if (!runtime.capabilities.includes(step.discrepancyCapability)) throw new WorkflowError("A permitted reviewer must resolve this discrepancy.", "workflow_discrepancy_authority", 403);
        if (!command.reason?.trim() || command.reason.length > 500) throw new WorkflowError("Record the review reason.");
        const capture = state.captures?.find(value => value.eventId === command.eventId);
        if (!capture || !["unexpected", "ambiguous", "excess"].includes(capture.status) || capture.resolution) throw new WorkflowError("Choose an unresolved discrepancy.");
        capture.resolution = { reason: command.reason, actorUserId: runtime.actorUserId, at: runtime.now }; addEvent(run, runtime, "capture_reviewed", command.eventId);
      } else if (command.kind === "finish_scan" && step.kind === "scan") {
        const summary = scanSummary(run, step);
        if (!summary.complete || summary.unresolved.length) throw new WorkflowError("Exact required quantities and discrepancy review must be complete.", "workflow_scan_incomplete", 409);
        complete(run, step, runtime, summary as unknown as JsonValue);
      } else if (command.kind === "confirm" && step.kind === "confirm") {
        if (command.note && command.note.length > 1000) throw new WorkflowError("Confirmation note is too long.");
        if (typeof command.accepted !== "boolean") throw new WorkflowError("Explicit confirmation is required.");
        const deviceHandoff = ["camera", "device"].includes(step.handoff);
        if (deviceHandoff && (!step.manualFallback || command.method !== "manual")) throw new WorkflowError("Complete an actual authorized device handoff or explicitly use this definition's manual fallback; a boolean is not device evidence.", "workflow_device_handoff", 409);
        if (command.accepted) { run.data[step.saveAs] = true; complete(run, step, runtime, { confirmed: true, actorUserId: runtime.actorUserId, at: runtime.now, note: command.note ?? "", handoff: step.handoff, method: command.method ?? "human", deviceVerified: false }); }
        else addEvent(run, runtime, "confirmation_declined", command.note);
      } else throw new WorkflowError("This command does not apply to the active step.", "workflow_command_wrong_step", 409);
    }
  }
  const intents = progress(run, runtime);
  run.revision++; run.updatedAt = runtime.now; run.commands.push({ id: input.commandId, canonicalInput, revision: run.revision, intentIds: intents.map(intent => intent.id) });
  assertWorkflowJson(run, 4 * 1024 * 1024);
  return { run, intents, replayed: false };
}
