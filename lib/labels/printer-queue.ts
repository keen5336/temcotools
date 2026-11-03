import { createHash } from "node:crypto";
import type { LabelIssuance, LabelPrinter, Prisma, PrintingDevice } from "@prisma/client";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, CAPABILITIES, type Capability, type Principal } from "@/lib/auth/principal";
import { currentPrintingDevice } from "./devices";
import { LabelError } from "./model";

const MAX_MANAGED_PRINTERS = 500;
const QUEUE_EVENT = "physical_printer_queue_reserved";
const RELEASED_STATES = ["sent_unconfirmed", "not_sent", "cancelled", "verified_not_printed", "print_confirmed", "applied"];
const HASH = /^[a-f0-9]{64}$/;
const id = (value: string) => { if (typeof value !== "string" || !value || value.length > 200) throw new LabelError("Provide a bounded existing issuance ID."); };
function siteOf(p: Principal) { if (!p.siteId || !p.sessionId) throw new AuthorizationError("A current warehouse and individual session are required."); return p.siteId; }

/** Exact normalized HTTP(S) destination equivalence only: no DNS/hardware inference. */
export function normalizedPrinterQueueEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new LabelError("The managed printer endpoint is invalid.", 409); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || endpoint.length > 2048) throw new LabelError("The managed printer endpoint is invalid.", 409);
  return url.href;
}
export function physicalPrinterQueueKey(siteId: string, endpoint: string): string {
  return createHash("sha256").update(JSON.stringify([siteId, normalizedPrinterQueueEndpoint(endpoint)])).digest("hex");
}
export function printerDestinationKey(endpoint: string): string {
  return createHash("sha256").update(`temco-print-destination:v1:${normalizedPrinterQueueEndpoint(endpoint)}`).digest("hex");
}
export function printerQueueReceipt(row: LabelIssuance) {
  return { id: row.id, siteId: row.siteId, operationId: row.operationId, actorUserId: row.actorUserId, actorSessionId: row.actorSessionId, deviceId: row.deviceId, printerId: row.printerId, state: row.state, createdAt: row.createdAt, dispatchedAt: row.dispatchedAt, reportedAt: row.reportedAt, physicallyConfirmedAt: row.physicallyConfirmedAt, appliedAt: row.appliedAt, physicalOutput: row.appliedAt ? "applied_confirmed" as const : row.physicallyConfirmedAt ? "print_confirmed" as const : "unconfirmed" as const };
}
export type PrinterQueueReceipt = ReturnType<typeof printerQueueReceipt>;
type LockedPrinterQueue = { row: LabelIssuance; printer: LabelPrinter; queueKey: string; destinationKey: string; printerIds: string[]; inventoryBoundExceeded: boolean };
export type PrinterQueueDecision =
  | { kind: "ready"; row: LabelIssuance; device: PrintingDevice; requester: Principal; queueKey: string; issuance: PrinterQueueReceipt; physicalPrintConfirmed: false }
  | { kind: "blocked"; code: "printer_busy" | "printer_unknown" | "printer_state_unknown" | "earlier_queued_job" | "printer_disabled" | "printer_inventory_limit" | "requester_authority_ended"; reason: string; issuance: PrinterQueueReceipt; mayDispatch: false }
  | { kind: "existing"; issuance: PrinterQueueReceipt; mayDispatch: false };

