import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { getUnitOriginInTransaction, listSharedWarehouseAliasesInTransaction } from "./custody";
import { WAREHOUSE_IDENTITY_IMPORT_LOCK } from "./source-history";

export const IDENTIFIER_KINDS = ["lpn", "msn", "serial", "submission"] as const;
export type WarehouseIdentifierKind = (typeof IDENTIFIER_KINDS)[number];
export type WarehouseIdentifierInput = { value: string; kind?: WarehouseIdentifierKind | "auto"; namespace?: string };
export type ObservationInput = {
  eventId: string; rawIdentifier: string; identifierType?: WarehouseIdentifierKind | "auto";
  namespace?: string; type: "presence" | "check_in" | "placement" | "departure";
  location?: string; capturedAt: string; deviceId?: string; capturedByUserId?: string; pickWaveId?: string;
  captureMethod?: "scanner" | "manual" | "ocr";
};

// Shared command input contracts also describe these actions to MCP clients.
// The domain checks below still enforce timestamp, custody and identity rules.
const unitIdInput = z.string().trim().min(1).max(200);
const evidenceInput = z.string().trim().min(1).max(2000);
export const warehouseIdentifierInput = z.object({ value: z.string().min(1).max(500), kind: z.enum([...IDENTIFIER_KINDS, "auto"]).optional(), namespace: z.string().max(100).optional() });
export const warehouseUnitInput = z.object({ unitId: unitIdInput });
export const warehouseHistoryInput = warehouseUnitInput.extend({ cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(200).optional() });
export const warehouseCreateInput = z.object({ operationId: z.string().trim().min(1).max(150), evidence: evidenceInput });
export const warehouseAliasInput = warehouseIdentifierInput.extend({ unitId: unitIdInput, kind: z.enum(IDENTIFIER_KINDS), evidence: evidenceInput });
export const warehouseUnlinkInput = z.object({ identifierId: unitIdInput, reason: evidenceInput });
export const warehouseCorrectionInput = z.object({ observationId: unitIdInput, operationId: z.string().trim().min(1).max(150), unitId: unitIdInput.nullable(), reason: evidenceInput, expectedRevision: z.number().int().min(0) });
export const warehouseObservationInput = z.object({
  eventId: z.string().trim().min(1).max(150), rawIdentifier: z.string().min(1).max(500),
  identifierType: z.enum([...IDENTIFIER_KINDS, "auto"]).optional(), namespace: z.string().trim().max(100).optional(),
  type: z.enum(["presence", "check_in", "placement", "departure"]), location: z.string().trim().max(200).optional(),
  capturedAt: z.string().max(100), deviceId: unitIdInput.optional(), capturedByUserId: unitIdInput.optional(),
  pickWaveId: unitIdInput.optional(), captureMethod: z.enum(["scanner", "manual", "ocr"]).optional(),
});

export class WarehouseCommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "WarehouseCommandError"; }
}

function commandInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WarehouseCommandError(`Invalid input: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

function text(value: unknown, field: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new WarehouseCommandError(`${field} must contain 1–${max} characters.`);
  return value.trim();
}
function optionalText(value: unknown, field: string, max = 200) { return value === undefined || value === null || value === "" ? null : text(value, field, max); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function parseIdentifier(input: WarehouseIdentifierInput) {
  input = commandInput(warehouseIdentifierInput, input);
  const kind = input.kind ?? "auto";
  if (kind !== "auto" && !IDENTIFIER_KINDS.includes(kind)) throw new WarehouseCommandError("Choose LPN, MSN, serial, submission or automatic identifier lookup.");
  return { kind, value: text(input.value, "Identifier").toUpperCase(), namespace: optionalText(input.namespace, "Identifier namespace", 100)?.toLowerCase() ?? null };
}

async function resolveInTransaction(tx: Prisma.TransactionClient, input: ReturnType<typeof parseIdentifier>) {
  // Shared aliases contain only approved identifiers. Their evidence and each
  // unit's source rows remain scoped to this warehouse by independent RLS.
  const aliases = await listSharedWarehouseAliasesInTransaction(tx, { value: input.value, kind: input.kind, ...(input.namespace ? { namespace: input.namespace } : {}) });
  const unitMap = new Map(aliases.map((alias) => [alias.unitId, { unitId: alias.unitId, lpns: alias.unit.inventoryRows.map((row) => row.lpn), reportedRows: alias.unit.inventoryRows, createdAt: alias.unit.createdAt.toISOString() }]));
  const candidates = [...unitMap.values()];
  // An over-limit lookup cannot safely claim a unique resolution.
  const resolution = aliases.length > 100 || candidates.length > 1 ? "ambiguous" as const : candidates.length === 1 ? "resolved" as const : "unresolved" as const;
  return { resolution, unitId: resolution === "resolved" ? candidates[0].unitId : null, candidateUnitIds: candidates.map((unit) => unit.unitId), candidates, truncated: aliases.length > 100 };
}

export async function resolveWarehouseIdentifier(principal: Principal, input: WarehouseIdentifierInput) {
  assertCapability(principal, "inventory.read");
  const identifier = parseIdentifier(input);
  const resolved = await prisma.$transaction(async (tx) => { await assertCurrentPrincipal(tx, principal, "inventory.read"); return resolveInTransaction(tx, identifier); }, { isolationLevel: "RepeatableRead" });
  return { ...resolved, identifier, physicalPresence: "not_determined" as const };
}

function observationReceipt(observation: { id: string; userId: string; eventId: string; rawIdentifier: string; identifierType: string; identifierNamespace: string | null; type: string; location: string | null; deviceId: string | null; pickWaveId: string | null; captureMethod: string; capturedAt: Date; receivedAt: Date; unitId: string | null; resolution: string; candidateUnitIds: Prisma.JsonValue }) {
  return { observationId: observation.id, eventId: observation.eventId, capturedByUserId: observation.userId, rawIdentifier: observation.rawIdentifier, identifierType: observation.identifierType, namespace: observation.identifierNamespace, type: observation.type, location: observation.location, deviceId: observation.deviceId, pickWaveId: observation.pickWaveId, captureMethod: observation.captureMethod, capturedAt: observation.capturedAt.toISOString(), receivedAt: observation.receivedAt.toISOString(), unitId: observation.unitId, resolution: observation.resolution, candidateUnitIds: observation.candidateUnitIds };
}

async function persistPhysicalObservation(tx: Prisma.TransactionClient, principal: Principal, input: ObservationInput, capability: "inventory.write" | "workflow.execute") {
  assertCapability(principal, capability);
  input = commandInput(warehouseObservationInput, input);
  const eventId = text(input.eventId, "Scan event ID", 150);
  text(input.rawIdentifier, "Scanned identifier");
  const rawIdentifier = input.rawIdentifier;
  if (rawIdentifier.length > 500) throw new WarehouseCommandError("Scanned identifier exceeds 500 characters.");
  const identifier = parseIdentifier({ value: rawIdentifier, kind: input.identifierType, namespace: input.namespace });
  if (!["presence", "check_in", "placement", "departure"].includes(input.type)) throw new WarehouseCommandError("Choose presence, check-in, placement or departure.");
  if (input.capturedByUserId !== undefined && input.capturedByUserId !== principal.userId) throw new WarehouseCommandError("This captured event belongs to another user. Sign in as its original operator.", 403);
  const capturedAt = new Date(input.capturedAt);
  if (Number.isNaN(capturedAt.getTime()) || !/T.*(Z|[+-]\d{2}:\d{2})$/.test(input.capturedAt) || capturedAt.getTime() > Date.now() + 300_000) throw new WarehouseCommandError("Capture time must be a valid timestamp with timezone, no more than five minutes in the future.");
  const location = optionalText(input.location, "Observed location");
  if (input.type === "placement" && !location) throw new WarehouseCommandError("Placement confirmation requires the actual destination location.");
  const deviceId = optionalText(input.deviceId, "Device reference");
  const pickWaveId = optionalText(input.pickWaveId, "Pick Wave context");
  const captureMethod = input.captureMethod ?? "manual";
  if (!["scanner", "manual", "ocr"].includes(captureMethod)) throw new WarehouseCommandError("Unsupported capture method.");
  const fingerprint = hash({ eventId, rawIdentifier, identifier, type: input.type, location, deviceId, pickWaveId, captureMethod, capturedAt: capturedAt.toISOString(), actor: principal.userId });
    await assertCurrentPrincipal(tx, principal, capability);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-event:${principal.userId}:${eventId}`}, 0))`;
    const existing = await tx.warehousePhysicalObservation.findUnique({ where: { userId_eventId: { userId: principal.userId, eventId } } });
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new WarehouseCommandError("This event ID was already used for different scan evidence.", 409);
      return { observation: observationReceipt(existing), resolution: existing.resolution, unitId: existing.unitId, candidateUnitIds: existing.candidateUnitIds, replayed: true };
    }
    const resolved = await resolveInTransaction(tx, identifier);
    const observation = await tx.warehousePhysicalObservation.create({ data: { id: randomUUID(), userId: principal.userId, eventId, fingerprint, rawIdentifier, identifierType: identifier.kind, identifierNamespace: identifier.namespace, type: input.type, location, deviceId, pickWaveId, captureMethod, capturedAt, unitId: resolved.unitId, resolution: resolved.resolution, candidateUnitIds: resolved.candidateUnitIds } });
    return { observation: observationReceipt(observation), resolution: resolved.resolution, unitId: resolved.unitId, candidateUnitIds: resolved.candidateUnitIds, replayed: false };
}

export async function recordWarehouseObservation(principal: Principal, input: ObservationInput) {
  assertCapability(principal, "inventory.write");
  return prisma.$transaction((tx) => persistPhysicalObservation(tx, principal, input, "inventory.write"));
}

// Trusted workflow writers reuse the native observation validation and current
// inventory authority inside the same transaction as the originating run step.
export async function recordWarehouseObservationInTransaction(tx: Prisma.TransactionClient, principal: Principal, input: ObservationInput) {
  return persistPhysicalObservation(tx, principal, input, "inventory.write");
}

// Trusted task commands can commit their own physical confirmation and task
// result together. API/MCP callers cannot select an authorization capability.
export async function recordWorkflowObservation(tx: Prisma.TransactionClient, principal: Principal, input: ObservationInput) {
  return persistPhysicalObservation(tx, principal, input, "workflow.execute");
}

export async function resolveWarehouseIdentifierInTransaction(tx: Prisma.TransactionClient, input: WarehouseIdentifierInput) {
  return resolveInTransaction(tx, parseIdentifier(input));
}

export async function createWarehouseUnit(principal: Principal, input: { operationId: string; evidence: string }) {
  assertCapability(principal, "inventory.identify");
  input = commandInput(warehouseCreateInput, input);
  const operationId = text(input.operationId, "Operation ID", 150);
  const evidence = text(input.evidence, "Identity evidence", 2000);
  const id = `manual-unit:${hash([principal.userId, operationId])}`;
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "inventory.identify");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const fingerprint = hash({ evidence, actor: principal.userId });
    const existing = await tx.warehouseUnit.findUnique({ where: { id } });
    if (existing) {
      const origin = await getUnitOriginInTransaction(tx, id);
      if (origin?.creationFingerprint !== fingerprint) throw new WarehouseCommandError("This operation ID was already used for different identity evidence or another warehouse.", 409);
      return { unitId: id, createdAt: existing.createdAt.toISOString(), replayed: true };
    }
    const unit = await tx.warehouseUnit.create({ data: { id, createdByUserId: principal.userId, creationEvidence: evidence, creationFingerprint: fingerprint } });
    return { unitId: unit.id, createdAt: unit.createdAt.toISOString(), replayed: false };
  });
}

export async function linkWarehouseIdentifier(principal: Principal, input: { unitId: string; kind: WarehouseIdentifierKind; value: string; namespace?: string; evidence: string }) {
  assertCapability(principal, "inventory.identify");
  input = commandInput(warehouseAliasInput, input);
  const unitId = text(input.unitId, "Physical unit ID", 200);
  const evidence = text(input.evidence, "Link evidence", 2000);
  const identifier = parseIdentifier(input);
  if (identifier.kind === "auto") throw new WarehouseCommandError("A link must have an explicit identifier type.");
  if (identifier.kind === "serial" && !identifier.namespace) throw new WarehouseCommandError("Serial links require a manufacturer/model namespace so serials are not assumed globally unique.");
  const namespace = identifier.namespace ?? ({ lpn: "wms", msn: "dmp", serial: "", submission: "mars" })[identifier.kind];
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "inventory.identify");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WAREHOUSE_IDENTITY_IMPORT_LOCK})`;
    if (!await tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new WarehouseCommandError("Physical unit not found.", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-alias:${identifier.kind}:${namespace}:${identifier.value}`}, 0))`;
    const existing = await tx.warehouseIdentifier.findFirst({ where: { unitId, kind: identifier.kind, namespace, value: identifier.value, revokedAt: null } });
    const alias = existing ?? await tx.warehouseIdentifier.create({ data: { unitId, kind: identifier.kind, namespace, value: identifier.value, rawValue: input.value, evidence, createdByUserId: principal.userId } });
    const resolved = await resolveInTransaction(tx, { ...identifier, namespace });
    return { identifierId: alias.id, unitId, kind: alias.kind, namespace: alias.namespace, value: alias.value, evidence: alias.evidence, linkedAt: alias.createdAt.toISOString(), alreadyLinked: Boolean(existing), resolution: resolved.resolution, candidateUnitIds: resolved.candidateUnitIds };
  });
}

