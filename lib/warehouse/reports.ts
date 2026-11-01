import { randomUUID } from "node:crypto";
import { advanceOfficeRefresh } from "@/lib/office/refresh";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { importInventoryReport } from "@/lib/inventory-audit";
import { WarehouseCommandError } from "@/lib/warehouse/units";

export const warehouseReportInput = z.object({
  filename: z.string().trim().min(1).max(255),
  rows: z.array(z.record(z.string().max(200), z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(100_000),
  scope: z.string().trim().min(1).max(100).default("warehouse"),
  coverage: z.enum(["partial", "complete"]).default("partial"),
  sourceAsOf: z.string().max(100).nullable().optional(),
});
export const warehousePutAwayInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), scope: z.string().trim().max(100).optional(), importId: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).optional(), afterLpn: z.string().max(500).optional() });
export const warehouseMembershipInput = z.object({ lpn: z.string().trim().min(1).max(500), scope: z.string().trim().max(100).optional() });

export async function importSharedWarehouseReport(principal: Principal, raw: unknown) {
  assertCapability(principal, "inventory.write");
  const parsed = warehouseReportInput.safeParse(raw);
  if (!parsed.success) throw new WarehouseCommandError("Provide a filename, valid WMS rows, scope and partial/complete coverage.");
  // The import implementation rechecks this version inside its own writer transaction.
  const batch = await importInventoryReport({ ...parsed.data, uploadedByName: principal.displayName, uploadedByUserId: principal.userId, actorPrincipal: principal });
  // A separately committed import remains accepted if the bounded follow-up is
  // interrupted. Its retained checkpoint can be resumed from Home, Office or MCP.
  try {
    const refresh = await advanceOfficeRefresh(principal, { operationId: randomUUID(), cause: "wms_import", limit: 50, expectedActorUserId: principal.userId });
    return { ...batch, officeRefresh: refresh.status, officeRefreshError: null };
  } catch {
    return { ...batch, officeRefresh: null, officeRefreshError: "The WMS report was accepted. Office issue evaluation is pending; open Home or Office to inspect and resume coverage." };
  }
}

