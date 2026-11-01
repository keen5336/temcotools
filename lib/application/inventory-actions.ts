import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { archiveAuditItems, auditItemWhere, escapeAuditCsv, exportPickWaveToAudit, getInventoryAudit, parseAuditFilters } from "@/lib/inventory-audit";

const filtersSchema = z.object({ archive: z.enum(["active", "archived", "all"]).optional(), verification: z.enum(["all", "scanned", "pending"]).optional(), search: z.string().max(200).optional(), page: z.coerce.number().int().min(1).max(1_000_000).optional(), view: z.enum(["inventory", "unmatched"]).optional() });
function filters(input: unknown) { const data = filtersSchema.parse(input); return parseAuditFilters(new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)]))); }
export async function getInventoryBoard(principal: Principal, input: unknown) { await prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, "inventory.read")); return getInventoryAudit(filters(input)); }
export async function setInventoryArchive(principal: Principal, input: unknown) { const data = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100), archived: z.boolean() }).parse(input); return archiveAuditItems(data.ids, data.archived, principal); }
export async function exportPickAudit(principal: Principal, input: unknown) { return exportPickWaveToAudit(z.object({ id: z.string().min(1).max(200) }).parse(input).id, principal); }
export const INVENTORY_CSV_HEADER = "\uFEFF" + ["LPN", "Report Status", "Vendor", "Order Number", "Received Date", "Description", "Deliver to", "Audit Status", "Last Scanned", "Last Pick Wave", "Report Changed", "First Seen", "Archived", "Report Row"].map(escapeAuditCsv).join(",") + "\r\n";
export async function exportInventoryPage(principal: Principal, input: unknown) {
  const data = filtersSchema.extend({ afterId: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(1000).default(1000) }).parse(input);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "inventory.read");
    const rows = await tx.inventoryAuditItem.findMany({ where: { ...auditItemWhere(filters(data)), ...(data.afterId ? { id: { gt: data.afterId } } : {}) }, orderBy: { id: "asc" }, take: data.limit + 1 });
    const shown = rows.slice(0, data.limit);
    const csv = shown.map(row => [row.lpn, row.status, row.vendor, row.orderNumber, row.receivedDate, row.description, row.customerName, row.verifiedAt ? "Scanned" : "Needs scan", row.lastScannedAt?.toISOString() ?? "", row.lastScanWaveName ?? "", row.sourceChangedAt.toISOString(), row.firstSeenAt.toISOString(), row.archivedAt?.toISOString() ?? "", JSON.stringify(row.sourceData)].map(escapeAuditCsv).join(",")).join("\r\n") + (shown.length ? "\r\n" : "");
    return { filename: "inventory-audit.csv", header: INVENTORY_CSV_HEADER, csv, rowCount: shown.length, hasMore: rows.length > data.limit, nextAfterId: rows.length > data.limit ? shown.at(-1)!.id : null, limitation: "Source-row export with independent audit fields; multiple pages can span concurrent imports." };
  });
}
export const inventoryActions = {
  "inventory.board": { capability: "inventory.read", description: "Read the retained audit board with archive/verification/search/page/view filters", run: getInventoryBoard },
  "inventory.archive": { capability: "inventory.write", description: "Archive/restore up to100 source rows without claiming physical departure", run: setInventoryArchive },
  "inventory.export": { capability: "inventory.read", description: "Export CSV pages with full source rows, afterId/limit and retained audit fields", run: exportInventoryPage },
  "picks.audit.export": { capability: "inventory.write", description: "Idempotently retain a Pick Wave's individual scan evidence in the existing audit", run: exportPickAudit },
} as const;
