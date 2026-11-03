import { assertTemplateWorkflowWrite } from "@/lib/templates/service";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import { warehouseIdentifierInput, resolveWarehouseIdentifierInTransaction, recordWarehouseObservationInTransaction } from "@/lib/warehouse/units";
import { assertWorkflowJson, copyWorkflowJson, stableWorkflowJson, validateWorkflowDefinition, workflowId, workflowKey, WorkflowError, type JsonValue, type WorkflowDefinition } from "./definition";
import { advanceWorkflowRun, createWorkflowRun, workflowReadiness, type WorkflowCommand, type WorkflowEffectIntent, type WorkflowRun, type WorkflowRuntime, type WorkflowTransition } from "./engine";
import { createSyntheticReceiving, createSyntheticReceivingRuntime, executeSyntheticReceivingIntent, syntheticReceivingReadiness, SYNTHETIC_RECEIVING_BINDINGS, SYNTHETIC_RECEIVING_DEFINITION, SYNTHETIC_RECEIVING_DELIVERY, LIVE_RECEIVING_QUALIFICATION_NEEDED, type SyntheticReceivingState } from "./receiving";
import { contactWorkflowProviderRead, isProviderWorkflowIntent, resolveWorkflowBindings, stampWorkflowProviderIntent, workflowProviderBindingsInput, workflowProviderCatalog, workflowProviderExecuteInput, workflowProviderRuntime } from "./provider-execution";
import { providerActor } from "@/lib/integrations/dispatch";
import { getIntegrationOperation, resolveWorkflowProviderInTransaction } from "@/lib/integrations/provider-runtime";
import type { WorkflowActionResult, ProviderBinding } from "./engine";
export { workflowProviderExecuteInput } from "./provider-execution";

const operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/), revision = z.number().int().positive();
const definitionBody = z.unknown().refine(value => value !== undefined, "Provide a JSON definition.");
const dataBody = z.record(workflowKey, z.unknown());
const auditNote = z.string().trim().min(5).max(500);
const page = { afterId: workflowId.optional(), limit: z.number().int().min(1).max(50).default(25) };
export const workflowListInput = z.object(page).strict();
export const workflowGetInput = z.object({ id: workflowId }).strict();
export const workflowCreateInput = z.object({ operationId, name: z.string().trim().min(1).max(160), definition: definitionBody }).strict();
export const workflowSaveInput = workflowCreateInput.extend({ id: workflowId, expectedRevision: revision });
export const workflowValidateInput = z.object({ definition: definitionBody }).strict();
const operatorCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("submit"), values: dataBody }).strict(),
  z.object({ kind: z.literal("scan"), eventId: workflowId, rawValue: z.string().min(1).max(500), quantity: z.number().int().min(1).max(100).optional(), selectedKey: z.string().min(1).max(200).optional(), source: z.enum(["scanner", "manual", "camera"]).optional(), capturedAt: z.string().datetime({ offset: true }).optional() }).strict(),
  z.object({ kind: z.literal("resolve_capture"), eventId: workflowId, reason: auditNote }).strict(),
  z.object({ kind: z.literal("finish_scan") }).strict(),
  z.object({ kind: z.literal("confirm"), accepted: z.boolean(), note: z.string().max(1000).optional(), method: z.enum(["human", "manual"]).optional() }).strict(),
  z.object({ kind: z.literal("pause"), reason: auditNote }).strict(),
  z.object({ kind: z.literal("resume") }).strict(), z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("retry_failed"), reason: auditNote }).strict(),
]);
export const workflowTestInput = workflowValidateInput.extend({ data: dataBody.optional(), commands: z.array(operatorCommand).max(100).default([]) });
export const workflowPublishInput = z.object({ operationId, id: workflowId, expectedRevision: revision, note: auditNote }).strict();
export const workflowRollbackInput = workflowPublishInput.extend({ versionId: workflowId });
export const workflowEnabledInput = workflowPublishInput.extend({ enabled: z.boolean() });
export const workflowStartInput = z.object({ operationId, definitionId: workflowId.optional(), expectedDefinitionVersionId: workflowId.optional(), template: z.enum(["synthetic_receiving", "warehouse_presence"]).optional(), data: dataBody.optional(), providerBindings: workflowProviderBindingsInput.optional() }).strict().superRefine((input, ctx) => { if (Boolean(input.definitionId) === Boolean(input.template)) ctx.addIssue({ code: "custom", message: "Choose one published workflow or a supported built-in template." }); });
export const workflowActionCatalogInput = z.object({}).strict();
export const workflowCommandServiceInput = z.object({ runId: workflowId, commandId: operationId, expectedRevision: revision, definitionVersionId: workflowId, command: operatorCommand }).strict();
export const workflowRunGetInput = z.object({ runId: workflowId }).strict();
export const workflowRunListInput = z.object({ ...page, status: z.enum(["running", "paused", "blocked", "human", "pending", "failed", "unknown", "completed"]).optional() }).strict();

