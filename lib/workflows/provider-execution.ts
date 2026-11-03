import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Principal } from "@/lib/auth/principal";
import { resolveWorkflowProviderInTransaction, getIntegrationOperation } from "@/lib/integrations/provider-runtime";
import { prepareProviderOperation, claimProviderOperation, providerActor } from "@/lib/integrations/dispatch";
import { workflowId, workflowKey, stableWorkflowJson, WorkflowError, type WorkflowDefinition } from "./definition";
import type { ProviderBinding, WorkflowActionSnapshot, WorkflowEffectIntent, WorkflowProviderSnapshot, WorkflowRun } from "./engine";
import { workflowProviderOperationId } from "./provider-origin";

export const workflowProviderBindingsInput = z.record(workflowKey, z.object({ providerId: workflowId }).strict()).refine(v => Object.keys(v).length <= 16, "Bind at most 16 declared providers.");
export const workflowProviderExecuteInput = z.object({ runId: workflowId, expectedRevision: z.number().int().positive(), definitionVersionId: workflowId }).strict();
type ActionStep = Extract<WorkflowDefinition["steps"][number], { kind: "action" }>;
const actions = (definition: WorkflowDefinition) => definition.steps.filter((step): step is ActionStep => step.kind === "action" && Boolean(step.action.providerBinding) && !step.action.id.startsWith("synthetic.receiving."));
export function isProviderWorkflowIntent(intent: WorkflowEffectIntent) { return Boolean(intent.providerOperationId); }

export async function resolveWorkflowBindings(tx: Prisma.TransactionClient, p: Principal, definition: WorkflowDefinition, selectors: z.infer<typeof workflowProviderBindingsInput> = {}) {
  const declared = actions(definition), bindings: Record<string, ProviderBinding> = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const selected = declared.filter(step => step.action.providerBinding === key);
    if (!selected.length) throw new WorkflowError("Bind only provider keys declared by named action steps.");
    for (const step of selected) {
      if (step.action.effect !== "read") throw new WorkflowError("External write/print workflow adapters remain unavailable; bind only approved READ actions.", "workflow_provider_effect", 403);
      const result = await resolveWorkflowProviderInTransaction(tx, p, { providerId: selector.providerId, actionVersionId: step.action.versionId, configurationId: step.action.configurationVersion, ...(bindings[key] ? { expectedBinding: bindings[key] } : {}) });
      if (result.definition.key !== step.action.id || result.definition.requiredCapability !== step.action.capability) throw new WorkflowError("Workflow READ pin differs from the approved action contract.", "workflow_provider_pin", 409);
      bindings[key] = result.binding;
    }
  }
  return bindings;
}

/** Current DB readiness only; the hub still verifies an established socket before contact. */
export async function workflowProviderRuntime(tx: Prisma.TransactionClient, p: Principal, definition: WorkflowDefinition, bindings: Record<string, ProviderBinding>, preview = false) {
  const snapshots: WorkflowProviderSnapshot[] = [], actionSnapshots: WorkflowActionSnapshot[] = [];
  for (const step of actions(definition)) {
    const pin = step.action, bound = bindings[pin.providerBinding!];
    try {
      if (preview) throw new WorkflowError("Draft tests never contact upstream browser providers. Start a published run with an explicit provider binding.");
      if (!bound) throw new WorkflowError("No provider is explicitly bound to this run. Choose an established authorized provider when starting it.");
      if (pin.effect !== "read") throw new WorkflowError("External write/print workflow adapters are unavailable pending qualified contracts and specific trial authority.");
      const value = await resolveWorkflowProviderInTransaction(tx, p, { providerId: bound.providerId, actionVersionId: pin.versionId, configurationId: pin.configurationVersion, expectedBinding: bound });
      if (value.definition.key !== pin.id || value.definition.requiredCapability !== pin.capability) throw new WorkflowError("Pinned action key/capability differs from its reviewed immutable contract.");
      const existing = snapshots.find(item => item.providerId === bound.providerId);
      if (existing) existing.actionIds.push(pin.id); else snapshots.push(value.snapshot);
      actionSnapshots.push({ id: pin.id, versionId: pin.versionId, configurationVersion: pin.configurationVersion, siteId: p.siteId!, effect: "read", enabled: true, permitted: true, ready: value.snapshot.actionReady, qualification: value.qualification, reason: value.snapshot.reason, fix: value.snapshot.fix });
    } catch (error) {
      actionSnapshots.push({ id: pin.id, versionId: pin.versionId, configurationVersion: pin.configurationVersion, siteId: p.siteId!, effect: pin.effect, enabled: true, permitted: false, ready: false, qualification: "unqualified", reason: error instanceof Error ? error.message : "Provider readiness is unavailable.", fix: "Restore the original provider, exact approved READ configuration and explicit current session/client grant; no alternative connection is selected." });
    }
  }
  return { providers: snapshots, actions: actionSnapshots };
}

