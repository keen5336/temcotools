import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { apiRelayControl } from "@/lib/api-relay/control";
import { activateProviderRuntime, providerRuntimeActivationInput } from "./provider-runtime";

const id = z.string().min(1).max(200), operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,150}$/);
export const providerOperationPrepareInput = z.object({ providerId: id, actionVersionId: id, operationId, input: z.unknown().default({}) }).strict();
export const providerOperationClaimInput = z.object({ providerId: id, operationId, expectedRevision: z.number().int().positive() }).strict();
export const providerOperationCancelInput = z.object({ providerId: id, operationId }).strict();
export const providerDisconnectInput = z.object({ providerId: id }).strict();
export const providerActivateInput = providerRuntimeActivationInput;
export function providerActor(p: Principal) {
  if (!p.siteId || !p.sessionId) throw new AuthorizationError("Use a current individual warehouse session.");
  return { userId: p.userId, sessionId: p.sessionId, siteId: p.siteId, authVersion: p.authVersion, ...(p.grantId ? { grantId: p.grantId } : {}) };
}
export async function genericProviderControl(p: Principal, method: string, data: Record<string, unknown> = {}) {
  const actor = await prisma.$transaction(tx => assertCurrentPrincipal(tx, p, method === "list" ? "account.self" : "workflow.read"));
  return apiRelayControl(`provider.${method}`, providerActor(actor), data);
}
export async function activateAndPairProvider(p: Principal, raw: unknown) {
  if (p.grantId) return { status: "requires_user_interaction", actionUrl: `${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin}/management/connections`, instruction: "The human must activate the approved provider from its own injected upstream tab. MCP cannot perform login, activation or sharing consent." };
  const data = providerActivateInput.parse(raw);
  const activated = await activateProviderRuntime(p, data);
  if ("status" in activated) return activated;
  const actor = await prisma.$transaction(tx => assertCurrentPrincipal(tx, p, "workflow.read"));
  const pairing = await apiRelayControl("provider.pair", { ...providerActor(actor), deviceId: activated.binding.owner.deviceId, tabId: activated.binding.owner.tabId }, { providerId: data.providerId });
  return { ...pairing, binding: activated.binding };
}
export async function prepareProviderOperation(p: Principal, raw: unknown) { return genericProviderControl(p, "prepare", providerOperationPrepareInput.parse(raw)); }
export async function claimProviderOperation(p: Principal, raw: unknown) { return genericProviderControl(p, "claim", providerOperationClaimInput.parse(raw)); }
export async function cancelProviderOperation(p: Principal, raw: unknown) { return genericProviderControl(p, "cancel", providerOperationCancelInput.parse(raw)); }
export async function disconnectProvider(p: Principal, raw: unknown) {
  if (p.grantId) return { status: "requires_user_interaction", actionUrl: `${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin}/management/connections`, instruction: "The human owner must disconnect the original provider in its owning browser session." };
  const data = providerDisconnectInput.parse(raw);
  const actor = await prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, p, "workflow.read"); const provider = await tx.providerConnection.findFirst({ where: { id: data.providerId, ownerUserId: current.userId, ownerSessionId: current.sessionId } }); if (!provider) throw new AuthorizationError("Use the original owning provider session."); return { ...providerActor(current), deviceId: provider.deviceId, tabId: provider.tabId }; });
  return apiRelayControl("provider.disconnect", actor, data);
}