export async function unlinkWarehouseIdentifier(principal: Principal, input: { identifierId: string; reason: string }) {
  assertCapability(principal, "inventory.identify");
  input = commandInput(warehouseUnlinkInput, input);
  const identifierId = text(input.identifierId, "Identifier link ID", 200);
  const reason = text(input.reason, "Correction reason", 2000);
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "inventory.identify");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WAREHOUSE_IDENTITY_IMPORT_LOCK})`;
    const link = await tx.warehouseIdentifier.findUnique({ where: { id: identifierId } });
    if (!link) throw new WarehouseCommandError("Identifier link not found.", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-alias:${link.kind}:${link.namespace}:${link.value}`}, 0))`;
    const current = await tx.warehouseIdentifier.findUniqueOrThrow({ where: { id: identifierId } });
    if (current.revokedAt) return { identifierId, revokedAt: current.revokedAt.toISOString(), alreadyRevoked: true };
    const updated = await tx.warehouseIdentifier.update({ where: { id: identifierId }, data: { revokedAt: new Date(), revokedByUserId: principal.userId, revocationReason: reason } });
    return { identifierId, revokedAt: updated.revokedAt!.toISOString(), alreadyRevoked: false };
  });
}

export async function correctWarehouseObservation(principal: Principal, input: { observationId: string; operationId: string; unitId: string | null; reason: string; expectedRevision: number }) {
  assertCapability(principal, "inventory.identify");
  input = commandInput(warehouseCorrectionInput, input);
  const observationId = text(input.observationId, "Observation ID", 200);
  const operationId = text(input.operationId, "Operation ID", 150);
  const unitId = input.unitId === null ? null : text(input.unitId, "Physical unit ID", 200);
  const reason = text(input.reason, "Correction evidence", 2000);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new WarehouseCommandError("Supply the observation's current correction revision.");
  const id = `observation-correction:${hash([principal.userId, observationId, operationId])}`;
  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, principal, "inventory.identify");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`observation-correction:${observationId}`}, 0))`;
    const existing = await tx.warehouseObservationCorrection.findUnique({ where: { id } });
    if (existing) {
      if (existing.unitId !== unitId || existing.reason !== reason || existing.revision !== input.expectedRevision + 1) throw new WarehouseCommandError("This correction operation ID was already used with different evidence.", 409);
      return { correctionId: existing.id, revision: existing.revision, unitId, replayed: true };
    }
    const observation = await tx.warehousePhysicalObservation.findUnique({ where: { id: observationId }, include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
    if (!observation) throw new WarehouseCommandError("Observation not found.", 404);
    if ((observation.corrections[0]?.revision ?? 0) !== input.expectedRevision) throw new WarehouseCommandError("The observation was corrected by another user. Reload before amending it.", 409);
    if (unitId && !await tx.warehouseUnit.findUnique({ where: { id: unitId }, select: { id: true } })) throw new WarehouseCommandError("Physical unit not found.", 404);
    const correction = await tx.warehouseObservationCorrection.create({ data: { id, observationId, unitId, reason, userId: principal.userId, revision: input.expectedRevision + 1 } });
    return { correctionId: correction.id, revision: correction.revision, unitId, replayed: false };
  });
}