/** All callers acquire printer locks BEFORE their issuance row lock. No IO or commit occurs here. */
async function lockQueue(tx: Prisma.TransactionClient, principal: Principal, issuanceId: string): Promise<LockedPrinterQueue> {
  id(issuanceId); const siteId = siteOf(principal);
  const initial = await tx.labelIssuance.findFirst({ where: { id: issuanceId, siteId } });
  if (!initial) throw new LabelError("Label issuance not found in this warehouse.", 404);
  await tx.$queryRaw`SELECT id FROM "LabelPrinter" WHERE id=${initial.printerId} AND "siteId"=${siteId} FOR SHARE`;
  const printer = await tx.labelPrinter.findFirst({ where: { id: initial.printerId, siteId } });
  if (!printer) throw new LabelError("The original managed printer is unavailable.", 409);
  const queueKey = physicalPrinterQueueKey(siteId, printer.endpoint), destinationKey = printerDestinationKey(printer.endpoint);
  // A historical scope marker keeps a still-pending send on its original known
  // destination even if an administrator later edits the managed endpoint.
  const markers = await tx.labelIssuanceEvent.findMany({ where: { issuanceId, siteId, action: QUEUE_EVENT }, select: { note: true }, take: 9 });
  if (markers.length > 8) throw new LabelError("Inspect the retained printer reservations before another claim.", 409);
  const priorKeys = markers.map(marker => { try { const value = JSON.parse(marker.note) as { queueKey?: string }; if (value.queueKey && HASH.test(value.queueKey)) return value.queueKey; } catch { /* Fail closed below. */ } throw new LabelError("The retained physical-printer scope is invalid.", 409); });
  const previousDestinations = markers.flatMap(marker => { const value = JSON.parse(marker.note) as { destinationKey?: string }; if (value.destinationKey === undefined) return []; if (!HASH.test(value.destinationKey)) throw new LabelError("Original destination reservation is invalid.", 409); return [value.destinationKey]; });
  const lockKeys = [...new Set([`site:${siteId}:managed:${initial.printerId}`, `site:${siteId}:endpoint:${queueKey}`, ...priorKeys.map(key => `site:${siteId}:endpoint:${key}`), ...[destinationKey,...previousDestinations].map(key => `destination:${key}`)])].sort();
  for (const key of lockKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`label-physical-printer:${key}`}, 1493))`;
  await tx.$queryRaw`SELECT id FROM "LabelIssuance" WHERE id=${issuanceId} AND "siteId"=${siteId} FOR UPDATE`;
  const row = await tx.labelIssuance.findFirst({ where: { id: issuanceId, siteId } });
  if (!row || row.printerId !== initial.printerId) throw new LabelError("The original issuance printer changed. Inspect its retained intent.", 409);
  const printers = await tx.labelPrinter.findMany({ where: { siteId }, select: { id: true, endpoint: true }, take: MAX_MANAGED_PRINTERS + 1 });
  const printerIds = printers.filter(candidate => { try { return normalizedPrinterQueueEndpoint(candidate.endpoint) === normalizedPrinterQueueEndpoint(printer.endpoint); } catch { return false; } }).map(candidate => candidate.id);
  if (!printerIds.includes(printer.id)) printerIds.push(printer.id);
  return { row, printer, queueKey, destinationKey, printerIds, inventoryBoundExceeded: printers.length > MAX_MANAGED_PRINTERS };
}
function queueScope(locked: LockedPrinterQueue): Prisma.LabelIssuanceWhereInput {
  return { siteId: locked.row.siteId, OR: [{ printerId: { in: locked.printerIds } }, { events: { some: { action: QUEUE_EVENT, note: { contains: `"queueKey":"${locked.queueKey}"` } } } }] };
}
async function requester(tx: Prisma.TransactionClient, row: LabelIssuance) {
  const source = row.actorGrantId?.startsWith("oauth:") ? "oauth_grant" : row.actorGrantId ? "app_grant" : "session";
  if (row.actorAuthSource !== source) throw new AuthorizationError("The original print authority is unsupported.");
  const captured: Principal = { siteId: row.siteId, userId: row.actorUserId, sessionId: row.actorSessionId, authVersion: row.actorAuthVersion, grantId: row.actorGrantId ?? undefined, username: "", displayName: "", role: "user", capabilities: row.actorCapabilities.filter((cap): cap is Capability => CAPABILITIES.includes(cap as Capability)) };
  return assertCurrentPrincipal(tx, captured, "labels.print");
}
const blocked = (locked: LockedPrinterQueue, code: Extract<PrinterQueueDecision, { kind: "blocked" }>["code"], reason: string): PrinterQueueDecision => ({ kind: "blocked", code, reason, issuance: printerQueueReceipt(locked.row), mayDispatch: false });

/**
 * Call at the START of the existing claim writer, before lockIssuance. The ready
 * result is queue eligibility, not a send token: retain native template/context
 * checks and queued->dispatching update in THIS SAME transaction before commit.
 */
export async function gatePrinterQueueDispatch(tx: Prisma.TransactionClient, principal: Principal, input: { issuanceId: string; deviceId: string; deviceToken: string }): Promise<PrinterQueueDecision> {
  const device = await currentPrintingDevice(tx, principal, input.deviceId, input.deviceToken);
  const locked = await lockQueue(tx, principal, input.issuanceId), { row } = locked;
  if (row.deviceId !== device.id || row.mode !== device.mode || device.siteId !== row.siteId || !device.printerIds.includes(row.printerId)) throw new AuthorizationError("This issuance stays bound to its original authorized printing device and warehouse.");
  if (row.state !== "queued") return { kind: "existing", issuance: printerQueueReceipt(row), mayDispatch: false };
  let currentRequester: Principal;
  try { currentRequester = await requester(tx, row); }
  catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // Native issuance already uses this outcome for authority ending before any
    // dispatch. Retire only this exact untouched queued intent, never a sibling.
    const cancelled = await tx.labelIssuance.update({ where: { id: row.id, state: "queued" }, data: { state: "not_sent", reportedAt: new Date() } });
    await tx.labelIssuanceEvent.create({ data: { siteId: row.siteId, issuanceId: row.id, actorUserId: principal.userId, deviceId: device.id, action: "authorization_ended_before_dispatch", state: cancelled.state, note: "Original requester/session/client authority ended before the physical-printer queue claim. No send was authorized." } });
    return { kind: "blocked", code: "requester_authority_ended", reason: "Original requester authority ended. This exact queued intent was retired without sending.", issuance: printerQueueReceipt(cancelled), mayDispatch: false };
  }
  if (!locked.printer.isActive) return blocked(locked, "printer_disabled", "The original managed printer is disabled. No other printer was selected.");
  if (locked.inventoryBoundExceeded) return blocked(locked, "printer_inventory_limit", "The bounded managed-printer inventory requires review before alias-safe dispatch.");
  const active = await tx.labelIssuance.findFirst({ where: { ...queueScope(locked), state: { notIn: ["queued", ...RELEASED_STATES] } }, select: { state: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (active) return blocked(locked, active.state === "unknown" ? "printer_unknown" : active.state === "dispatching" ? "printer_busy" : "printer_state_unknown", active.state === "unknown" ? "This physical printer has an uncertain original result. Explicit authorized reconciliation is required; no replay or reroute is allowed." : active.state === "dispatching" ? "This physical printer already has one dispatch in flight. Wait for its original device report." : "This physical printer has an unsupported retained state. Inspect its original receipt before dispatching.");
  const occupancy = await tx.$queryRaw<Array<{ busy: boolean }>>`SELECT public.temco_printer_destination_busy(${row.id},${locked.destinationKey}) AS busy`;
  if (occupancy[0]?.busy !== false) return blocked(locked, "printer_busy", "This managed destination has another in-flight or uncertain issuance. No other warehouse's job or identity is disclosed; no replay or reroute is allowed.");
  const older = await tx.labelIssuance.findFirst({ where: { ...queueScope(locked), state: "queued", AND: [{ OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }] }] }, select: { id: true } });
  if (older) return blocked(locked, "earlier_queued_job", "An earlier prepared issuance is waiting for this physical printer. Its original device must claim it, or an authorized person must cancel it; jobs never overtake or reroute it.");
  await tx.labelIssuanceEvent.create({ data: { siteId: row.siteId, issuanceId: row.id, actorUserId: principal.userId, deviceId: device.id, action: QUEUE_EVENT, state: row.state, note: JSON.stringify({ queueKey: locked.queueKey, destinationKey: locked.destinationKey, printerId: row.printerId, requesterUserId: row.actorUserId, requesterSessionId: row.actorSessionId, deviceOwnerUserId: device.userId, deviceOwnerSessionId: device.sessionId, physicalPrintConfirmed: false }) } });
  return { kind: "ready", row, device, requester: currentRequester, queueKey: locked.queueKey, issuance: printerQueueReceipt(row), physicalPrintConfirmed: false };
}

/** Use before issuance row locking in report/cancel/reconcile writers, too. */
export async function lockPrinterQueueSettlement(tx: Prisma.TransactionClient, principal: Principal, issuanceId: string): Promise<LabelIssuance> {
  const current = await assertCurrentPrincipal(tx, principal, "labels.print");
  return (await lockQueue(tx, current, issuanceId)).row;
}
