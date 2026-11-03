import { createHash, randomUUID } from "node:crypto";
import type { Prisma, WarehouseUnitTransfer } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { pilotPolicy } from "../../scripts/pilot-policy.mjs";

const id = z.string().trim().min(1).max(200), operationId = z.string().min(16).max(150), note = z.string().trim().min(3).max(1000);
const handoff = z.object({ description: z.string().trim().max(250).optional(), handlingInstruction: z.string().trim().max(1000).optional(), reference: z.string().trim().max(200).optional() }).strict();
export const custodyProposeInput = z.object({ operationId, unitId: id, destinationSiteId: id, aliasIds: z.array(id).min(1).max(50), handoff, note }).strict();
export const custodyActionInput = z.object({ operationId, transferId: id, expectedRevision: z.number().int().positive(), note }).strict();
export const custodyPhysicalInput = custodyActionInput.extend({ observationId: id });
export const custodyGetInput = z.object({ transferId: id }).strict();
export const custodyHistoryInput = z.object({ unitId: id.optional(), afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const custodyUnitInput = z.object({ unitId: id }).strict();
export class CustodyError extends Error { constructor(message: string, readonly status = 400) { super(message); this.name = "CustodyError"; } }
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function siteOf(actor: Principal) { if (!actor.siteId) throw new CustodyError("Select an authorized warehouse.", 403); return actor.siteId; }
function receipt(row: WarehouseUnitTransfer) {
  return JSON.parse(JSON.stringify({ ...row, physicalCompletion: row.state === "checked_in" ? "independent_destination_observation" : "not_established_by_scheduling", upstreamMutationPerformed: false, automaticReplayAllowed: false })) as WarehouseUnitTransfer & { physicalCompletion: string; upstreamMutationPerformed: false; automaticReplayAllowed: false };
}
function physicalAllowed() { if (pilotPolicy().isolated) throw new CustodyError("Physical departure/check-in execution is disabled in this isolated pilot. Planning and history remain available; no warehouse effect was recorded.", 403); }
async function unitLock(tx: Prisma.TransactionClient, unitId: string) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`custody-unit:${unitId}`},817))`; }
async function lockedTransfer(tx: Prisma.TransactionClient, transferId: string, expectedRevision: number) {
  const first = await tx.warehouseUnitTransfer.findUnique({ where: { id: transferId }, select: { unitId: true } });
  if (!first) throw new CustodyError("Transfer not found in this warehouse.", 404);
  await unitLock(tx, first.unitId);
  await tx.$queryRaw`SELECT id FROM "WarehouseUnitTransfer" WHERE id=${transferId} FOR UPDATE`;
  const row = await tx.warehouseUnitTransfer.findUniqueOrThrow({ where: { id: transferId } });
  if (row.revision !== expectedRevision) throw new CustodyError("The transfer changed. Reload its current revision.", 409);
  return row;
}
async function command<T>(p: Principal, kind: string, input: { operationId: string }, run: (tx: Prisma.TransactionClient, actor: Principal) => Promise<{ row: WarehouseUnitTransfer; detail?: unknown; extra?: T }>) {
  const fingerprint = hash({ kind, input });
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.custody"), siteId = siteOf(actor);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8100801)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`custody-command:${siteId}:${actor.userId}:${input.operationId}`},817))`;
    const existing = await tx.warehouseUnitTransferEvent.findUnique({ where: { siteId_actorUserId_operationId: { siteId, actorUserId: actor.userId, operationId: input.operationId } } });
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CustodyError("This operation ID was already used for different custody inputs.", 409);
      return { ...(existing.result as object), replayed: true } as { transfer: ReturnType<typeof receipt>; replayed: boolean } & T;
    }
    const result = await run(tx, actor), value = { transfer: receipt(result.row), ...result.extra, replayed: false };
    await tx.warehouseUnitTransferEvent.create({ data: { id: randomUUID(), siteId, transferId: result.row.id, actorUserId: actor.userId, actorSessionId: actor.sessionId!, operationId: input.operationId, kind, fingerprint, detail: json(result.detail ?? {}), result: json(value) } });
    return value;
  }, { timeout: 30_000 });
}
/** Private origin evidence is accessible only in its original site context. */
export async function getUnitOriginInTransaction(tx: Prisma.TransactionClient, unitId: string) { return tx.warehouseUnitOrigin.findUnique({ where: { unitId } }); }
/** Exact visible identity or a non-identifying conflict. Never returns a foreign ID. */
export async function getPermittedImportedIdentityInTransaction(tx: Prisma.TransactionClient, lpn: string) {
  const [result] = await tx.$queryRaw<{ unitId: string | null; conflict: boolean }[]>`SELECT * FROM public.temco_custody_import_identity(${lpn})`;
  return result ?? { unitId: null, conflict: false };
}
/** Trusted query seam for the existing typed resolver; no private alias evidence. */
export async function listSharedWarehouseAliasesInTransaction(tx: Prisma.TransactionClient, input: { value: string; kind?: string; namespace?: string }) {
  return tx.warehouseUnitAlias.findMany({ where: { value: input.value.trim().toUpperCase(), revokedAt: null, ...(input.kind && input.kind !== "auto" ? { kind: input.kind } : {}), ...(input.namespace ? { namespace: input.namespace.trim().toLowerCase() } : {}) }, orderBy: [{ unitId: "asc" }, { id: "asc" }], take: 101, include: { unit: { include: { inventoryRows: { select: { lpn: true, orderNumber: true, description: true, status: true } } } } } });
}
/** Native effect consumers call this within their existing writer transaction. */
export async function assertUnitOperationalCustodyInTransaction(tx: Prisma.TransactionClient, p: Principal, unitId: string) {
  const actor = await assertCurrentPrincipal(tx, p), siteId = siteOf(actor);
  await unitLock(tx, unitId);
  const participation = await tx.warehouseUnitSite.findUnique({ where: { siteId_unitId: { siteId, unitId } } });
  if (!participation || !["unestablished", "checked_in"].includes(participation.phase)) throw new CustodyError("This warehouse has no operational custody for this unit. Expected movement and historical access do not grant execution rights.", 409);
  return { ...participation, physicalPresence: participation.holdsCustody ? "confirmed_check_in_not_live_presence" : "unestablished_legacy_association", grantsAuthority: false };
}
export async function listCustodySites(p: Principal) {
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.custody");
    const sites = await tx.warehouseSite.findMany({ where: { isActive: true, ...(actor.isPlatformAdmin ? {} : { memberships: { some: { userId: actor.userId, isActive: true, roles: { some: { role: { isActive: true, capabilities: { has: "inventory.custody" } } } } } } }) }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" }, take: 100 });
    return { sites, meaning: "Your authorized warehouse selectors only. Another receiver may provide their exact destination ID; acceptance still requires that site's current custody authority." };
  });
}
export async function proposeUnitCustody(p: Principal, raw: unknown) {
  const data = custodyProposeInput.parse(raw);
  if (new Set(data.aliasIds).size !== data.aliasIds.length) throw new CustodyError("Choose distinct approved aliases.");
  if (/\b(cookie|authorization|bearer|password|secret|token)\s*[:=]/i.test(JSON.stringify(data.handoff))) throw new CustodyError("Handoff fields cannot contain credentials or captured payloads.");
  return command(p, "proposed", data, async (tx, actor) => {
    const sourceSiteId = siteOf(actor);
    if (sourceSiteId === data.destinationSiteId) throw new CustodyError("Choose a different destination warehouse.");
    await assertUnitOperationalCustodyInTransaction(tx, actor, data.unitId);
    const [destination] = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT * FROM public.temco_custody_destination(${data.destinationSiteId})`;
    if (!destination) throw new CustodyError("Destination warehouse is unavailable.", 404);
    const aliases = await tx.warehouseUnitAlias.findMany({ where: { id: { in: data.aliasIds }, unitId: data.unitId, revokedAt: null }, orderBy: { id: "asc" } });
    if (aliases.length !== data.aliasIds.length) throw new CustodyError("Choose only current aliases visible for this exact unit.", 409);
    if (await tx.warehouseUnitTransfer.findFirst({ where: { unitId: data.unitId, state: { in: ["proposed", "accepted", "departed"] } } })) throw new CustodyError("This unit already has an open transfer.", 409);
    const row = await tx.warehouseUnitTransfer.create({ data: { id: randomUUID(), unitId: data.unitId, sourceSiteId, destinationSiteId: destination.id, aliasIds: aliases.map(alias => ({ id: alias.id, revision: alias.revision, kind: alias.kind, namespace: alias.namespace, value: alias.value })), handoff: json(data.handoff), proposedByUserId: actor.userId } });
    return { row, detail: { note: data.note, observationClaim: "none; scheduling does not establish departure or arrival" } };
  });
}
export async function acceptUnitCustody(p: Principal, raw: unknown) {
  const data = custodyActionInput.parse(raw);
  return command(p, "accepted", data, async (tx, actor) => {
    const row = await lockedTransfer(tx, data.transferId, data.expectedRevision);
    if (row.destinationSiteId !== siteOf(actor) || row.state !== "proposed") throw new CustodyError("Accept this proposed transfer from its destination warehouse.", 409);
    const saved = await tx.warehouseUnitTransfer.update({ where: { id: row.id, revision: row.revision }, data: { state: "accepted", revision: { increment: 1 }, acceptedByUserId: actor.userId, acceptedAt: new Date() } });
    return { row: saved, detail: { note: data.note, grantsSourceDispositionsOrProviderAuthority: false } };
  });
}
export async function departUnitCustody(p: Principal, raw: unknown) {
  const data = custodyPhysicalInput.parse(raw);
  return command(p, "departed", data, async (tx, actor) => {
    physicalAllowed();
    const row = await lockedTransfer(tx, data.transferId, data.expectedRevision);
    if (row.sourceSiteId !== siteOf(actor) || row.state !== "accepted") throw new CustodyError("Confirm departure at the source after destination acceptance.", 409);
    const observation = await verifiedObservation(tx, row, data.observationId, "departure", row.acceptedAt!);
    const saved = await tx.warehouseUnitTransfer.update({ where: { id: row.id, revision: row.revision }, data: { state: "departed", revision: { increment: 1 }, departureObservationId: observation.id, departedByUserId: actor.userId, departedAt: observation.capturedAt } });
    return { row: saved, detail: { note: data.note, observationId: observation.id, destinationPresence: "not_confirmed" } };
  });
}
export async function checkInUnitCustody(p: Principal, raw: unknown) {
  const data = custodyPhysicalInput.parse(raw);
  return command(p, "checked_in", data, async (tx, actor) => {
    physicalAllowed();
    const row = await lockedTransfer(tx, data.transferId, data.expectedRevision);
    if (row.destinationSiteId !== siteOf(actor) || row.state !== "departed") throw new CustodyError("Check in at the destination after source departure is confirmed.", 409);
    const observation = await verifiedObservation(tx, row, data.observationId, "check_in", row.departedAt!);
    const saved = await tx.warehouseUnitTransfer.update({ where: { id: row.id, revision: row.revision }, data: { state: "checked_in", revision: { increment: 1 }, checkInObservationId: observation.id, checkedInByUserId: actor.userId, checkedInAt: observation.capturedAt } });
    return { row: saved, detail: { note: data.note, observationId: observation.id, physicalPresence: "as_observed_not_live_presence", sourceRightsTransferred: false } };
  });
}
async function verifiedObservation(tx: Prisma.TransactionClient, transfer: WarehouseUnitTransfer, observationId: string, type: "departure" | "check_in", notBefore: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`observation-correction:${observationId}`},0))`;
  await tx.$queryRaw`SELECT id FROM "WarehousePhysicalObservation" WHERE id=${observationId} FOR SHARE`;
  const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
  const effectiveUnit = observation?.corrections[0] ? observation.corrections[0].unitId : observation?.unitId;
  if (!observation || effectiveUnit !== transfer.unitId || observation.type !== type || observation.resolution !== "resolved" || observation.capturedAt < notBefore || observation.capturedAt.getTime() > Date.now() + 300_000) throw new CustodyError("Use a fresh, uniquely resolved independent observation for this exact unit and warehouse. Unknown or ambiguous scans remain evidence and cannot complete custody.", 409);
  const aliases = await listSharedWarehouseAliasesInTransaction(tx, { value: observation.rawIdentifier, kind: observation.identifierType, namespace: observation.identifierNamespace ?? undefined });
  const units = new Set(aliases.map(alias => alias.unitId)), pins = transfer.aliasIds as { id: string; revision: number }[];
  if (aliases.length > 100 || units.size !== 1 || !units.has(transfer.unitId) || !aliases.some(alias => pins.some(pin => pin.id === alias.id && pin.revision === alias.revision))) throw new CustodyError("The observed identifier is ambiguous or no longer matches an approved transfer alias. Reconcile identity; no check-in/departure was inferred.", 409);
  return observation;
}
export async function cancelUnitCustody(p: Principal, raw: unknown) {
  const data = custodyActionInput.parse(raw);
  return command(p, "cancelled", data, async (tx, actor) => {
    const row = await lockedTransfer(tx, data.transferId, data.expectedRevision);
    if (![row.sourceSiteId, row.destinationSiteId].includes(siteOf(actor)) || !["proposed", "accepted"].includes(row.state)) throw new CustodyError("Only un-departed transfers can be cancelled. Reconcile in-transit freight or arrange a separately authorized return.", 409);
    const saved = await tx.warehouseUnitTransfer.update({ where: { id: row.id, revision: row.revision }, data: { state: "cancelled", revision: { increment: 1 }, cancelledByUserId: actor.userId, cancelledAt: new Date() } });
    return { row: saved, detail: { note: data.note, physicalPresenceChanged: false } };
  });
}
export async function getUnitCustodyTransfer(p: Principal, raw: unknown) {
  const data = custodyGetInput.parse(raw);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.read"), siteId = siteOf(actor);
    const row = await tx.warehouseUnitTransfer.findUnique({ where: { id: data.transferId } });
    if (!row) throw new CustodyError("Transfer not found in this warehouse.", 404);
    const aliases = await tx.warehouseUnitAlias.findMany({ where: { id: { in: (row.aliasIds as { id: string }[]).map(alias => alias.id) } }, select: { id: true, unitId: true, kind: true, namespace: true, value: true, revokedAt: true, revision: true } });
    const events = await tx.warehouseUnitTransferEvent.findMany({ where: { transferId: row.id, siteId }, select: { id: true, kind: true, actorUserId: true, actorSessionId: true, detail: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 100 });
    return { transfer: receipt(row), aliases, events, historyScope: "This transfer's approved handoff plus your warehouse's own events. Other-site private history and later transfers are not included." };
  });
}
export async function listUnitCustodyHistory(p: Principal, raw: unknown) {
  const data = custodyHistoryInput.parse(raw);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.read"), siteId = siteOf(actor);
    const rows = await tx.warehouseUnitTransfer.findMany({ where: { OR: [{ sourceSiteId: siteId }, { destinationSiteId: siteId }], ...(data.unitId ? { unitId: data.unitId } : {}), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, orderBy: { id: "asc" }, take: data.limit + 1 });
    return { transfers: rows.slice(0, data.limit).map(receipt), nextAfterId: rows.length > data.limit ? rows[data.limit - 1].id : null, historyScope: "Only transfers involving this current warehouse; shared identity is not permission to read other warehouses' trails." };
  });
}
export async function getWarehouseUnitCustody(p: Principal, raw: unknown) {
  const data = custodyUnitInput.parse(raw);
  return prisma.$transaction(async tx => {
    const actor = await assertCurrentPrincipal(tx, p, "inventory.read"), siteId = siteOf(actor);
    const unit = await tx.warehouseUnit.findUnique({ where: { id: data.unitId }, select: { id: true, createdAt: true } });
    if (!unit) throw new CustodyError("Physical unit not found in this warehouse.", 404);
    const origin = await getUnitOriginInTransaction(tx, unit.id);
    return { unit, participation: await tx.warehouseUnitSite.findUnique({ where: { siteId_unitId: { siteId, unitId: unit.id } } }), aliases: await tx.warehouseUnitAlias.findMany({ where: { unitId: unit.id }, select: { id: true, kind: true, namespace: true, value: true, revokedAt: true, revision: true }, orderBy: { id: "asc" } }), privateOrigin: origin ? { creationEvidence: origin.creationEvidence, createdByUserId: origin.createdByUserId, createdAt: origin.createdAt } : null, physicalPresence: "Reported/expected movement is not physical proof; a check-in is an attributed past observation, not a live sensor." };
  });
}