export async function getWarehouseUnit(principal: Principal, input: { unitId: string }, transaction?: Prisma.TransactionClient) {
  assertCapability(principal, "inventory.read");
  input = commandInput(warehouseUnitInput, input);
  const unitId = text(input.unitId, "Physical unit ID", 200);
  const read = async (tx: Prisma.TransactionClient) => {
    await assertCurrentPrincipal(tx, principal, "inventory.read");
    const unit = await tx.warehouseUnit.findUnique({ where: { id: unitId }, include: { identifiers: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] }, inventoryRows: { include: { sourceRevisions: { orderBy: { revision: "desc" }, take: 20, include: { memberships: { include: { importBatch: true }, orderBy: [{ importBatch: { createdAt: "desc" } }, { id: "desc" }], take: 5 } } } } } } });
    if (!unit) throw new WarehouseCommandError("Physical unit not found.", 404);
    const origin = await getUnitOriginInTransaction(tx, unitId);
    const sharedIdentifiers = await tx.warehouseUnitAlias.findMany({ where: { unitId, id: { notIn: unit.identifiers.map(alias => alias.id) } }, select: { id: true, kind: true, namespace: true, value: true, revokedAt: true }, orderBy: { id: "asc" }, take: 100 });
    const rawObservations = await tx.warehousePhysicalObservation.findMany({ where: { OR: [{ unitId }, { corrections: { some: { unitId } } }] }, orderBy: [{ capturedAt: "desc" }, { id: "desc" }], take: 200, include: { corrections: { orderBy: { revision: "desc" } } } });
    const observations = rawObservations.map((item) => ({ ...observationReceipt(item), effectiveUnitId: item.corrections[0] ? item.corrections[0].unitId : item.unitId, associationCurrent: (item.corrections[0] ? item.corrections[0].unitId : item.unitId) === unitId, correctionRevision: item.corrections[0]?.revision ?? 0, corrections: item.corrections.map((correction) => ({ correctionId: correction.id, unitId: correction.unitId, reason: correction.reason, userId: correction.userId, revision: correction.revision, correctedAt: correction.createdAt.toISOString() })) }));
    const latestPhysical = await tx.$queryRaw<{ id: string; type: string; location: string | null; capturedAt: Date; receivedAt: Date }[]>`
      WITH effective AS (
        SELECT o.id,o.type,o.location,o."capturedAt",o."receivedAt" FROM "WarehousePhysicalObservation" o
        LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
        WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END=${unitId}
      ) SELECT * FROM effective WHERE "capturedAt"=(SELECT max("capturedAt") FROM effective) ORDER BY "receivedAt" DESC,id DESC`;
    const last = latestPhysical[0] ?? null;
    const conflicting = latestPhysical.some((item) => item.type !== last?.type || item.location !== last?.location);
    const oldestShown = rawObservations.at(-1);
    return {
      unitId, createdAt: unit.createdAt.toISOString(), identityEvidence: origin?.creationEvidence ?? null,
      sharedIdentifiers: sharedIdentifiers.map(alias => ({ identifierId: alias.id, kind: alias.kind, namespace: alias.namespace, value: alias.value, revokedAt: alias.revokedAt?.toISOString() ?? null })),
      identifiers: unit.identifiers.map((link) => ({ identifierId: link.id, kind: link.kind, namespace: link.namespace, value: link.value, evidence: link.evidence, createdByUserId: link.createdByUserId, linkedAt: link.createdAt.toISOString(), revokedAt: link.revokedAt?.toISOString() ?? null, revokedByUserId: link.revokedByUserId, revocationReason: link.revocationReason })),
      reportedRows: unit.inventoryRows.map((row) => ({ inventoryRecordId: row.id, lpn: row.lpn, reportedStatus: row.status, orderNumber: row.orderNumber, description: row.description, revision: row.revision, sourceData: row.sourceData, archivedAt: row.archivedAt?.toISOString() ?? null, sourceHistory: row.sourceRevisions.map((revision) => ({ sourceRevisionId: revision.id, revision: revision.revision, sourceData: revision.sourceData, recordedAt: revision.recordedAt.toISOString(), migrationSnapshot: revision.migrationSnapshot, reports: revision.memberships.map((membership) => ({ importId: membership.importId, scope: membership.importBatch.scope, coverage: membership.importBatch.coverage, importedAt: membership.importBatch.createdAt.toISOString(), sourceAsOf: membership.importBatch.sourceAsOf?.toISOString() ?? null })) })) })),
      observations,
      observationsMayBeTruncated: rawObservations.length === 200,
      observationHistoryCursor: rawObservations.length === 200 && oldestShown ? historyCursor(oldestShown.capturedAt, oldestShown.id) : null,
      sourceHistoryMayBeTruncated: unit.inventoryRows.some((row) => row.sourceRevisions.length === 20),
      physicalState: { basis: conflicting ? "conflicting_physical_observations" as const : last ? "physical_observation" as const : "no_physical_observation" as const, lastType: conflicting ? null : last?.type ?? null, location: conflicting ? null : last?.location ?? null, observedAt: last?.capturedAt.toISOString() ?? null, receivedAt: last?.receivedAt.toISOString() ?? null, conflictingObservationIds: conflicting ? latestPhysical.map((item) => item.id) : [], certainty: "as_observed_not_live_presence" as const },
    };
  };
  return transaction ? read(transaction) : prisma.$transaction(read, { isolationLevel: "RepeatableRead" });
}

