import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import { assertWorkflowJson, copyWorkflowJson, stableWorkflowJson, validateWorkflowDefinition, workflowId, workflowKey, WorkflowError, type JsonValue, type WorkflowDefinition } from "./definition";
import { advanceWorkflowRun, createWorkflowRun, workflowReadiness, type WorkflowCommand, type WorkflowEffectIntent, type WorkflowRun, type WorkflowRuntime, type WorkflowTransition } from "./engine";
import { createSyntheticReceiving, createSyntheticReceivingRuntime, executeSyntheticReceivingIntent, syntheticReceivingReadiness, SYNTHETIC_RECEIVING_BINDINGS, SYNTHETIC_RECEIVING_DEFINITION, SYNTHETIC_RECEIVING_DELIVERY, LIVE_RECEIVING_QUALIFICATION_NEEDED, type SyntheticReceivingState } from "./receiving";

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
  z.object({ kind: z.literal("confirm"), accepted: z.boolean(), note: z.string().max(1000).optional() }).strict(),
  z.object({ kind: z.literal("pause"), reason: auditNote }).strict(),
  z.object({ kind: z.literal("resume") }).strict(), z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("retry_failed"), reason: auditNote }).strict(),
]);
export const workflowTestInput = workflowValidateInput.extend({ data: dataBody.optional(), commands: z.array(operatorCommand).max(100).default([]) });
export const workflowPublishInput = z.object({ operationId, id: workflowId, expectedRevision: revision, note: auditNote }).strict();
export const workflowRollbackInput = workflowPublishInput.extend({ versionId: workflowId });
export const workflowEnabledInput = workflowPublishInput.extend({ enabled: z.boolean() });
export const workflowStartInput = z.object({ operationId, definitionId: workflowId.optional(), template: z.literal("synthetic_receiving").optional(), data: dataBody.optional() }).strict().superRefine((input, ctx) => { if (Boolean(input.definitionId) === Boolean(input.template)) ctx.addIssue({ code: "custom", message: "Choose one published workflow or the built-in synthetic Receiving template." }); });
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
function supportedAction(action: Extract<WorkflowDefinition["steps"][number], { kind: "action" }>["action"]) {
  if (action.id === "workflow.local.echo" && action.versionId === "workflow-local-echo-v1" && action.configurationVersion === "workflow-local-config-v1" && action.effect === "local" && action.capability === "workflow.read" && !action.providerBinding) return "echo";
  const known = SYNTHETIC_RECEIVING_DEFINITION.steps.find(step => step.kind === "action" && step.action.id === action.id);
  return known?.kind === "action" && stableWorkflowJson(known.action) === stableWorkflowJson(action) ? "receiving" : null;
}
/** Only built-in local adapters have runtime authority here; external profiles cannot self-qualify. */
function runtimeFor(definition: WorkflowDefinition, p: Principal, enabled = true): WorkflowRuntime {
  const base = createSyntheticReceivingRuntime(siteOf(p), p.userId, new Date().toISOString());
  return { ...base, configurationVersion: definition.configurationVersion, capabilities: p.capabilities, runPermitted: enabled && p.capabilities.includes("workflow.read"),
    actions: definition.steps.flatMap(step => step.kind === "action" ? [{ id: step.action.id, versionId: step.action.versionId, configurationVersion: step.action.configurationVersion, siteId: siteOf(p), effect: step.action.effect, enabled, permitted: Boolean(supportedAction(step.action)), ready: Boolean(supportedAction(step.action)), qualification: "synthetic" as const, reason: "Only local synthetic adapters are available. No live upstream contract is qualified.", fix: "Use a supported local action or qualify the separately gated upstream adapter." }] : []),
  };
}
function bindingsFor(definition: WorkflowDefinition) {
  const keys = new Set([...definition.startRequirements, ...definition.steps.flatMap(step => step.requirements)].flatMap(req => req.kind === "provider" ? [req.binding] : []).concat(definition.steps.flatMap(step => step.kind === "action" && step.action.providerBinding ? [step.action.providerBinding] : [])));
  return Object.fromEntries(Object.entries(SYNTHETIC_RECEIVING_BINDINGS).filter(([key]) => keys.has(key)));
}
function receivingFor(definition: WorkflowDefinition, siteId: string) {
  return definition.steps.some(step => step.kind === "action" && supportedAction(step.action) === "receiving") ? createSyntheticReceiving(siteId, SYNTHETIC_RECEIVING_DELIVERY.id, SYNTHETIC_RECEIVING_DELIVERY.lines) : null;
}
function assertPractice(definition: WorkflowDefinition) {
  if (definition.mode !== "synthetic") throw new WorkflowError("Live workflow execution is unavailable. Actual upstream receipt/close contracts and specific trial authority are pending; this pilot runs local practice only.", "workflow_live_unavailable", 403);
}
function localResult(intent: WorkflowEffectIntent, state: SyntheticReceivingState | null, p: Principal) {
  if (intent.actionId === "workflow.local.echo" && intent.actionVersionId === "workflow-local-echo-v1" && intent.actionConfigurationVersion === "workflow-local-config-v1" && intent.effect === "local" && intent.mode === "synthetic") return { state, result: { outcome: "succeeded" as const, output: copyWorkflowJson(intent.parameters), receiptId: `local:${hash(intent.id).slice(0, 48)}` } };
  if (!state) throw new WorkflowError("The local Receiving fixture is missing.");
  return executeSyntheticReceivingIntent(state, intent, { userId: p.userId, at: new Date().toISOString() });
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
    const fresh = await current(tx, p), runtime = runtimeFor(next.run.definition, fresh, enabled);
    const readiness = workflowReadiness(next.run, runtime);
    if (readiness.blocking.length) throw new WorkflowError(readiness.blocking[0].reason, "workflow_blocked", 409);
    await tx.workflowIntentRecord.create({ data: { id: intent.id, siteId: siteOf(fresh), runId: intent.runId, stepId: intent.stepId, attempt: intent.attempt, state: "prepared", intent: asJson(intent) } });
    const settled = localResult(intent, receiving, fresh); receiving = settled.state;
    await tx.workflowIntentRecord.update({ where: { id: intent.id }, data: { state: settled.result.outcome, result: asJson(settled.result), revision: { increment: 1 } } });
    const commandId = `sim:${hash(intent.id).slice(0, 48)}`;
    next = advanceWorkflowRun(next.run, { commandId, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: { kind: "action_result", intentId: intent.id, result: settled.result } }, { ...runtime, origin: "executor" });
    await recordEvent(tx, fresh, next.run.id, commandId, "synthetic_action_result", { intent, result: settled.result, revision: next.run.revision });
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
  return { run, receiving, definitionEnabled: definition?.enabled === true, readiness: workflowReadiness(run, runtimeFor(run.definition, p, definition?.enabled === true)), receivingReadiness: receiving ? syntheticReceivingReadiness(receiving) : null, events: await tx.workflowRunEvent.findMany({ where: { runId, siteId: siteOf(p) }, orderBy: { createdAt: "desc" }, take: 50 }), intents: await tx.workflowIntentRecord.findMany({ where: { runId, siteId: siteOf(p) }, orderBy: { createdAt: "asc" }, take: 40 }), limitation: "Local synthetic practice only. No live WMS receipt, close or physical print has occurred." };
}

