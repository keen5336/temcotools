import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { mapWorkflowParameters, stableWorkflowJson, WorkflowError } from "./definition";
import type { WorkflowEffectIntent, WorkflowRun } from "./engine";

export const WORKFLOW_PROVIDER_OPERATION_PREFIX = "wfread_";
export function workflowProviderOperationId(intent: Pick<WorkflowEffectIntent, "siteId" | "runId" | "id">) {
  return `${WORKFLOW_PROVIDER_OPERATION_PREFIX}${createHash("sha256").update(JSON.stringify([intent.siteId, intent.runId, intent.id])).digest("hex")}`;
}
export type WorkflowProviderOrigin = {
  runId: string; stepId: string; intentId: string; definitionVersionId: string;
  workflowConfigurationVersion: string; authorizationVersionId: string;
};
type ProviderRequest = { operationId: string; siteId: string; providerId: string; actor: NonNullable<WorkflowEffectIntent["executorActor"]>; actionVersionId: string; effect: string; input: unknown; binding: { configurationVersion: string } };
const deny = (message: string) => new WorkflowError(message, "workflow_provider_origin", 409);

/** Writer-transaction check. No origin/run/step authority comes from the control caller. */
export async function assertWorkflowProviderOrigin(tx: Prisma.TransactionClient, request: ProviderRequest): Promise<WorkflowProviderOrigin | undefined> {
  if (!request.operationId.startsWith(WORKFLOW_PROVIDER_OPERATION_PREFIX)) return undefined;
  const rows = await tx.workflowIntentRecord.findMany({ where: { siteId: request.siteId, intent: { path: ["providerOperationId"], equals: request.operationId } }, take: 2 });
  if (rows.length !== 1) throw deny("No unique committed workflow outbox owns this reserved operation ID.");
  const record = rows[0], intent = record.intent as unknown as WorkflowEffectIntent;
  await tx.$queryRaw`SELECT id FROM "WorkflowRunRecord" WHERE id=${record.runId} AND "siteId"=${request.siteId} FOR SHARE`;
  const runRow = await tx.workflowRunRecord.findFirst({ where: { id: record.runId, siteId: request.siteId } });
  if (!runRow) throw deny("Original workflow run is unavailable in this warehouse.");
  const run = runRow.snapshot as unknown as WorkflowRun, state = run.steps[intent.stepId], step = run.definition.steps.find(value => value.id === intent.stepId);
  const version = await tx.workflowDefinitionVersion.findFirst({ where: { id: runRow.definitionVersionId, siteId: request.siteId } });
  if (!version || createHash("sha256").update(stableWorkflowJson(version.definition)).digest("hex") !== version.contentHash || stableWorkflowJson(version.definition) !== stableWorkflowJson(run.definition)) throw deny("Original immutable workflow definition changed.");
  await tx.$queryRaw`SELECT id FROM "WorkflowDefinitionRecord" WHERE id=${version.definitionId} AND "siteId"=${request.siteId} FOR SHARE`;
  const enabled = await tx.workflowDefinitionRecord.findFirst({ where: { id: version.definitionId, siteId: request.siteId }, select: { enabled: true } });
  if (!enabled?.enabled || run.paused || run.status !== "pending" || runRow.status !== "pending" || run.currentStepId !== intent.stepId || runRow.currentStepId !== intent.stepId || record.state !== "prepared" || state?.status !== "pending") throw deny("Original workflow is paused, disabled, settled or no longer awaiting this exact step.");
  if (run.siteId !== request.siteId || run.id !== record.runId || run.createdByUserId !== request.actor.userId || run.definitionVersionId !== runRow.definitionVersionId || run.revision !== runRow.revision || intent.id !== record.id || intent.siteId !== run.siteId || intent.runId !== run.id || intent.actorUserId !== request.actor.userId || intent.definitionVersionId !== run.definitionVersionId || intent.configurationVersion !== run.configurationVersion || intent.mode !== run.definition.mode || intent.stepId !== record.stepId || intent.attempt !== record.attempt || workflowProviderOperationId(intent) !== request.operationId || intent.providerOperationId !== request.operationId || stableWorkflowJson(state.intent) !== stableWorkflowJson(intent) || stableWorkflowJson(intent.executorActor) !== stableWorkflowJson(request.actor) || stableWorkflowJson(intent.parameters) !== stableWorkflowJson(request.input)) throw deny("Provider request differs from the committed original workflow intent/actor/parameters.");
  if (step?.kind !== "action" || !step.action.providerBinding || intent.effect !== "read" || request.effect !== "read" || intent.actionVersionId !== request.actionVersionId || step.action.versionId !== intent.actionVersionId || step.action.id !== intent.actionId || step.action.configurationVersion !== intent.actionConfigurationVersion || step.action.effect !== "read" || !intent.provider || intent.provider.providerId !== request.providerId || intent.provider.providerVersionId !== request.binding.configurationVersion || stableWorkflowJson(run.providerBindings[step.action.providerBinding]) !== stableWorkflowJson(intent.provider)) throw deny("Original workflow action/provider/configuration pins differ; no substitution is permitted.");
  if (stableWorkflowJson(mapWorkflowParameters(step.parameters, { data: run.data, steps: run.steps })) !== stableWorkflowJson(intent.parameters)) throw deny("Mapped READ input differs from the originating run/earlier step evidence.");
  return { runId: run.id, stepId: intent.stepId, intentId: intent.id, definitionVersionId: run.definitionVersionId, workflowConfigurationVersion: run.configurationVersion, authorizationVersionId: intent.provider.authorizationVersionId };
}