function historyCursor(at: Date, recordId: string) { return Buffer.from(JSON.stringify({ at: at.toISOString(), id: recordId })).toString("base64url"); }
function parseHistoryInput(input: { unitId: string; cursor?: string; limit?: number }) {
  input = commandInput(warehouseHistoryInput, input);
  const unitId = text(input.unitId, "Physical unit ID", 200);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new WarehouseCommandError("History page size must be 1–200.");
  let cursor: { at: Date; id: string } | null = null;
  if (input.cursor) {
    try {
      if (input.cursor.length > 1000) throw new Error();
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (typeof decoded.at !== "string" || typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 200 || !Number.isFinite(Date.parse(decoded.at))) throw new Error();
      cursor = { at: new Date(decoded.at), id: decoded.id };
    } catch { throw new WarehouseCommandError("Invalid history page cursor."); }
  }
  return { unitId, limit, cursor };
}

export async function getWarehouseUnitObservations(principal: Principal, raw: { unitId: string; cursor?: string; limit?: number }, transaction?: Prisma.TransactionClient) {
  assertCapability(principal, "inventory.read");
  const input = parseHistoryInput(raw);
  const records = await (transaction ?? prisma).warehousePhysicalObservation.findMany({ where: { AND: [
    { OR: [{ unitId: input.unitId }, { corrections: { some: { unitId: input.unitId } } }] },
    ...(input.cursor ? [{ OR: [{ capturedAt: { lt: input.cursor.at } }, { capturedAt: input.cursor.at, id: { lt: input.cursor.id } }] }] : []),
  ] }, orderBy: [{ capturedAt: "desc" }, { id: "desc" }], take: input.limit + 1, include: { corrections: { orderBy: { revision: "desc" } } } });
  const shown = records.slice(0, input.limit);
  return { unitId: input.unitId, items: shown.map((item) => ({ ...observationReceipt(item), effectiveUnitId: item.corrections[0] ? item.corrections[0].unitId : item.unitId, associationCurrent: (item.corrections[0] ? item.corrections[0].unitId : item.unitId) === input.unitId, correctionRevision: item.corrections[0]?.revision ?? 0, corrections: item.corrections.map((correction) => ({ correctionId: correction.id, unitId: correction.unitId, reason: correction.reason, userId: correction.userId, revision: correction.revision, correctedAt: correction.createdAt.toISOString() })) })), hasMore: records.length > input.limit, nextCursor: records.length > input.limit ? historyCursor(shown[shown.length - 1].capturedAt, shown[shown.length - 1].id) : null };
}

