import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPrincipal } from "@/lib/auth";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { fingerprint } from "@/lib/labels/model";

export const MAX_SAVED_SCANS = 20_000;
export const MAX_RETAINED_CSV_BYTES = 32 * 1024 * 1024;
export class RetainedListError extends Error { constructor(message: string, public status = 400) { super(message); } }
const idSchema = z.string().min(1).max(200);
export const scanListSaveInput = z.object({ localDraftId: z.string().trim().min(1).max(200).describe("Stable device draft ID scoped by the current person; changed content under the same ID conflicts."), name: z.string().trim().min(1).max(120), createdAt: z.string().datetime({ offset: true }), scans: z.array(z.object({ value: z.string().max(500).transform(normalizeScannedValue).refine(value => Boolean(value) && !value.includes("\0"), "Scanned values cannot be empty or contain NUL."), scannedAt: z.string().datetime({ offset: true }) })).min(1).max(MAX_SAVED_SCANS) });
const summarySelect = { id: true, name: true, createdAt: true, updatedAt: true, closedAt: true, archivedAt: true, createdByUser: { select: { displayName: true } }, _count: { select: { items: true } } } satisfies Prisma.ScanListSessionSelect;
const detailSelect = { id: true, name: true, createdAt: true, updatedAt: true, closedAt: true, archivedAt: true, createdByUser: { select: { displayName: true } }, items: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, scannedValue: true, createdAt: true } } } satisfies Prisma.ScanListSessionSelect;
export async function currentRetainedPrincipal(principal?: Principal) { const current = principal ?? await getCurrentPrincipal(); if (!current) throw new AuthorizationError("Sign in required."); return current; }
export function normalizeScannedValue(value: string) { return value.trim(); }
export function savedScanFingerprint(input: { name: string; createdAt: Date; scans: Array<{ scannedValue: string; createdAt: Date }> }) {
  const scans = input.scans.map(scan => ({ value: scan.scannedValue, at: scan.createdAt.toISOString() })).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  return fingerprint({ name: input.name, createdAt: input.createdAt.toISOString(), scans });
}
export async function listScanLists(principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal);
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, actor, "workflow.read"); return tx.scanListSession.findMany({ orderBy: [{ archivedAt: "asc" }, { updatedAt: "desc" }], select: summarySelect }); });
}
export async function getScanList(id: string, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), sessionId = idSchema.parse(id);
  return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, actor, "workflow.read"); return tx.scanListSession.findUnique({ where: { id: sessionId }, select: detailSelect }); });
}
export async function saveScanList(options: unknown, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal);
  const data = scanListSaveInput.parse(options);
  const createdAt = new Date(data.createdAt), scans = data.scans.map(scan => ({ scannedValue: scan.value, createdAt: new Date(scan.scannedAt), scannedByUserId: actor.userId }));
  const contentHash = savedScanFingerprint({ name: data.name, createdAt, scans });
  const scopedDraftId = "v2:" + createHash("sha256").update(JSON.stringify([actor.userId, data.localDraftId])).digest("hex");
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopedDraftId}, 814))`;
    const prior = await tx.identityAudit.findFirst({ where: { action: "scan_lists.created", actorUserId: current.userId, sourceHash: scopedDraftId }, orderBy: { createdAt: "asc" } });
    const scoped = await tx.scanListSession.findUnique({ where: { localDraftId: scopedDraftId }, include: { items: true } });
    const legacy = scoped ? null : await tx.scanListSession.findUnique({ where: { localDraftId: data.localDraftId }, include: { items: true } });
    const existing = scoped ?? (legacy?.createdByUserId === current.userId ? legacy : null);
    if (existing) {
      if (savedScanFingerprint({ name: existing.name, createdAt: existing.createdAt, scans: existing.items }) !== contentHash) throw new RetainedListError("This draft was already saved with different content. Start a new draft instead of overwriting its history.", 409);
      if (!prior) await tx.identityAudit.create({ data: { action: "scan_lists.created", actorUserId: current.userId, sessionId: current.sessionId, sourceHash: scopedDraftId, reason: JSON.stringify({ id: existing.id, contentHash, legacy: true, grantId: current.grantId ?? null }) } });
      return { id: existing.id, name: existing.name, createdAt: existing.createdAt };
    }
    if (prior) throw new RetainedListError("This saved draft was deleted. A retry will not recreate it; start a new draft if another list is intended.", 410);
    const saved = await tx.scanListSession.create({ data: { localDraftId: scopedDraftId, name: data.name, createdByUserId: current.userId, createdAt, closedAt: new Date(), items: { create: scans } }, select: { id: true, name: true, createdAt: true } });
    await tx.identityAudit.create({ data: { action: "scan_lists.created", actorUserId: current.userId, sessionId: current.sessionId, sourceHash: scopedDraftId, reason: JSON.stringify({ id: saved.id, contentHash, grantId: current.grantId ?? null }) } });
    return saved;
  }, { timeout: 30_000 });
}
export async function setScanListArchived(id: string, archived: boolean, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), sessionId = idSchema.parse(id);
  if (typeof archived !== "boolean") throw new RetainedListError("archived must be a boolean.");
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute");
    await tx.$queryRaw`SELECT id FROM "ScanListSession" WHERE id=${sessionId} FOR UPDATE`;
    const row = await tx.scanListSession.findUnique({ where: { id: sessionId } }); if (!row) throw new RetainedListError("Scan list not found.", 404);
    if (Boolean(row.archivedAt) === archived) return { id: row.id, archivedAt: row.archivedAt };
    const result = await tx.scanListSession.update({ where: { id: sessionId }, data: { archivedAt: archived ? new Date() : null }, select: { id: true, archivedAt: true } });
    await tx.identityAudit.create({ data: { action: archived ? "scan_lists.archived" : "scan_lists.restored", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: sessionId, grantId: current.grantId ?? null }) } }); return result;
  });
}
export async function deleteScanList(id: string, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), sessionId = idSchema.parse(id);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute"); await tx.$queryRaw`SELECT id FROM "ScanListSession" WHERE id=${sessionId} FOR UPDATE`;
    const row = await tx.scanListSession.findUnique({ where: { id: sessionId }, select: { id: true } }); if (!row) return { id: sessionId };
    await tx.scanListSession.delete({ where: { id: sessionId } });
    await tx.identityAudit.create({ data: { action: "scan_lists.deleted", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: sessionId, grantId: current.grantId ?? null }) } }); return row;
  });
}
export function escapeRetainedCsvCell(value: string) {
  const safe = /^[=+@\-\t\r]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function boundedRetainedCsv(rows: Iterable<string[]>) {
  let size = 0; const output: string[] = [];
  for (const row of rows) { const line = row.map(escapeRetainedCsvCell).join(",") + "\r\n"; size += Buffer.byteLength(line); if (size > MAX_RETAINED_CSV_BYTES) throw new RetainedListError("The CSV exceeds the 32 MiB export limit. Export smaller saved sessions.", 413); output.push(line); }
  return output.join("");
}
export function scanListToCsv(session: NonNullable<Awaited<ReturnType<typeof getScanList>>>) {
  function* rows() { yield ["List Name", "Scanned Value", "Scanned At"]; for (const item of [...session.items].reverse()) yield [session.name, item.scannedValue, item.createdAt.toISOString()]; }
  return boundedRetainedCsv(rows());
}
export async function exportScanListCsv(id: string, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), session = await getScanList(id, actor); if (!session) throw new RetainedListError("Scan list not found.", 404);
  const content = scanListToCsv(session), safeName = session.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "scan-list";
  await prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, actor, "workflow.read"); await tx.identityAudit.create({ data: { action: "scan_lists.exported", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: session.id, rows: session.items.length, grantId: current.grantId ?? null }) } }); });
  return { filename: safeName + ".csv", contentType: "text/csv; charset=utf-8", content };
}