const hash = (value: unknown) => createHash("sha256").update(stableWorkflowJson(value)).digest("hex");
function asJson(value: unknown): Prisma.InputJsonValue { assertWorkflowJson(value, 4 * 1024 * 1024); return value as Prisma.InputJsonValue; }
function siteOf(p: Principal) { if (!p.siteId || !p.sessionId) throw new AuthorizationError("Select a current authorized warehouse and individual session."); return p.siteId; }
function conflict() { return new WorkflowError("This workflow changed. Reload the current revision before saving.", "workflow_revision_conflict", 409); }
function notFound() { return new WorkflowError("Workflow not found in your current warehouse.", "workflow_not_found", 404); }
async function current(tx: Prisma.TransactionClient, p: Principal, manage = false, fresh = false) {
  const principal = await assertCurrentPrincipal(tx, p, manage ? "workflows.manage" : "workflow.read", fresh); siteOf(principal); return principal;
}
async function audit(tx: Prisma.TransactionClient, p: Principal, action: string, detail: string) { await tx.identityAudit.create({ data: { siteId: siteOf(p), actorUserId: p.userId, sessionId: p.sessionId, action, reason: detail } }); }
async function lockedDefinition(tx: Prisma.TransactionClient, p: Principal, id: string, expectedRevision: number) {
  await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${id} AND "siteId"=${siteOf(p)} FOR UPDATE`;
  const found = await tx.workflowDefinitionRecord.findFirst({ where: { id, siteId: siteOf(p) } });
  if (!found) throw notFound(); if (found.revision !== expectedRevision) throw conflict(); return found;
}
type ActionPin = Extract<WorkflowDefinition["steps"][number], { kind: "action" }>["action"];
const domainConfig = "workflow-domain-v1";
const resolvePin = { id: "warehouse.resolve", versionId: "warehouse-resolve-v1", configurationVersion: domainConfig, capability: "inventory.read", effect: "read" } as const;
const observePin = { id: "warehouse.observe", versionId: "warehouse-observe-v1", configurationVersion: domainConfig, capability: "inventory.write", effect: "write" } as const;
const observationParameters = z.object({ captureStepId: workflowKey, lookupStepId: workflowKey, confirmationStepId: workflowKey, identifierType: z.enum(["auto", "lpn", "msn", "serial", "submission"]).default("auto"), namespace: z.string().trim().max(100).optional() }).strict();
const captureFields = z.object({ rawIdentifier: z.string().min(1).max(500), captureMethod: z.enum(["manual", "scanner"]), location: z.string().trim().max(200).optional() }).strict();
const resolvedOutput = z.object({ resolution: z.enum(["resolved", "ambiguous", "unresolved"]), unitId: z.string().nullable(), candidateUnitIds: z.array(z.string()).max(101), candidates: z.array(z.object({ unitId: z.string(), lpns: z.array(z.string()), reportedRows: z.array(z.object({ lpn: z.string(), orderNumber: z.string(), description: z.string(), status: z.string() }).strict()), createdAt: z.string() }).strict()).max(101), truncated: z.boolean(), physicalPresence: z.literal("not_determined") }).strict();
const observationResolution = z.enum(["resolved", "ambiguous", "unresolved"]);
const observationOutput = z.object({ observation: z.object({ observationId: z.string(), eventId: z.string(), capturedByUserId: z.string(), rawIdentifier: z.string(), identifierType: z.string(), namespace: z.string().nullable(), type: z.literal("presence"), location: z.string().nullable(), deviceId: z.string().nullable(), pickWaveId: z.string().nullable(), captureMethod: z.enum(["manual", "scanner"]), capturedAt: z.string(), receivedAt: z.string(), unitId: z.string().nullable(), resolution: observationResolution, candidateUnitIds: z.array(z.string()).max(101) }).strict(), resolution: observationResolution, unitId: z.string().nullable(), candidateUnitIds: z.array(z.string()).max(101), replayed: z.boolean() }).strict();
type ActionAdapter = "echo" | "receiving" | "resolve" | "observe";
type CatalogEntry = { pin: ActionPin; name: string; modes: Array<"synthetic" | "application">; adapter: ActionAdapter; input: z.ZodType; output: z.ZodType; description: string };
const registeredActions: CatalogEntry[] = [
  { pin: { id: "workflow.local.echo", versionId: "workflow-local-echo-v1", configurationVersion: "workflow-local-config-v1", capability: "workflow.read", effect: "local" }, name: "Local mapped result", modes: ["synthetic", "application"], adapter: "echo", input: z.record(workflowKey, z.unknown()), output: z.record(workflowKey, z.unknown()), description: "Returns mapped JSON locally without inventory or external effects." },
  { pin: resolvePin, name: "Global warehouse unit lookup", modes: ["application"], adapter: "resolve", input: warehouseIdentifierInput.strict(), output: resolvedOutput, description: "Uses the existing global LPN/MSN/serial/submission resolver. Reported rows and order context do not establish physical presence." },
  { pin: observePin, name: "Record observed physical presence", modes: ["application"], adapter: "observe", input: observationParameters, output: observationOutput, description: "Calls the existing inventory.write observation command in this transaction after a same-person capture and explicit confirmation. Does not receive, place, ship, print or change WMS." },
  ...SYNTHETIC_RECEIVING_DEFINITION.steps.flatMap(step => step.kind === "action" ? [{ pin: step.action, name: step.title, modes: ["synthetic"] as Array<"synthetic">, adapter: "receiving" as const, input: step.action.id.endsWith(".expected") ? z.object({ deliveryId: z.string().min(1).max(128) }).strict() : step.action.id.endsWith(".labels") ? z.object({ captures: z.array(z.unknown()).max(1000) }).strict() : step.action.id.endsWith(".receipts") ? z.object({ labelsVerified: z.literal(true) }).strict() : z.object({}).strict(), output: z.unknown(), description: "Synthetic Receiving fixture only. No actual WMS or printer contact." }] : []),
];
function supportedAction(pin: ActionPin) { return registeredActions.find(entry => stableWorkflowJson(entry.pin) === stableWorkflowJson(pin)) ?? null; }
/** Exact registered versions only; definition data never creates adapter authority. */
function runtimeFor(definition: WorkflowDefinition, p: Principal, enabled = true, preview = false): WorkflowRuntime {
  const base = createSyntheticReceivingRuntime(siteOf(p), p.userId, new Date().toISOString());
  return { ...base, configurationVersion: definition.configurationVersion, capabilities: p.capabilities, runPermitted: enabled && p.capabilities.includes("workflow.read"), actions: definition.steps.flatMap(step => {
    if (step.kind !== "action") return [];
    const entry = supportedAction(step.action), modeAllowed = Boolean(entry && entry.modes.includes(definition.mode as "synthetic" | "application")), capability = (p.capabilities as readonly string[]).includes(step.action.capability), previewWrite = preview && entry?.adapter === "observe";
    return [{ id: step.action.id, versionId: step.action.versionId, configurationVersion: step.action.configurationVersion, siteId: siteOf(p), effect: step.action.effect, enabled, permitted: modeAllowed && capability, ready: modeAllowed && capability && !previewWrite, qualification: modeAllowed ? definition.mode === "application" ? "application" as const : "synthetic" as const : "unqualified" as const, reason: !enabled ? "This workflow definition is disabled for further execution." : previewWrite ? "Draft testing never persists physical observations." : !entry ? "This exact action/configuration version is not registered." : !modeAllowed ? "This action is unavailable in the selected workflow mode; external live effects stay disabled." : !capability ? `Current ${step.action.capability} capability/client scope is missing or revoked.` : "Registered internal action is ready.", fix: previewWrite ? "Start a published application workflow and explicitly confirm an actual observation." : "Select an exact supported action and current site-scoped authority from the catalog." }];
  }) };
}
async function runtimeForRun(tx: Prisma.TransactionClient, definition: WorkflowDefinition, p: Principal, enabled = true, bindings: Record<string, ProviderBinding> = {}, preview = false): Promise<WorkflowRuntime> {
  const base = runtimeFor(definition, p, enabled, preview), external = await workflowProviderRuntime(tx, p, definition, bindings, preview);
  return { ...base, providers: [...base.providers, ...external.providers], actions: [...base.actions.filter(action => !external.actions.some(value => value.id === action.id && value.versionId === action.versionId && value.configurationVersion === action.configurationVersion)), ...external.actions] };
}
function catalogFor(p: Principal) {
  return { siteId: siteOf(p), actions: registeredActions.map(entry => ({ ...entry.pin, name: entry.name, modes: entry.modes, description: entry.description, inputSchema: z.toJSONSchema(entry.input, { io: "input", unrepresentable: "any" }), outputSchema: z.toJSONSchema(entry.output, { io: "output", unrepresentable: "any" }), ready: (p.capabilities as readonly string[]).includes(entry.pin.capability), reason: (p.capabilities as readonly string[]).includes(entry.pin.capability) ? "Current capability is present; each step rechecks it." : `Requires current ${entry.pin.capability} and client scope.` })), handoffs: [{ kind: "human", ready: true, description: "Explicit attributed human confirmation; no device claim." }, { kind: "camera", ready: false, description: "Qualified capture provider pending. Only an explicitly defined manual fallback can complete now." }, { kind: "device", ready: false, description: "Qualified device provider pending. No server camera or printer is assumed." }], externalLiveExecutionAvailable: false };
}
export async function getWorkflowActionCatalog(p: Principal, input: unknown = {}) { workflowActionCatalogInput.parse(input); return prisma.$transaction(async tx => { const actor = await current(tx, p), providerReads = await workflowProviderCatalog(tx, actor); return { ...catalogFor(actor), providerReads, externalLiveExecutionAvailable: providerReads.some(value => value.qualification === "qualified" && value.ready), externalReadExecutionAvailable: true, externalMutationExecutionAvailable: false }; }); }
export const WAREHOUSE_PRESENCE_DEFINITION = validateWorkflowDefinition({
  id: "warehouse-presence", versionId: "warehouse-presence-v1", version: 1, configurationVersion: domainConfig, name: "Look up and confirm physical presence", mode: "application", description: "Reads shared unit history, then records only an explicitly confirmed local physical presence observation. No external WMS or printer effect.",
  steps: [
    { id: "capture", kind: "form", title: "Capture an identifier you physically observed", saveAs: "capture", fields: [{ key: "rawIdentifier", label: "Observed LPN, MSN, serial or submission barcode", type: "identifier", maxLength: 500 }, { key: "captureMethod", label: "Actual capture method", type: "choice", choices: ["manual", "scanner"] }, { key: "location", label: "Observed location (optional)", type: "text", required: false, maxLength: 200 }] },
    { id: "lookup", kind: "action", title: "Identify globally across warehouse history", action: resolvePin, parameters: { value: { source: "data", path: ["capture", "rawIdentifier"] }, kind: { source: "literal", value: "auto" } } },
    { id: "confirmPresence", kind: "confirm", title: "Confirm what you observed", prompt: "I physically observed this captured identifier at the stated location. A lookup or planned movement alone is not physical presence.", saveAs: "presenceConfirmed", handoff: "human" },
    { id: "observe", kind: "action", title: "Record the confirmed presence observation", action: observePin, parameters: { captureStepId: { source: "literal", value: "capture" }, lookupStepId: { source: "literal", value: "lookup" }, confirmationStepId: { source: "literal", value: "confirmPresence" }, identifierType: { source: "literal", value: "auto" } } },
  ], completion: { all: [{ operator: "exists", left: { source: "step", stepId: "observe", path: ["observation", "observationId"] } }] },
});
function bindingsFor(definition: WorkflowDefinition) {
  const keys = new Set([...definition.startRequirements, ...definition.steps.flatMap(step => step.requirements)].flatMap(req => req.kind === "provider" ? [req.binding] : []).concat(definition.steps.flatMap(step => step.kind === "action" && step.action.providerBinding ? [step.action.providerBinding] : [])));
  return Object.fromEntries(Object.entries(SYNTHETIC_RECEIVING_BINDINGS).filter(([key]) => keys.has(key)));
}
function receivingFor(definition: WorkflowDefinition, siteId: string) {
  return definition.steps.some(step => step.kind === "action" && supportedAction(step.action)?.adapter === "receiving") ? createSyntheticReceiving(siteId, SYNTHETIC_RECEIVING_DELIVERY.id, SYNTHETIC_RECEIVING_DELIVERY.lines) : null;
}
function assertExecutable(definition: WorkflowDefinition) {
  if (definition.mode === "live") throw new WorkflowError("Live workflow execution is unavailable. Actual upstream receipt/close contracts and specific trial authority are pending; use synthetic practice or registered internal application actions.", "workflow_live_unavailable", 403);
}
async function localResult(tx: Prisma.TransactionClient, run: WorkflowRun, intent: WorkflowEffectIntent, state: SyntheticReceivingState | null, p: Principal) {
  const step = run.definition.steps.find(candidate => candidate.id === intent.stepId), entry = step?.kind === "action" ? supportedAction(step.action) : null;
  if (!entry || intent.actionId !== entry.pin.id || intent.actionVersionId !== entry.pin.versionId || intent.actionConfigurationVersion !== entry.pin.configurationVersion || intent.siteId !== siteOf(p) || intent.runId !== run.id || !entry.modes.includes(intent.mode as "synthetic" | "application")) throw new WorkflowError("The retained action version/mode/site is not registered.", "workflow_action_unavailable", 409);
  assertWorkflowJson(intent.parameters, 65_536); const values = entry.input.parse(intent.parameters);
  let output: unknown;
  if (entry.adapter === "echo") output = copyWorkflowJson(values);
  else if (entry.adapter === "resolve") {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.read");
    if (actor.siteId !== run.siteId) throw new AuthorizationError("Lookup warehouse changed.");
    output = { ...await resolveWarehouseIdentifierInTransaction(tx, warehouseIdentifierInput.parse(values)), physicalPresence: "not_determined" };
  } else if (entry.adapter === "observe") {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.write"), parameters = observationParameters.parse(values);
    const captureIndex = run.definition.steps.findIndex(candidate => candidate.id === parameters.captureStepId), lookupIndex = run.definition.steps.findIndex(candidate => candidate.id === parameters.lookupStepId), confirmIndex = run.definition.steps.findIndex(candidate => candidate.id === parameters.confirmationStepId), actionIndex = run.definition.steps.findIndex(candidate => candidate.id === intent.stepId);
    const capture = run.steps[parameters.captureStepId], lookup = run.steps[parameters.lookupStepId], confirmation = run.steps[parameters.confirmationStepId], captureDefinition = run.definition.steps[captureIndex], lookupDefinition = run.definition.steps[lookupIndex], confirmDefinition = run.definition.steps[confirmIndex];
    const confirmOutput = confirmation?.output as { confirmed?: boolean; actorUserId?: string; method?: string; handoff?: string } | undefined;
    if (run.createdByUserId !== actor.userId || actor.siteId !== run.siteId || captureIndex < 0 || lookupIndex <= captureIndex || confirmIndex <= lookupIndex || actionIndex <= confirmIndex || captureDefinition?.kind !== "form" || lookupDefinition?.kind !== "action" || supportedAction(lookupDefinition.action)?.adapter !== "resolve" || lookup?.status !== "complete" || confirmDefinition?.kind !== "confirm" || capture?.status !== "complete" || !capture.completedAt || confirmation?.status !== "complete" || confirmOutput?.confirmed !== true || confirmOutput.actorUserId !== actor.userId || (["camera", "device"].includes(confirmDefinition.handoff) && (!confirmDefinition.manualFallback || confirmOutput.method !== "manual"))) throw new WorkflowError("A same-person completed capture, global lookup and later explicit confirmation are required before an observation. Mapped literals are not physical evidence.", "workflow_observation_confirmation", 409);
    const fields = captureFields.parse(capture.output);
    const lookupInput = warehouseIdentifierInput.parse(lookup.intent?.parameters), priorResolution = resolvedOutput.parse(lookup.output);
    if (lookupInput.value.trim().toUpperCase() !== fields.rawIdentifier.trim().toUpperCase() || (lookupInput.kind ?? "auto") !== parameters.identifierType || (lookupInput.namespace ?? "").trim().toLowerCase() !== (parameters.namespace ?? "").trim().toLowerCase()) throw new WorkflowError("The confirmed capture does not match its retained global lookup.", "workflow_observation_lookup", 409);
    output = await recordWarehouseObservationInTransaction(tx, actor, { eventId: `workflow-presence:${hash([run.id, intent.stepId, intent.actionVersionId]).slice(0, 64)}`, rawIdentifier: fields.rawIdentifier, identifierType: parameters.identifierType, namespace: parameters.namespace, type: "presence", location: fields.location, capturedAt: capture.completedAt, capturedByUserId: actor.userId, captureMethod: fields.captureMethod });
    const observed = output as { resolution: string; unitId: string | null; candidateUnitIds: JsonValue };
    if (observed.resolution !== priorResolution.resolution || observed.unitId !== priorResolution.unitId || stableWorkflowJson(observed.candidateUnitIds) !== stableWorkflowJson(priorResolution.candidateUnitIds)) throw new WorkflowError("Identifier links changed after lookup. No observation was committed. Start a fresh lookup before confirming this physical unit.", "workflow_observation_identity_changed", 409);
  } else {
    if (!state) throw new WorkflowError("The local Receiving fixture is missing.");
    return executeSyntheticReceivingIntent(state, intent, { userId: p.userId, at: new Date().toISOString() });
  }
  const validated = entry.output.parse(output); assertWorkflowJson(validated, 65_536);
  return { state, result: { outcome: "succeeded" as const, output: validated as JsonValue, receiptId: `${entry.adapter}:${hash(intent.id).slice(0, 48)}` } };
}
async function recordEvent(tx: Prisma.TransactionClient, p: Principal, runId: string, commandId: string, kind: string, detail: unknown) {
  return tx.workflowRunEvent.create({ data: { siteId: siteOf(p), runId, actorUserId: p.userId, actorSessionId: p.sessionId!, commandId, kind, detail: asJson(detail) } });
}
async function settleLocal(tx: Prisma.TransactionClient, p: Principal, transition: WorkflowTransition, state: SyntheticReceivingState | null, enabled: boolean) {
  let next = transition, receiving = state;
  for (let count = 0; next.intents.length && count < 40; count++) {
    const intent = next.intents[0];
    // No external IO happens in this transaction. A future live dispatcher must
    // commit an outbox first, then recheck authority before any external contact.
    const fresh = await current(tx, p), runtime = await runtimeForRun(tx, next.run.definition, fresh, enabled, next.run.providerBindings);
    const readiness = workflowReadiness(next.run, runtime);
    if (readiness.blocking.length) throw new WorkflowError(readiness.blocking[0].reason, "workflow_blocked", 409);
    stampWorkflowProviderIntent(next.run, intent, fresh);
    await tx.workflowIntentRecord.create({ data: { id: intent.id, siteId: siteOf(fresh), runId: intent.runId, stepId: intent.stepId, attempt: intent.attempt, state: "prepared", intent: asJson(intent) } });
    if (isProviderWorkflowIntent(intent)) return { run: next.run, receiving };
    const settled = await localResult(tx, next.run, intent, receiving, fresh); receiving = settled.state;
    await tx.workflowIntentRecord.update({ where: { id: intent.id }, data: { state: settled.result.outcome, result: asJson(settled.result), revision: { increment: 1 } } });
    const commandId = `sim:${hash(intent.id).slice(0, 48)}`;
    next = advanceWorkflowRun(next.run, { commandId, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: { kind: "action_result", intentId: intent.id, result: settled.result } }, { ...runtime, origin: "executor" });
    await recordEvent(tx, fresh, next.run.id, commandId, next.run.definition.mode === "application" ? "application_action_result" : "synthetic_action_result", { intent, result: settled.result, revision: next.run.revision });
  }
  if (next.intents.length) throw new WorkflowError("Local workflow transition limit reached.");
  return { run: next.run, receiving };
}
async function viewRun(tx: Prisma.TransactionClient, p: Principal, runId: string) {
  const record = await tx.workflowRunRecord.findFirst({ where: { id: runId, siteId: siteOf(p), ...(p.capabilities.includes("workflows.manage") ? {} : { createdByUserId: p.userId }) } });
  if (!record) throw notFound();
  const run = record.snapshot as unknown as WorkflowRun;
  if (run.id !== record.id || run.siteId !== siteOf(p) || run.definitionVersionId !== record.definitionVersionId) throw new WorkflowError("The retained run identity/version is inconsistent.", "workflow_state_invalid", 409);
  const version = await tx.workflowDefinitionVersion.findFirst({ where: { id: record.definitionVersionId, siteId: siteOf(p) } });
  if (!version || hash(version.definition) !== version.contentHash || stableWorkflowJson(run.definition) !== stableWorkflowJson(version.definition)) throw new WorkflowError("The retained immutable workflow version changed.", "workflow_version_invalid", 409);
  await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${version.definitionId} AND "siteId"=${siteOf(p)} FOR SHARE`;
  const definition = await tx.workflowDefinitionRecord.findFirst({ where: { id: version.definitionId, siteId: siteOf(p) }, select: { enabled: true } });
  const receiving = record.receivingState as unknown as SyntheticReceivingState | null;
  const step = run.definition.steps.find(candidate => candidate.id === run.currentStepId), handoff = step?.kind === "confirm" ? { status: "requires_user_interaction" as const, kind: step.handoff, actionUrl: new URL(`/tools/workflows?runId=${encodeURIComponent(run.id)}`, process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").href, siteId: run.siteId, deviceVerified: false, manualFallbackAllowed: step.manualFallback === true, instruction: ["camera", "device"].includes(step.handoff) ? step.manualFallback ? "Actual device capture is unavailable. An authorized person may explicitly record the defined manual fallback; it will not claim camera/device verification." : "This step awaits a qualified actual device adapter. A caller-supplied boolean or device name cannot satisfy it." : step.prompt } : null;
  return { run, receiving, handoff, definitionEnabled: definition?.enabled === true, readiness: workflowReadiness(run, await runtimeForRun(tx, run.definition, p, definition?.enabled === true, run.providerBindings)), receivingReadiness: receiving ? syntheticReceivingReadiness(receiving) : null, events: await tx.workflowRunEvent.findMany({ where: { runId, siteId: siteOf(p) }, orderBy: { createdAt: "desc" }, take: 50 }), intents: await tx.workflowIntentRecord.findMany({ where: { runId, siteId: siteOf(p) }, orderBy: { createdAt: "asc" }, take: 40 }), limitation: run.definition.mode === "application" ? "Registered internal actions and explicitly bound approved provider READs. Presence is an attributed human observation. No external WMS mutation, receipt, close or print occurred." : "Synthetic practice only; any browser READ requires a separately synthetic-qualified test provider. No live WMS receipt, close or physical print has occurred." };
}

export async function listWorkflows(p: Principal, input: unknown = {}) {
  const data = workflowListInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), manage = actor.capabilities.includes("workflows.manage");
    const records = await tx.workflowDefinitionRecord.findMany({ where: { siteId: siteOf(actor), ...(manage ? {} : { enabled: true, publishedVersionId: { not: null } }), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, select: { id: true, name: true, enabled: true, revision: true, publishedVersionId: true, updatedAt: true }, orderBy: { id: "asc" }, take: data.limit + 1 });
    return { workflows: records.slice(0, data.limit), nextAfterId: records.length > data.limit ? records[data.limit - 1].id : null, templates: [{ id: "synthetic_receiving" as const, name: "Receiving practice", definition: SYNTHETIC_RECEIVING_DEFINITION }, { id: "warehouse_presence" as const, name: "Look up and confirm physical presence", definition: WAREHOUSE_PRESENCE_DEFINITION }], actionCatalog: catalogFor(actor), canManage: manage, siteId: siteOf(actor), liveExecutionAvailable: false, applicationExecutionAvailable: true, liveQualificationNeeded: LIVE_RECEIVING_QUALIFICATION_NEEDED };
  });
}
export async function getWorkflow(p: Principal, input: unknown) {
  const data = workflowGetInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), manage = actor.capabilities.includes("workflows.manage");
    const record = await tx.workflowDefinitionRecord.findFirst({ where: { id: data.id, siteId: siteOf(actor), ...(manage ? {} : { enabled: true, publishedVersionId: { not: null } }) } });
    if (!record) throw notFound();
    return { ...record, draft: manage ? record.draft : null, versions: await tx.workflowDefinitionVersion.findMany({ where: { definitionId: record.id, siteId: siteOf(actor) }, orderBy: { version: "desc" }, take: 50 }) };
  });
}
export async function createWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowCreateInput.parse(input); assertWorkflowJson(data.definition);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true); return localCommandReceipt(tx, actor, "workflows.create", data.operationId, data, async () => {
    const record = await tx.workflowDefinitionRecord.create({ data: { siteId: siteOf(actor), name: data.name, draft: asJson(data.definition), createdByUserId: actor.userId, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_draft_created", record.id); return record;
  }); });
}
export async function saveWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowSaveInput.parse(input); assertWorkflowJson(data.definition);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true); return localCommandReceipt(tx, actor, "workflows.save", data.operationId, data, async () => {
    await lockedDefinition(tx, actor, data.id, data.expectedRevision);
    await assertTemplateWorkflowWrite(tx, actor, data.id);
    const result = await tx.workflowDefinitionRecord.updateMany({ where: { id: data.id, siteId: siteOf(actor), revision: data.expectedRevision }, data: { name: data.name, draft: asJson(data.definition), updatedByUserId: actor.userId, revision: { increment: 1 } } }); if (!result.count) throw conflict(); await audit(tx, actor, "workflow_draft_saved", `${data.id}; revision ${data.expectedRevision + 1}`); return tx.workflowDefinitionRecord.findUniqueOrThrow({ where: { id: data.id } });
  }); });
}
export async function validateWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowValidateInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true), definition = validateWorkflowDefinition(data.definition), providerReads = await workflowProviderCatalog(tx, actor); return { valid: true, definition, contentHash: hash(definition), supportedActions: definition.steps.filter(step => step.kind === "action").map(step => ({ stepId: step.id, actionId: step.action.id, supportedLocalAdapter: Boolean(supportedAction(step.action)), supportedProviderRead: step.action.effect === "read" && Boolean(step.action.providerBinding) && providerReads.some(value => value.id === step.action.id && value.versionId === step.action.versionId && value.configurationVersion === step.action.configurationVersion && value.capability === step.action.capability) })), actionCatalog: { ...catalogFor(actor), providerReads }, liveExecutionAvailable: providerReads.some(value => value.qualification === "qualified" && value.ready), externalMutationExecutionAvailable: false }; });
}
export async function testWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowTestInput.parse(input); assertWorkflowJson(data.data ?? {}, 65_536);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p, true), definition = validateWorkflowDefinition(data.definition); assertExecutable(definition);
    const runtime = await runtimeForRun(tx, definition, actor, true, bindingsFor(definition), true), created = createWorkflowRun({ id: `preview-${randomUUID()}`, siteId: siteOf(actor), definition, data: data.data as Record<string, JsonValue> | undefined, providerBindings: bindingsFor(definition) }, runtime);
    let next = created, receiving = receivingFor(definition, siteOf(actor)), count = 0;
    async function settle() { for (let bound = 0; next.intents.length && bound < 40; bound++) { const intent = next.intents[0], result = await localResult(tx, next.run, intent, receiving, actor); receiving = result.state; next = advanceWorkflowRun(next.run, { commandId: `preview-result-${++count}`, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: { kind: "action_result", intentId: intent.id, result: result.result } }, { ...runtime, origin: "executor" }); } }
    await settle();
    for (const command of data.commands) { next = advanceWorkflowRun(next.run, { commandId: `preview-command-${++count}`, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: command as WorkflowCommand }, runtime); await settle(); }
    return { persisted: false, run: next.run, receiving, readiness: workflowReadiness(next.run, runtime), limitation: "Draft trial only. Registered application lookups may read current authorized data; physical observations are blocked. No persistent run, observation, external WMS action or print was created." };
  });
}
export async function publishWorkflow(p: Principal, input: unknown) {
  const data = workflowPublishInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.publish", data.operationId, data, async () => {
    const record = await lockedDefinition(tx, actor, data.id, data.expectedRevision);
    await assertTemplateWorkflowWrite(tx, actor, data.id);
    const draft = validateWorkflowDefinition(record.draft), previous = await tx.workflowDefinitionVersion.findFirst({ where: { definitionId: record.id, siteId: siteOf(actor) }, orderBy: { version: "desc" } });
    const id = randomUUID(), version = (previous?.version ?? 0) + 1, definition = validateWorkflowDefinition({ ...draft, id: record.id, versionId: id, version, name: record.name });
    const published = await tx.workflowDefinitionVersion.create({ data: { id, siteId: siteOf(actor), definitionId: record.id, version, definition: asJson(definition), contentHash: hash(definition), createdByUserId: actor.userId } });
    await tx.workflowDefinitionRecord.update({ where: { id: record.id }, data: { publishedVersionId: id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_published", `${record.id}; ${id}; ${data.note}`); return { id: record.id, published };
  }); });
}
export async function rollbackWorkflow(p: Principal, input: unknown) {
  const data = workflowRollbackInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.rollback", data.operationId, data, async () => {
    await lockedDefinition(tx, actor, data.id, data.expectedRevision);
    await assertTemplateWorkflowWrite(tx, actor, data.id); const target = await tx.workflowDefinitionVersion.findFirst({ where: { id: data.versionId, definitionId: data.id, siteId: siteOf(actor) } }); if (!target || hash(target.definition) !== target.contentHash) throw notFound();
    const result = await tx.workflowDefinitionRecord.update({ where: { id: data.id }, data: { publishedVersionId: target.id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_rolled_back", `${data.id}; ${target.id}; ${data.note}`); return result;
  }); });
}
export async function setWorkflowEnabled(p: Principal, input: unknown) {
  const data = workflowEnabledInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.enabled", data.operationId, data, async () => {
    await lockedDefinition(tx, actor, data.id, data.expectedRevision);
    await assertTemplateWorkflowWrite(tx, actor, data.id); const result = await tx.workflowDefinitionRecord.update({ where: { id: data.id }, data: { enabled: data.enabled, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_availability_changed", `${data.id}; enabled=${data.enabled}; ${data.note}`); return result;
  }); });
}
async function practiceTemplate(tx: Prisma.TransactionClient, p: Principal, template: "synthetic_receiving" | "warehouse_presence") {
  const suffix = hash(siteOf(p)).slice(0, 24), prefix = template === "warehouse_presence" ? "application-presence" : "practice-receiving", id = `${prefix}-${suffix}`, versionId = `${prefix}-v1-${suffix}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
  let record = await tx.workflowDefinitionRecord.findFirst({ where: { id, siteId: siteOf(p) } });
  if (!record) {
    const definition = validateWorkflowDefinition({ ...(template === "warehouse_presence" ? WAREHOUSE_PRESENCE_DEFINITION : SYNTHETIC_RECEIVING_DEFINITION), id, versionId });
    record = await tx.workflowDefinitionRecord.create({ data: { id, siteId: siteOf(p), name: definition.name, draft: asJson(definition), createdByUserId: p.userId, updatedByUserId: p.userId } });
    await tx.workflowDefinitionVersion.create({ data: { id: versionId, siteId: siteOf(p), definitionId: id, version: 1, definition: asJson(definition), contentHash: hash(definition), createdByUserId: p.userId } });
    record = await tx.workflowDefinitionRecord.update({ where: { id }, data: { publishedVersionId: versionId } });
    await audit(tx, p, "workflow_builtin_practice_materialized", id);
  }
  return record;
}
export async function startWorkflow(p: Principal, input: unknown) {
  const data = workflowStartInput.parse(input); assertWorkflowJson(data.data ?? {}, 65_536);
  return prisma.$transaction(async tx => { const actor = await current(tx, p); return localCommandReceipt(tx, actor, "workflows.start", data.operationId, data, async () => {
    const record = data.template ? await practiceTemplate(tx, actor, data.template) : await tx.workflowDefinitionRecord.findFirst({ where: { id: data.definitionId, siteId: siteOf(actor) } });
    if (!record?.enabled || !record.publishedVersionId) throw new WorkflowError("Choose an enabled published workflow.", "workflow_unpublished", 409);
    await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${record.id} AND "siteId"=${siteOf(actor)} FOR SHARE`;
    const currentRecord = await tx.workflowDefinitionRecord.findUniqueOrThrow({ where: { id: record.id } });
    if (!currentRecord.enabled || currentRecord.publishedVersionId !== record.publishedVersionId || (data.expectedDefinitionVersionId && currentRecord.publishedVersionId !== data.expectedDefinitionVersionId)) throw conflict();
    const version = await tx.workflowDefinitionVersion.findFirst({ where: { id: record.publishedVersionId, definitionId: record.id, siteId: siteOf(actor) } }); if (!version || hash(version.definition) !== version.contentHash) throw notFound();
    const definition = validateWorkflowDefinition(version.definition); assertExecutable(definition);
    const runId = `run-${hash([siteOf(actor), actor.userId, data.operationId]).slice(0, 40)}`;
    const providerBindings = { ...bindingsFor(definition), ...await resolveWorkflowBindings(tx, actor, definition, data.providerBindings) };
    const transition = createWorkflowRun({ id: runId, siteId: siteOf(actor), definition, data: data.data as Record<string, JsonValue> | undefined, providerBindings }, await runtimeForRun(tx, definition, actor, true, providerBindings));
    const receiving = receivingFor(definition, siteOf(actor));
    await tx.workflowRunRecord.create({ data: { id: runId, siteId: siteOf(actor), definitionVersionId: version.id, createdByUserId: actor.userId, revision: transition.run.revision, status: transition.run.status, currentStepId: transition.run.currentStepId, snapshot: asJson(transition.run), ...(receiving ? { receivingState: asJson(receiving) } : {}) } });
    const settled = await settleLocal(tx, actor, transition, receiving, true);
    await tx.workflowRunRecord.update({ where: { id: runId }, data: { revision: settled.run.revision, status: settled.run.status, currentStepId: settled.run.currentStepId, snapshot: asJson(settled.run), ...(settled.receiving ? { receivingState: asJson(settled.receiving) } : {}) } });
    await recordEvent(tx, actor, runId, `start:${data.operationId}`, "run_started", { definitionVersionId: version.id, mode: settled.run.definition.mode, revision: settled.run.revision });
    return viewRun(tx, actor, runId);
  }); });
}
export async function commandWorkflow(p: Principal, input: unknown) {
  const data = workflowCommandServiceInput.parse(input); assertWorkflowJson(data, 65_536);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), siteId = siteOf(actor);
    await tx.$queryRaw`SELECT id FROM "WorkflowRunRecord" WHERE id=${data.runId} AND "siteId"=${siteId} FOR UPDATE`;
    const record = await tx.workflowRunRecord.findFirst({ where: { id: data.runId, siteId, createdByUserId: actor.userId } }); if (!record) throw notFound();
    const previous = await tx.workflowRunEvent.findUnique({ where: { runId_commandId: { runId: record.id, commandId: data.commandId } } });
    if (previous) { const receipt = previous.detail as { inputHash?: string }; if (previous.actorUserId !== actor.userId || receipt.inputHash !== hash(data)) throw new WorkflowError("This command ID was already used for different work.", "workflow_command_conflict", 409); return { ...await viewRun(tx, actor, record.id), replayed: true }; }
    const view = await viewRun(tx, actor, record.id), run = view.run; assertExecutable(run.definition);
    const transition = advanceWorkflowRun(run, { commandId: data.commandId, expectedRevision: data.expectedRevision, definitionVersionId: data.definitionVersionId, command: data.command as WorkflowCommand }, await runtimeForRun(tx, run.definition, actor, view.definitionEnabled, run.providerBindings));
    const settled = await settleLocal(tx, actor, transition, view.receiving, view.definitionEnabled);
    const saved = await tx.workflowRunRecord.updateMany({ where: { id: record.id, siteId, revision: data.expectedRevision }, data: { revision: settled.run.revision, status: settled.run.status, currentStepId: settled.run.currentStepId, snapshot: asJson(settled.run), ...(settled.receiving ? { receivingState: asJson(settled.receiving) } : {}) } }); if (!saved.count) throw conflict();
    await recordEvent(tx, actor, record.id, data.commandId, "operator_command", { inputHash: hash(data), command: data.command, revision: settled.run.revision, mode: settled.run.definition.mode });
    return { ...await viewRun(tx, actor, record.id), replayed: false };
  });
}
/** Explicit outbox drain/poll. The only input is an existing run/revision/version. */
export async function executeWorkflowProviderRead(p: Principal, input: unknown) {
  const data = workflowProviderExecuteInput.parse(input);
  const prepared = await prisma.$transaction(async tx => {
    const actor = await current(tx, p), view = await viewRun(tx, actor, data.runId), run = view.run;
    if (run.createdByUserId !== actor.userId || run.revision !== data.expectedRevision || run.definitionVersionId !== data.definitionVersionId) throw conflict();
    const intent = run.currentStepId ? run.steps[run.currentStepId]?.intent : undefined;
    if (!intent || !isProviderWorkflowIntent(intent)) throw new WorkflowError("This run has no retained browser-provider READ intent. Resolve readiness or refresh the run first.", "workflow_provider_unavailable", 409);
    if (stableWorkflowJson(intent.executorActor) !== stableWorkflowJson(providerActor(actor))) throw new WorkflowError("Execution stays pinned to the original person/session/client grant.", "workflow_provider_actor", 403);
    const stored = await tx.workflowIntentRecord.findFirst({ where: { id: intent.id, runId: run.id, siteId: siteOf(actor) } });
    if (!stored || stableWorkflowJson(stored.intent) !== stableWorkflowJson(intent)) throw new WorkflowError("Original committed outbox intent is unavailable.", "workflow_provider_intent", 409);
    return { actor, view, intent, blocked: run.paused || !view.definitionEnabled || stored.state !== "prepared" || run.status !== "pending" };
  });
  if (prepared.blocked) return { ...prepared.view, providerExecution: { status: "retained", operationId: prepared.intent.providerOperationId, instruction: "Original evidence is retained. Resume the original unpaused authorized pending run; unknown or settled work is never replayed." } };
  let receipt: Awaited<ReturnType<typeof getIntegrationOperation>>;
  try {
    // No workflow row lock or DB transaction crosses this broker request.
    receipt = await contactWorkflowProviderRead(prepared.actor, prepared.intent);
  } catch (error) {
    return { ...await getWorkflowRun(p, { runId: data.runId }), providerExecution: { status: "blocked", operationId: prepared.intent.providerOperationId, instruction: error instanceof Error ? error.message : "Original provider is unavailable. Restore its exact connection and grant; no fallback or new request was created." } };
  }
  if (["queued", "dispatching"].includes(receipt.operation.state)) return { ...await getWorkflowRun(p, { runId: data.runId }), providerExecution: { status: "pending", operationId: receipt.operation.operationId, receipt } };
  let result: WorkflowActionResult;
  const status = (receipt.operation.result as { status?: unknown } | null)?.status;
  if (receipt.operation.state === "unknown") result = { outcome: "unknown", receiptId: receipt.operation.operationId, reason: "The original provider result is uncertain. Inspect that private operation; no automatic replay or workflow completion occurred." };
  else if (receipt.operation.state === "reported" && receipt.outputValidation.valid && typeof status === "number" && status >= 200 && status < 300) {
    try { assertWorkflowJson(receipt.outputValidation.parsedValue, 65_536); result = { outcome: "succeeded", receiptId: receipt.operation.operationId, output: receipt.outputValidation.parsedValue, reason: "Validated named READ response only; this is not physical or mutation completion." }; }
    catch { result = { outcome: "failed", receiptId: receipt.operation.operationId, noEffectConfirmed: true, reason: "Private READ output exceeds the workflow's bounded JSON result limit. Original response is retained without replay." }; }
  } else result = { outcome: "failed", receiptId: receipt.operation.operationId, noEffectConfirmed: true, reason: receipt.operation.state === "reported" ? "Correlated READ response failed its original output contract or HTTP status check. Private body is retained." : "The original READ was cancelled/not sent. No warehouse action was performed." };
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), siteId = siteOf(actor);
    await tx.$queryRaw`SELECT id FROM "WorkflowRunRecord" WHERE id=${data.runId} AND "siteId"=${siteId} FOR UPDATE`;
    const view = await viewRun(tx, actor, data.runId), run = view.run;
    if (run.revision !== data.expectedRevision || run.paused || !view.definitionEnabled || run.currentStepId !== prepared.intent.stepId || stableWorkflowJson(run.steps[prepared.intent.stepId]?.intent) !== stableWorkflowJson(prepared.intent)) return { ...view, providerExecution: { status: "retained", operationId: receipt.operation.operationId, receipt, instruction: "The workflow changed during contact. Original evidence was retained without advancing the run; refresh and resume the same intent." } };
    if (stableWorkflowJson(prepared.intent.executorActor) !== stableWorkflowJson(providerActor(actor))) throw new WorkflowError("Original execution session/client changed.", "workflow_provider_actor", 403);
    const step = run.definition.steps.find(value => value.id === prepared.intent.stepId);
    if (step?.kind !== "action" || !prepared.intent.provider || prepared.intent.effect !== "read") throw conflict();
    await assertCurrentPrincipal(tx, actor, step.action.capability as Parameters<typeof assertCurrentPrincipal>[2]);
    // Recheck current original grant/configuration even though this result was read outside the writer.
    await resolveWorkflowProviderInTransaction(tx, actor, { providerId: prepared.intent.provider.providerId, actionVersionId: prepared.intent.actionVersionId, configurationId: prepared.intent.actionConfigurationVersion, expectedBinding: prepared.intent.provider });
    const original = await tx.integrationOperation.findFirst({ where: { operationId: receipt.operation.operationId, actorUserId: actor.userId, siteId } });
    if (!original || original.revision !== receipt.operation.revision || original.state !== receipt.operation.state || stableWorkflowJson(original.result) !== stableWorkflowJson(receipt.operation.result)) throw new WorkflowError("Original private receipt changed; poll it again without dispatch.", "workflow_provider_receipt", 409);
    const changed = await tx.workflowIntentRecord.updateMany({ where: { id: prepared.intent.id, siteId, state: "prepared" }, data: { state: result.outcome, result: asJson(result), revision: { increment: 1 } } });
    if (!changed.count) return { ...view, providerExecution: { status: "retained", operationId: receipt.operation.operationId, receipt } };
    const commandId = `provider:${hash(prepared.intent.id).slice(0, 48)}`;
    const runtime = await runtimeForRun(tx, run.definition, actor, view.definitionEnabled, run.providerBindings);
    const transition = advanceWorkflowRun(run, { commandId, expectedRevision: run.revision, definitionVersionId: run.definitionVersionId, command: { kind: "action_result", intentId: prepared.intent.id, result } }, { ...runtime, origin: "executor" });
    const settled = await settleLocal(tx, actor, transition, view.receiving, view.definitionEnabled);
    const saved = await tx.workflowRunRecord.updateMany({ where: { id: run.id, siteId, revision: run.revision }, data: { revision: settled.run.revision, status: settled.run.status, currentStepId: settled.run.currentStepId, snapshot: asJson(settled.run), ...(settled.receiving ? { receivingState: asJson(settled.receiving) } : {}) } });
    if (!saved.count) throw conflict();
    await recordEvent(tx, actor, run.id, commandId, "provider_read_result", { operationId: receipt.operation.operationId, intentId: prepared.intent.id, result, revision: settled.run.revision });
    return { ...await viewRun(tx, actor, run.id), providerExecution: { status: "applied", operationId: receipt.operation.operationId, receipt } };
  });
}
export async function getWorkflowRun(p: Principal, input: unknown) {
  const data = workflowRunGetInput.parse(input); return prisma.$transaction(async tx => viewRun(tx, await current(tx, p), data.runId));
}
export async function listWorkflowRuns(p: Principal, input: unknown = {}) {
  const data = workflowRunListInput.parse(input); return prisma.$transaction(async tx => {
    const actor = await current(tx, p), records = await tx.workflowRunRecord.findMany({ where: { siteId: siteOf(actor), createdByUserId: actor.userId, ...(data.status ? { status: data.status } : {}), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, select: { id: true, definitionVersionId: true, revision: true, status: true, currentStepId: true, createdAt: true, updatedAt: true }, orderBy: { id: "asc" }, take: data.limit + 1 });
    return { runs: records.slice(0, data.limit), nextAfterId: records.length > data.limit ? records[data.limit - 1].id : null, siteId: siteOf(actor) };
  });
}