export async function getWarehouseSourceRevisions(principal: Principal, raw: { unitId: string; cursor?: string; limit?: number }, transaction?: Prisma.TransactionClient) {
  assertCapability(principal, "inventory.read");
  const input = parseHistoryInput(raw);
  const records = await (transaction ?? prisma).inventorySourceRevision.findMany({ where: { inventoryItem: { unitId: input.unitId }, ...(input.cursor ? { OR: [{ recordedAt: { lt: input.cursor.at } }, { recordedAt: input.cursor.at, id: { lt: input.cursor.id } }] } : {}) }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: input.limit + 1, include: { memberships: { include: { importBatch: true }, orderBy: [{ importBatch: { createdAt: "desc" } }, { id: "desc" }] } } });
  const shown = records.slice(0, input.limit);
  return { unitId: input.unitId, items: shown.map((revision) => ({ inventoryRecordId: revision.inventoryItemId, lpn: revision.lpn, sourceRevisionId: revision.id, revision: revision.revision, sourceData: revision.sourceData, recordedAt: revision.recordedAt.toISOString(), migrationSnapshot: revision.migrationSnapshot, reports: revision.memberships.map((membership) => ({ importId: membership.importId, scope: membership.importBatch.scope, coverage: membership.importBatch.coverage, importedAt: membership.importBatch.createdAt.toISOString(), sourceAsOf: membership.importBatch.sourceAsOf?.toISOString() ?? null })) })), hasMore: records.length > input.limit, nextCursor: records.length > input.limit ? historyCursor(shown[shown.length - 1].recordedAt, shown[shown.length - 1].id) : null };
}