/** This mutates only the new, uncommitted intent/snapshot owned by the server writer. */
export function stampWorkflowProviderIntent(run: WorkflowRun, intent: WorkflowEffectIntent, p: Principal) {
  const step = run.definition.steps.find(value => value.id === intent.stepId);
  // Synthetic Receiving providers remain its existing local adapter, not browser contact.
  if (step?.kind !== "action" || !step.action.providerBinding || !intent.provider || intent.actionId.startsWith("synthetic.receiving.")) return;
  if (intent.effect !== "read") throw new WorkflowError("Only approved provider READ intents may leave the workflow outbox.", "workflow_provider_effect", 403);
  intent.providerOperationId = workflowProviderOperationId(intent);
  intent.executorActor = providerActor(p);
  run.steps[intent.stepId].intent = structuredClone(intent);
}

export async function workflowProviderCatalog(tx: Prisma.TransactionClient, p: Principal) {
  const providers = await tx.providerConnection.findMany({ where: { revokedAt: null, runtimeConfigurationId: { not: null }, runtimeActivationId: { not: null } }, orderBy: { id: "asc" }, take: 40 });
  const entries = [];
  for (const provider of providers) for (const versionId of provider.allowedActionVersionIds.slice(0, 32)) {
    if (entries.length >= 100) break;
    try { const value = await resolveWorkflowProviderInTransaction(tx, p, { providerId: provider.id, actionVersionId: versionId, configurationId: provider.runtimeConfigurationId! }); const owner = await tx.user.findUnique({ where: { id: provider.ownerUserId }, select: { displayName: true } }), session = await tx.userSession.findUnique({ where: { id: provider.ownerSessionId }, select: { deviceLabel: true } }); entries.push({ id: value.definition.key, versionId, configurationVersion: value.configurationId, capability: value.definition.requiredCapability, effect: "read" as const, providerBindingRequired: true, providerId: provider.id, providerLabel: `${owner?.displayName || "Provider owner"} · ${session?.deviceLabel || provider.deviceId}`, deviceId: provider.deviceId, tabId: provider.tabId, providerBinding: value.binding, name: value.definition.name, qualification: value.qualification, mode: value.qualification === "synthetic" ? "synthetic" : "application", ready: value.snapshot.actionReady, inputContract: value.definition.inputs, outputContract: value.definition.output, reason: value.snapshot.reason }); } catch { /* Unentitled or unqualified providers are not disclosed as candidates. */ }
  }
  return entries;
}

/** Outside writer transactions only. Original operation is reused after lost ACK/restart. */
export async function contactWorkflowProviderRead(p: Principal, intent: WorkflowEffectIntent) {
  if (!intent.provider || !intent.providerOperationId || !intent.executorActor || stableWorkflowJson(intent.executorActor) !== stableWorkflowJson(providerActor(p))) throw new WorkflowError("Only the original workflow actor/session/client may contact this provider intent.", "workflow_provider_actor", 403);
  const existing = await getIntegrationOperation(p, { operationId: intent.providerOperationId }).catch(error => { if ((error as { status?: number }).status === 404) return null; throw error; });
  const operation = existing?.operation ?? await prepareProviderOperation(p, { providerId: intent.provider.providerId, actionVersionId: intent.actionVersionId, operationId: intent.providerOperationId, input: intent.parameters }) as { state: string; revision: number };
  if (operation.state === "queued") await claimProviderOperation(p, { providerId: intent.provider.providerId, operationId: intent.providerOperationId, expectedRevision: operation.revision });
  return getIntegrationOperation(p, { operationId: intent.providerOperationId });
}
