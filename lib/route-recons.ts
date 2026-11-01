import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { parsePickWaveWorkbook, type PickWaveWorkbookBuffer } from "@/lib/pick-waves";
import { MAX_RETAINED_WORKBOOK_ROWS } from "@/lib/retained-workbook";
import { boundedRetainedCsv, currentRetainedPrincipal, RetainedListError } from "@/lib/scan-lists";
import { fingerprint } from "@/lib/labels/model";

export class RouteReconValidationError extends RetainedListError {}
const idSchema = z.string().min(1).max(200);
const summarySelect = { id: true, name: true, sourceFilename: true, routeCount: true, createdAt: true, updatedAt: true, archivedAt: true, createdByUser: { select: { displayName: true } }, _count: { select: { items: true } } } satisfies Prisma.RouteReconSelect;
const detailSelect = { id: true, name: true, sourceFilename: true, routeCount: true, createdAt: true, updatedAt: true, archivedAt: true, createdByUser: { select: { displayName: true } }, items: { orderBy: { rowNumber: "asc" }, select: { id: true, rowNumber: true, routeNumber: true, contact: true, orderNumber: true, lpn: true, serialNumber: true, trackingNumber: true, partNumber: true, description: true } } } satisfies Prisma.RouteReconSelect;
async function parseBoundedRecon(fileBuffer: PickWaveWorkbookBuffer) {
  // The retained PickWave parser performs the common bounded ZIP/XML preflight.
  const parsed = await parsePickWaveWorkbook(fileBuffer);
  if (parsed.items.length > MAX_RETAINED_WORKBOOK_ROWS || parsed.items.some(item => Object.values(item).some(value => typeof value === "string" && value.length > 2000))) throw new RouteReconValidationError("Use at most 20,000 item rows and field values no longer than 2,000 characters.", 413);
  return parsed;
}
export async function previewRouteRecon(fileBuffer: PickWaveWorkbookBuffer, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal); await prisma.$transaction(tx => assertCurrentPrincipal(tx, actor, "workflow.read"));
  const parsed = await parseBoundedRecon(fileBuffer), routeCounts = countRoutes(parsed.items);
  return { itemCount: parsed.items.length, routes: [...routeCounts.values()].sort((a, b) => compareRoutes(a.routeNumber, b.routeNumber)), missingColumns: parsed.missingColumns };
}
export async function createRouteRecon(options: { name: string; filename: string; fileBuffer: PickWaveWorkbookBuffer; userId?: string; operationId?: string }, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal);
  const input = z.object({ name: z.string().trim().min(1).max(120), filename: z.string().trim().min(1).max(240).refine(value => !/[/\\\x00-\x1f\x7f]/.test(value), "Use a plain source filename."), operationId: z.string().min(1).max(200).optional() }).parse(options);
  await prisma.$transaction(tx => assertCurrentPrincipal(tx, actor, "workflow.execute"));
  const parsed = await parseBoundedRecon(options.fileBuffer), routeCount = countRoutes(parsed.items).size;
  const fileHash = createHash("sha256").update(Buffer.from(options.fileBuffer as unknown as Uint8Array)).digest("hex");
  const inputHash = fingerprint({ name: input.name, filename: input.filename, fileHash });
  const sourceHash = "recon:" + createHash("sha256").update(JSON.stringify([actor.userId, input.operationId ?? inputHash])).digest("hex");
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute"); await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sourceHash}, 814))`;
    const prior = await tx.identityAudit.findFirst({ where: { action: "route_recons.created", actorUserId: current.userId, sourceHash }, orderBy: { createdAt: "asc" } });
    if (prior) {
      let receipt: { id?: string; inputHash?: string }; try { receipt = JSON.parse(prior.reason ?? "{}"); } catch { throw new RouteReconValidationError("Original import receipt is unavailable. Inspect saved reports before another import.", 409); }
      if (receipt.inputHash !== inputHash || !receipt.id) throw new RouteReconValidationError("This import operation was already used for different input.", 409);
      const existing = await tx.routeRecon.findUnique({ where: { id: receipt.id }, select: { id: true, name: true, createdAt: true, routeCount: true, _count: { select: { items: true } } } });
      if (!existing) throw new RouteReconValidationError("This imported report was deleted. A retry will not recreate it; use a new operation for a deliberate new report.", 410);
      return existing;
    }
    const saved = await tx.routeRecon.create({ data: { name: input.name, sourceFilename: input.filename, routeCount, createdByUserId: current.userId, items: { create: parsed.items } }, select: { id: true, name: true, createdAt: true, routeCount: true, _count: { select: { items: true } } } });
    await tx.identityAudit.create({ data: { action: "route_recons.created", actorUserId: current.userId, sessionId: current.sessionId, sourceHash, reason: JSON.stringify({ id: saved.id, inputHash, grantId: current.grantId ?? null }) } }); return saved;
  }, { timeout: 30_000 });
}
export async function listRouteRecons(principal?: Principal) { const actor = await currentRetainedPrincipal(principal); return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, actor, "workflow.read"); return tx.routeRecon.findMany({ orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }], select: summarySelect }); }); }
export async function getRouteRecon(id: string, principal?: Principal) { const actor = await currentRetainedPrincipal(principal), reportId = idSchema.parse(id); return prisma.$transaction(async tx => { await assertCurrentPrincipal(tx, actor, "workflow.read"); return tx.routeRecon.findUnique({ where: { id: reportId }, select: detailSelect }); }); }
export async function setRouteReconArchived(id: string, archived: boolean, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), reportId = idSchema.parse(id); if (typeof archived !== "boolean") throw new RouteReconValidationError("archived must be a boolean.");
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute"); await tx.$queryRaw`SELECT id FROM "RouteRecon" WHERE id=${reportId} FOR UPDATE`;
    const row = await tx.routeRecon.findUnique({ where: { id: reportId } }); if (!row) throw new RouteReconValidationError("Route Recon not found.", 404);
    if (Boolean(row.archivedAt) === archived) return { id: row.id, archivedAt: row.archivedAt };
    const result = await tx.routeRecon.update({ where: { id: reportId }, data: { archivedAt: archived ? new Date() : null }, select: { id: true, archivedAt: true } });
    await tx.identityAudit.create({ data: { action: archived ? "route_recons.archived" : "route_recons.restored", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: reportId, grantId: current.grantId ?? null }) } }); return result;
  });
}
export async function deleteRouteRecon(id: string, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), reportId = idSchema.parse(id);
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, actor, "workflow.execute"); await tx.$queryRaw`SELECT id FROM "RouteRecon" WHERE id=${reportId} FOR UPDATE`;
    const row = await tx.routeRecon.findUnique({ where: { id: reportId }, select: { id: true } }); if (!row) return { id: reportId };
    await tx.routeRecon.delete({ where: { id: reportId } }); await tx.identityAudit.create({ data: { action: "route_recons.deleted", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: reportId, grantId: current.grantId ?? null }) } }); return row;
  });
}
export async function getRouteReconPrintableData(id: string, input: { routeNumber?: string | null } = {}, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), report = await getRouteRecon(id, actor); if (!report) throw new RouteReconValidationError("Route Recon not found.", 404);
  const route = z.object({ routeNumber: z.string().max(2000).nullable().optional() }).parse(input).routeNumber;
  const requested = route === undefined ? undefined : (route?.trim() || null)?.toLocaleLowerCase() ?? null;
  if (requested && requested.length > 2000) throw new RouteReconValidationError("Route selection is too long.");
  const items = requested === undefined ? report.items : report.items.filter(item => ((item.routeNumber?.trim() || null)?.toLocaleLowerCase() ?? null) === requested);
  const routes = [...countRoutes(items).values()].sort((a, b) => compareRoutes(a.routeNumber, b.routeNumber));
  return { ...report, items, routes, printableUrl: "/tools/route-recon/" + encodeURIComponent(report.id), physicalPrinting: "requires_connected_device_or_browser_confirmation" as const };
}
export async function exportRouteReconCsv(id: string, principal?: Principal) {
  const actor = await currentRetainedPrincipal(principal), report = await getRouteRecon(id, actor); if (!report) throw new RouteReconValidationError("Route Recon not found.", 404);
  function* rows() { yield ["Route", "Contact", "Order", "LPN", "Serial", "Tracking", "Part", "Description"]; for (const item of report!.items) yield [item.routeNumber ?? "", item.contact ?? "", item.orderNumber ?? "", item.lpn ?? "", item.serialNumber ?? "", item.trackingNumber ?? "", item.partNumber ?? "", item.description ?? ""]; }
  const content = boundedRetainedCsv(rows()), safeName = report.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "route-recon";
  await prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, actor, "workflow.read"); await tx.identityAudit.create({ data: { action: "route_recons.exported", actorUserId: current.userId, sessionId: current.sessionId, reason: JSON.stringify({ id: report.id, rows: report.items.length, grantId: current.grantId ?? null }) } }); });
  return { filename: safeName + ".csv", contentType: "text/csv; charset=utf-8", content };
}
function countRoutes(items: Array<{ routeNumber: string | null }>) {
  const routeCounts = new Map<string, { routeNumber: string | null; itemCount: number }>();
  for (const item of items) { const routeNumber = item.routeNumber?.trim() || null, key = routeNumber?.toLocaleLowerCase() ?? "__no_route__", current = routeCounts.get(key); routeCounts.set(key, { routeNumber: current?.routeNumber ?? routeNumber, itemCount: (current?.itemCount ?? 0) + 1 }); }
  return routeCounts;
}
function compareRoutes(a: string | null, b: string | null) { if (a === null) return 1; if (b === null) return -1; return a.localeCompare(b, undefined, { numeric: true }); }
