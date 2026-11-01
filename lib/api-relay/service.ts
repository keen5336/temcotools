import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { apiRelayControl } from "./control";
import { dmpConfig, buildDmpRequest } from "./config";
import { authorizeDmpPayload } from "./payload-policy";

export class DmpError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const relaySessionId = (sessionId: string) => `v2:${hash(sessionId)}`;
function owner(principal: Principal) { return { userId: principal.userId, sessionId: relaySessionId(principal.sessionId!), authSessionId: principal.sessionId, authVersion: principal.authVersion, grantId: principal.grantId }; }
async function current(principal: Principal, capability: "workflow.read" | "workflow.execute" = "workflow.read") { return prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, capability)); }
export async function getDmpStatus(principal: Principal) {
  const actor = await current(principal), config = dmpConfig();
  const data = await apiRelayControl("connections", owner(actor));
  return { ...data, configured: config.configured, origins: config.origins, operations: Object.entries(config.operations).filter(([, op]) => ["GET", "HEAD"].includes(op.method || "GET") || actor.capabilities.includes("workflow.execute")).map(([id, op]) => ({ id, label: op.label, method: op.method || "GET" })) };
}
export async function renewDmpLease(principal: Principal) { return apiRelayControl("lease", owner(await current(principal))); }
export async function pairDmp(principal: Principal, raw: unknown) {
  const actor = await current(principal), data = z.object({ origin: z.string().url(), payload: z.unknown().optional() }).parse(raw), config = dmpConfig();
  if (!config.configured || !config.identity) throw new DmpError("Configure the signed-in DMP account lookup before pairing.", 503);
  if (!config.origins.includes(data.origin)) throw new DmpError("This DMP origin is not configured.");
  const payloadGrant = await authorizeDmpPayload(data.payload, data.origin);
  return apiRelayControl("pair", owner(actor), { origin: data.origin, identity: config.identity, subjectPath: config.subjectPath, payloadGrant });
}
export async function disconnectDmp(principal: Principal, raw: unknown) {
  const actor = await current(principal), { connectionId } = z.object({ connectionId: z.string().min(1).max(100) }).parse(raw);
  return apiRelayControl("disconnect", owner(actor), { connectionId });
}
const publicReceipt = { id: true, operationId: true, operation: true, method: true, state: true, requestId: true, upstreamStatus: true, responseHash: true, note: true, createdAt: true, completedAt: true } as const;
export async function listDmpReceipts(principal: Principal) {
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, principal, "workflow.read"); return tx.dmpOperation.findMany({ where: { actorUserId: principal.userId }, select: publicReceipt, orderBy: { createdAt: "desc" }, take: 100 }); });
}
export async function getDmpReceipt(principal: Principal, raw: unknown) {
  const { operationId } = z.object({ operationId: z.string().min(16).max(100) }).parse(raw);
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, principal, "workflow.read"); return tx.dmpOperation.findUnique({ where: { actorUserId_operationId: { actorUserId: principal.userId, operationId } }, select: publicReceipt }); });
}
export async function reconcileDmpOperation(principal: Principal, raw: unknown) {
  const data = z.object({ operationId: z.string().min(16).max(100), outcome: z.enum(["verified_applied", "verified_not_applied"]), evidence: z.string().trim().min(10).max(2000) }).strict().parse(raw);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "office.decide", true);
    const row = await tx.dmpOperation.findUnique({ where: { actorUserId_operationId: { actorUserId: principal.userId, operationId: data.operationId } } });
    if (!row) throw new DmpError("Your DMP operation was not found.", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dmp-effect:${principal.userId}:${row.inputHash}`}, 0))`;
    const current = await tx.dmpOperation.findUniqueOrThrow({ where: { id: row.id } });
    if (!["unknown", "dispatching"].includes(current.state)) throw new DmpError("Only uncertain intents require this reconciliation.", 409);
    if (current.state === "dispatching" && Date.now() - current.createdAt.getTime() < 150_000) throw new DmpError("The original request may still be in flight. Inspect its receipt after the bounded request window.", 409);
    const result = await tx.dmpOperation.update({ where: { id: row.id }, data: { state: data.outcome, note: data.evidence, completedAt: new Date() }, select: publicReceipt });
    await tx.identityAudit.create({ data: { action: "dmp_operation_reconciled", actorUserId: principal.userId, sessionId: principal.sessionId, reason: JSON.stringify({ receiptId: row.id, previousState: current.state, outcome: data.outcome, evidence: data.evidence, grantId: principal.grantId ?? null }) } });
    return result;
  });
}
export async function requestDmpOperation(principal: Principal, raw: unknown) {
  const data = z.object({ operationId: z.string().min(16).max(100), connectionId: z.string().min(1).max(100), operation: z.string().min(1).max(64), input: z.unknown().default({}) }).strict().parse(raw);
  const request = buildDmpRequest(data.operation, data.input), capability = ["GET", "HEAD"].includes(request.method) ? "workflow.read" : "workflow.execute";
  const inputHash = hash({ operation: data.operation, request });
  const prepared = await prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, principal, capability);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dmp-operation:${actor.userId}:${data.operationId}`}, 0))`;
    const existing = await tx.dmpOperation.findUnique({ where: { actorUserId_operationId: { actorUserId: actor.userId, operationId: data.operationId } }, select: { ...publicReceipt, inputHash: true } });
    if (existing) {
      if (existing.inputHash !== inputHash) throw new DmpError("This operation ID belongs to different DMP work.", 409);
      const { inputHash: _privateHash, ...receipt } = existing; void _privateHash;
      return { actor, created: false, receipt };
    }
    if (capability === "workflow.execute") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dmp-effect:${actor.userId}:${inputHash}`}, 0))`;
      const uncertain = await tx.dmpOperation.findFirst({ where: { actorUserId: actor.userId, inputHash, state: { in: ["dispatching", "unknown"] } }, select: { operationId: true } });
      if (uncertain) throw new DmpError(`A matching mutation has an uncertain or in-flight outcome. Inspect original operation ${uncertain.operationId}; changing its ID does not make a retry safe.`, 409);
    }
    const receipt = await tx.dmpOperation.create({ data: { actorUserId: actor.userId, actorSessionId: actor.sessionId!, actorGrantId: actor.grantId, operationId: data.operationId, operation: data.operation, method: request.method, connectionId: data.connectionId, inputHash, state: "dispatching", note: "Durable intent recorded before broker dispatch; no automatic retry." }, select: publicReceipt });
    return { actor, created: true, receipt };
  });
  if (!prepared.created) return { replayed: true, receipt: prepared.receipt, bodyAvailable: false, guidance: "The original intent was not sent again. A dispatching/unknown receipt requires upstream inspection; a response hash is evidence of a response, not proof of physical completion." };
  let response;
  try {
    response = await apiRelayControl("request", owner(prepared.actor), { connectionId: data.connectionId, operation: data.operation, request });
  } catch {
    const receipt = await prisma.dmpOperation.update({ where: { id: prepared.receipt.id }, data: { state: "unknown", completedAt: new Date(), note: "Broker result unavailable. It may have reached DMP. Inspect upstream before a separate explicitly authorized intent." }, select: publicReceipt });
    return { ok: false, receipt, guidance: receipt.note };
  }
  const body = typeof response.body === "string" ? response.body : undefined;
  const state = response.dispatchState === "not_dispatched" ? "not_dispatched" : response.ok && typeof response.status === "number" ? "response_observed" : "unknown";
  const receipt = await prisma.dmpOperation.update({ where: { id: prepared.receipt.id }, data: { state, requestId: typeof response.requestId === "string" ? response.requestId : undefined, upstreamStatus: typeof response.status === "number" ? response.status : undefined, responseHash: body === undefined ? undefined : hash(body), completedAt: new Date(), note: state === "response_observed" ? "An upstream HTTP response was observed. Business/physical completion is not inferred." : state === "not_dispatched" ? "Broker confirms no request dispatch. A separate reviewed intent may be created." : "Outcome uncertain. No automatic replay; inspect the existing upstream operation." }, select: publicReceipt });
  // Raw responses remain in this authorized request's memory/UI only. History
  // normalization needs qualified source mappings, not guessed response fields.
  return { ...response, receipt, replayed: false };
}