export async function listWorkflows(p: Principal, input: unknown = {}) {
  const data = workflowListInput.parse(input);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p), manage = actor.capabilities.includes("workflows.manage");
    const records = await tx.workflowDefinitionRecord.findMany({ where: { siteId: siteOf(actor), ...(manage ? {} : { enabled: true, publishedVersionId: { not: null } }), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, select: { id: true, name: true, enabled: true, revision: true, publishedVersionId: true, updatedAt: true }, orderBy: { id: "asc" }, take: data.limit + 1 });
    return { workflows: records.slice(0, data.limit), nextAfterId: records.length > data.limit ? records[data.limit - 1].id : null, templates: [{ id: "synthetic_receiving", name: "Receiving practice", definition: SYNTHETIC_RECEIVING_DEFINITION }], canManage: manage, siteId: siteOf(actor), liveExecutionAvailable: false, liveQualificationNeeded: LIVE_RECEIVING_QUALIFICATION_NEEDED };
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
    const result = await tx.workflowDefinitionRecord.updateMany({ where: { id: data.id, siteId: siteOf(actor), revision: data.expectedRevision }, data: { name: data.name, draft: asJson(data.definition), updatedByUserId: actor.userId, revision: { increment: 1 } } }); if (!result.count) throw conflict(); await audit(tx, actor, "workflow_draft_saved", `${data.id}; revision ${data.expectedRevision + 1}`); return tx.workflowDefinitionRecord.findUniqueOrThrow({ where: { id: data.id } });
  }); });
}
export async function validateWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowValidateInput.parse(input);
  return prisma.$transaction(async tx => { await current(tx, p, true); const definition = validateWorkflowDefinition(data.definition); return { valid: true, definition, contentHash: hash(definition), supportedActions: definition.steps.filter(step => step.kind === "action").map(step => ({ stepId: step.id, actionId: step.action.id, supportedLocalAdapter: Boolean(supportedAction(step.action)) })), liveExecutionAvailable: false }; });
}
export async function testWorkflowDraft(p: Principal, input: unknown) {
  const data = workflowTestInput.parse(input); assertWorkflowJson(data.data ?? {}, 65_536);
  return prisma.$transaction(async tx => {
    const actor = await current(tx, p, true), definition = validateWorkflowDefinition(data.definition); assertPractice(definition);
    const runtime = runtimeFor(definition, actor), created = createWorkflowRun({ id: `preview-${randomUUID()}`, siteId: siteOf(actor), definition, data: data.data as Record<string, JsonValue> | undefined, providerBindings: bindingsFor(definition) }, runtime);
    let next = created, receiving = receivingFor(definition, siteOf(actor)), count = 0;
    function settle() { for (let bound = 0; next.intents.length && bound < 40; bound++) { const intent = next.intents[0], result = localResult(intent, receiving, actor); receiving = result.state; next = advanceWorkflowRun(next.run, { commandId: `preview-result-${++count}`, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: { kind: "action_result", intentId: intent.id, result: result.result } }, { ...runtime, origin: "executor" }); } }
    settle();
    for (const command of data.commands) { next = advanceWorkflowRun(next.run, { commandId: `preview-command-${++count}`, expectedRevision: next.run.revision, definitionVersionId: next.run.definitionVersionId, command: command as WorkflowCommand }, runtime); settle(); }
    return { persisted: false, run: next.run, receiving, readiness: workflowReadiness(next.run, runtime), limitation: "An in-memory local synthetic trial. No run, WMS action or print was created." };
  });
}
export async function publishWorkflow(p: Principal, input: unknown) {
  const data = workflowPublishInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.publish", data.operationId, data, async () => {
    const record = await lockedDefinition(tx, actor, data.id, data.expectedRevision), draft = validateWorkflowDefinition(record.draft), previous = await tx.workflowDefinitionVersion.findFirst({ where: { definitionId: record.id, siteId: siteOf(actor) }, orderBy: { version: "desc" } });
    const id = randomUUID(), version = (previous?.version ?? 0) + 1, definition = validateWorkflowDefinition({ ...draft, id: record.id, versionId: id, version, name: record.name });
    const published = await tx.workflowDefinitionVersion.create({ data: { id, siteId: siteOf(actor), definitionId: record.id, version, definition: asJson(definition), contentHash: hash(definition), createdByUserId: actor.userId } });
    await tx.workflowDefinitionRecord.update({ where: { id: record.id }, data: { publishedVersionId: id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_published", `${record.id}; ${id}; ${data.note}`); return { id: record.id, published };
  }); });
}
export async function rollbackWorkflow(p: Principal, input: unknown) {
  const data = workflowRollbackInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.rollback", data.operationId, data, async () => {
    await lockedDefinition(tx, actor, data.id, data.expectedRevision); const target = await tx.workflowDefinitionVersion.findFirst({ where: { id: data.versionId, definitionId: data.id, siteId: siteOf(actor) } }); if (!target || hash(target.definition) !== target.contentHash) throw notFound();
    const result = await tx.workflowDefinitionRecord.update({ where: { id: data.id }, data: { publishedVersionId: target.id, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_rolled_back", `${data.id}; ${target.id}; ${data.note}`); return result;
  }); });
}
export async function setWorkflowEnabled(p: Principal, input: unknown) {
  const data = workflowEnabledInput.parse(input);
  return prisma.$transaction(async tx => { const actor = await current(tx, p, true, true); return localCommandReceipt(tx, actor, "workflows.enabled", data.operationId, data, async () => {
    await lockedDefinition(tx, actor, data.id, data.expectedRevision); const result = await tx.workflowDefinitionRecord.update({ where: { id: data.id }, data: { enabled: data.enabled, revision: { increment: 1 }, updatedByUserId: actor.userId } }); await audit(tx, actor, "workflow_availability_changed", `${data.id}; enabled=${data.enabled}; ${data.note}`); return result;
  }); });
}
async function practiceTemplate(tx: Prisma.TransactionClient, p: Principal) {
  const suffix = hash(siteOf(p)).slice(0, 24), id = `practice-receiving-${suffix}`, versionId = `practice-receiving-v1-${suffix}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
  let record = await tx.workflowDefinitionRecord.findFirst({ where: { id, siteId: siteOf(p) } });
  if (!record) {
    const definition = validateWorkflowDefinition({ ...SYNTHETIC_RECEIVING_DEFINITION, id, versionId });
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
    const record = data.template ? await practiceTemplate(tx, actor) : await tx.workflowDefinitionRecord.findFirst({ where: { id: data.definitionId, siteId: siteOf(actor) } });
    if (!record?.enabled || !record.publishedVersionId) throw new WorkflowError("Choose an enabled published workflow.", "workflow_unpublished", 409);
    await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${record.id} AND "siteId"=${siteOf(actor)} FOR SHARE`;
    const currentRecord = await tx.workflowDefinitionRecord.findUniqueOrThrow({ where: { id: record.id } });
    if (!currentRecord.enabled || currentRecord.publishedVersionId !== record.publishedVersionId) throw conflict();
    const version = await tx.workflowDefinitionVersion.findFirst({ where: { id: record.publishedVersionId, definitionId: record.id, siteId: siteOf(actor) } }); if (!version || hash(version.definition) !== version.contentHash) throw notFound();
    const definition = validateWorkflowDefinition(version.definition); assertPractice(definition);
    const runId = `run-${hash([siteOf(actor), actor.userId, data.operationId]).slice(0, 40)}`;
    const transition = createWorkflowRun({ id: runId, siteId: siteOf(actor), definition, data: data.data as Record<string, JsonValue> | undefined, providerBindings: bindingsFor(definition) }, runtimeFor(definition, actor));
    const receiving = receivingFor(definition, siteOf(actor));
    await tx.workflowRunRecord.create({ data: { id: runId, siteId: siteOf(actor), definitionVersionId: version.id, createdByUserId: actor.userId, revision: transition.run.revision, status: transition.run.status, currentStepId: transition.run.currentStepId, snapshot: asJson(transition.run), ...(receiving ? { receivingState: asJson(receiving) } : {}) } });
    const settled = await settleLocal(tx, actor, transition, receiving, true);
    await tx.workflowRunRecord.update({ where: { id: runId }, data: { revision: settled.run.revision, status: settled.run.status, currentStepId: settled.run.currentStepId, snapshot: asJson(settled.run), ...(settled.receiving ? { receivingState: asJson(settled.receiving) } : {}) } });
    await recordEvent(tx, actor, runId, `start:${data.operationId}`, "run_started", { definitionVersionId: version.id, mode: "synthetic", revision: settled.run.revision });
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
    const view = await viewRun(tx, actor, record.id), run = view.run; assertPractice(run.definition);
    const transition = advanceWorkflowRun(run, { commandId: data.commandId, expectedRevision: data.expectedRevision, definitionVersionId: data.definitionVersionId, command: data.command as WorkflowCommand }, runtimeFor(run.definition, actor, view.definitionEnabled));
    const settled = await settleLocal(tx, actor, transition, view.receiving, view.definitionEnabled);
    const saved = await tx.workflowRunRecord.updateMany({ where: { id: record.id, siteId, revision: data.expectedRevision }, data: { revision: settled.run.revision, status: settled.run.status, currentStepId: settled.run.currentStepId, snapshot: asJson(settled.run), ...(settled.receiving ? { receivingState: asJson(settled.receiving) } : {}) } }); if (!saved.count) throw conflict();
    await recordEvent(tx, actor, record.id, data.commandId, "operator_command", { inputHash: hash(data), command: data.command, revision: settled.run.revision, mode: "synthetic" });
    return { ...await viewRun(tx, actor, record.id), replayed: false };
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