function putAwayInput(raw: { date: string; scope?: string; importId?: string; limit?: number; afterLpn?: string }) {
  const validated = warehousePutAwayInput.safeParse(raw);
  if (!validated.success) throw new WarehouseCommandError("Provide a valid received date, source scope and bounded page input.");
  raw = validated.data;
  const parsedDate = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? new Date(`${raw.date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== raw.date) throw new WarehouseCommandError("Choose a valid received calendar date.");
  const scope = raw.scope?.trim() || "warehouse";
  if (scope.length > 100) throw new WarehouseCommandError("Scope is too long.");
  const limit = raw.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new WarehouseCommandError("Page size must be 1–1000.");
  if (raw.afterLpn && raw.afterLpn.length > 500) throw new WarehouseCommandError("Invalid page cursor.");
  if (raw.importId && raw.importId.length > 200) throw new WarehouseCommandError("Invalid import reference.");
  return { ...raw, scope, limit };
}

export async function getWarehousePutAway(principal: Principal, raw: { date: string; scope?: string; importId?: string; limit?: number; afterLpn?: string }) {
  assertCapability(principal, "inventory.read");
  const input = putAwayInput(raw);
  return prisma.$transaction(async (tx) => {
    const batch = input.importId
      ? await tx.inventoryAuditImport.findFirst({ where: { id: input.importId, scope: input.scope } })
      : await tx.inventoryAuditImport.findFirst({ where: { scope: input.scope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (input.importId && !batch) throw new WarehouseCommandError("Report not found in this source scope.", 404);
    const hasMembership = batch ? await tx.inventoryImportMembership.count({ where: { importId: batch.id } }) > 0 : false;
    const cursor = input.afterLpn ?? "";
    const rows = hasMembership ? await tx.$queryRaw<{ lpn: string; vendor: string; customerName: string; orderNumber: string; description: string; revision: number }[]>`
      SELECT r.lpn,r.vendor,r."customerName",r."orderNumber",r.description,r.revision
      FROM "InventoryImportMembership" m JOIN "InventorySourceRevision" r ON r.id=m."sourceRevisionId"
      WHERE m."importId"=${batch!.id} AND lower(r.status)='placing' AND r."receivedDate"=${input.date} AND r.lpn > ${cursor}
      ORDER BY r.lpn LIMIT ${input.limit + 1}`
      : await tx.$queryRaw<{ lpn: string; vendor: string; customerName: string; orderNumber: string; description: string; revision: number }[]>`
        SELECT lpn,vendor,"customerName","orderNumber",description,revision FROM "InventoryAuditItem"
        WHERE lower(status)='placing' AND "receivedDate"=${input.date} AND lpn > ${cursor} ORDER BY lpn LIMIT ${input.limit + 1}`;
    return { date: input.date, scope: input.scope, source: "shared_wms_report" as const,
      batch: batch ? { importId: batch.id, filename: batch.filename, importedAt: batch.createdAt.toISOString(), sourceAsOf: batch.sourceAsOf?.toISOString() ?? null, coverage: batch.coverage } : null,
      membership: hasMembership ? "selected_report" as const : "legacy_membership_unknown" as const,
      limitation: hasMembership ? batch!.coverage === "complete" ? "Complete coverage is reported for the selected source scope; it is not physical presence confirmation." : "This view contains the selected partial report's rows only. Items outside it are not declared absent." : "Retained legacy rows are shown; their membership in an old import was not recorded.",
      items: rows.slice(0, input.limit), hasMore: rows.length > input.limit, nextAfterLpn: rows.length > input.limit ? rows[input.limit - 1].lpn : null,
    };
  }, { isolationLevel: "RepeatableRead" });
}

function csv(value: string) { return `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`; }

export async function exportWarehousePutAway(principal: Principal, raw: { date: string; scope?: string; importId?: string }) {
  assertCapability(principal, "inventory.read");
  const input = putAwayInput(raw);
  let page = await getWarehousePutAway(principal, { ...input, limit: 1000 });
  const lines = [["LPN", "Vendor", "Customer Name", "Order Number", "Description"].map(csv).join(",")];
  const lpns: string[] = [];
  let count = 0;
  while (true) {
    for (const row of page.items) { lines.push([row.lpn, row.vendor, row.customerName, row.orderNumber, row.description].map(csv).join(",")); lpns.push(row.lpn); count++; }
    if (!page.nextAfterLpn) break;
    page = await getWarehousePutAway(principal, { ...input, importId: page.batch?.importId, afterLpn: page.nextAfterLpn, limit: 1000 });
  }
  return { filename: `lpn-put-away-${input.date}.csv`, csv: lines.join("\r\n") + "\r\n", lpns, count, sourceImportId: page.batch?.importId ?? null };
}

export async function getWarehouseImportMembership(principal: Principal, input: { lpn: string; scope?: string }) {
  assertCapability(principal, "inventory.read");
  const validated = warehouseMembershipInput.safeParse(input);
  if (!validated.success) throw new WarehouseCommandError("Provide an LPN and valid source scope.");
  input = validated.data;
  const lpn = input.lpn.trim().toUpperCase();
  const scope = input.scope?.trim() || "warehouse";
  const batch = await prisma.inventoryAuditImport.findFirst({ where: { scope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!batch) return { membership: "unknown" as const, sourceAsOf: null, importId: null };
  const membership = await prisma.inventoryImportMembership.findUnique({ where: { importId_lpn: { importId: batch.id, lpn } } });
  const hasRecordedMembership = membership || await prisma.inventoryImportMembership.count({ where: { importId: batch.id } }) > 0;
  return { membership: membership ? "included" as const : hasRecordedMembership && batch.coverage === "complete" ? "not_in_complete_report" as const : "unknown" as const, sourceAsOf: batch.sourceAsOf?.toISOString() ?? null, importId: batch.id, scope, coverage: batch.coverage, importedAt: batch.createdAt.toISOString() };
}