export async function exportWarehouseUnitHistory(principal: Principal, input: { unitId: string }) {
  assertCapability(principal, "inventory.read");
  return prisma.$transaction(async (tx) => {
  const unit = await getWarehouseUnit(principal, input, tx);
  const observations: Awaited<ReturnType<typeof getWarehouseUnitObservations>>["items"] = [];
  const sourceRevisions: Awaited<ReturnType<typeof getWarehouseSourceRevisions>>["items"] = [];
  let cursor: string | undefined;
  do { const page = await getWarehouseUnitObservations(principal, { unitId: unit.unitId, cursor, limit: 200 }, tx); observations.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  do { const page = await getWarehouseSourceRevisions(principal, { unitId: unit.unitId, cursor, limit: 200 }, tx); sourceRevisions.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  return { filename: `warehouse-unit-${unit.unitId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.json`, json: JSON.stringify({ exportedAt: new Date().toISOString(), unit, observations, sourceRevisions, limitation: "Each history record retains its own source/observation times. Export does not attest current physical presence." }, null, 2), observationCount: observations.length, sourceRevisionCount: sourceRevisions.length };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

export async function listUnresolvedWarehouseObservations(principal: Principal, limit = 50) {
  assertCapability(principal, "inventory.read");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WarehouseCommandError("Observation limit must be 1–100.");
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM "WarehousePhysicalObservation" o
    LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
    WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" IS NULL ELSE o.resolution <> 'resolved' END
    ORDER BY o."receivedAt" DESC,o.id DESC LIMIT ${limit}`;
  const records = await prisma.warehousePhysicalObservation.findMany({ where: { id: { in: ids.map((row) => row.id) } }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], include: { corrections: { orderBy: { revision: "desc" }, take: 1 } } });
  return records.map((row) => ({ ...observationReceipt(row), resolution: row.corrections[0] ? "unresolved" : row.resolution, correctionRevision: row.corrections[0]?.revision ?? 0 }));
}
