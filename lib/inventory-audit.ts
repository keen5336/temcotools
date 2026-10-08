import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { InventoryAuditValidationError, normalizeLpn, prepareLpnReport, type LpnSourceRow } from "@/lib/lpn-report";

export { InventoryAuditValidationError };
const WRITE_LOCK = 8100801;
const CHUNK_SIZE = 1000;
export const AUDIT_PAGE_SIZE = 100;
export type AuditFilters = { archive: "active" | "archived" | "all"; verification: "all" | "scanned" | "pending"; search: string; page: number; view: "inventory" | "unmatched" };

export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const archive = params.get("archive");
  const verification = params.get("verification");
  const page = Number(params.get("page") ?? 1);
  return {
    archive: archive === "archived" || archive === "all" ? archive : "active",
    verification: verification === "scanned" || verification === "pending" ? verification : "all",
    search: (params.get("search") ?? "").trim().slice(0, 200),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1,
    view: params.get("view") === "unmatched" ? "unmatched" : "inventory",
  };
}
export function auditItemWhere(filters: AuditFilters): Prisma.InventoryAuditItemWhereInput {
  return {
    ...(filters.archive === "all" ? {} : { archivedAt: filters.archive === "archived" ? { not: null } : null }),
    ...(filters.verification === "all" ? {} : { verifiedAt: filters.verification === "scanned" ? { not: null } : null }),
    ...(filters.search ? { OR: ["lpn", "status", "orderNumber", "vendor", "description", "customerName"].map((field) => ({ [field]: { contains: filters.search, mode: "insensitive" } })) } : {}),
  };
}

export async function importInventoryReport(options: { rows: LpnSourceRow[]; filename: string; uploadedByName: string }) {
  const parsed = prepareLpnReport(options.rows);
  const records = parsed.items.map((item) => ({ ...item, id: randomUUID(), contentHash: createHash("sha256").update(JSON.stringify(item.sourceData)).digest("hex") }));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK})`;
    let insertedCount = 0, changedCount = 0, unchangedCount = 0;
    const changedAt = new Date();
    for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
      const chunk = records.slice(offset, offset + CHUNK_SIZE);
      const existing = await tx.inventoryAuditItem.findMany({ where: { lpn: { in: chunk.map((item) => item.lpn) } }, select: { lpn: true, contentHash: true } });
      const hashes = new Map(existing.map((item) => [item.lpn, item.contentHash]));
      for (const item of chunk) {
        if (!hashes.has(item.lpn)) insertedCount++;
        else if (hashes.get(item.lpn) !== item.contentHash) changedCount++;
        else unchangedCount++;
      }
      // A conditional bulk upsert leaves every column of unchanged rows untouched.
      await tx.$executeRaw`
        INSERT INTO "InventoryAuditItem" (
          "id", "lpn", "status", "orderNumber", "vendor", "receivedDate", "description", "customerName", "sourceData", "contentHash",
          "firstSeenAt", "sourceChangedAt", "lastScannedAt", "lastScanWaveName", "verifiedAt"
        )
        SELECT r.id, r.lpn, r.status, r."orderNumber", r.vendor, r."receivedDate", r.description, r."customerName", r."sourceData", r."contentHash",
          ${changedAt}, ${changedAt}, s."scannedAt", s."pickWaveName", s."scannedAt"
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS r(
          id text, lpn text, status text, "orderNumber" text, vendor text, "receivedDate" text, description text, "customerName" text, "sourceData" jsonb, "contentHash" text
        )
        LEFT JOIN LATERAL (
          SELECT "scannedAt", "pickWaveName" FROM "InventoryAuditScan" WHERE lpn = r.lpn ORDER BY "scannedAt" DESC, id DESC LIMIT 1
        ) s ON true
        ON CONFLICT (lpn) DO UPDATE SET
          status = EXCLUDED.status, "orderNumber" = EXCLUDED."orderNumber", vendor = EXCLUDED.vendor,
          "receivedDate" = EXCLUDED."receivedDate", description = EXCLUDED.description, "customerName" = EXCLUDED."customerName",
          "sourceData" = EXCLUDED."sourceData", "contentHash" = EXCLUDED."contentHash", "sourceChangedAt" = EXCLUDED."sourceChangedAt",
          revision = "InventoryAuditItem".revision + 1, "archivedAt" = NULL, "verifiedAt" = NULL
        WHERE "InventoryAuditItem"."contentHash" <> EXCLUDED."contentHash"
      `;
    }
    return tx.inventoryAuditImport.create({ data: {
      filename: options.filename.slice(0, 255), uploadedByName: options.uploadedByName,
      rowCount: records.length, insertedCount, changedCount, unchangedCount,
      duplicateCount: parsed.duplicateCount, blankCount: parsed.blankCount,
    } });
  }, { timeout: 120_000, maxWait: 120_000 });
}

export async function exportPickWaveToAudit(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK})`;
    const wave = await tx.pickWave.findUnique({ where: { id }, select: {
      name: true, scans: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
        id: true, scannedValue: true, createdAt: true, matched: true, alreadyScanned: true,
        item: { select: { lpn: true } }, scannedByUser: { select: { displayName: true } },
      } },
    } });
    if (!wave) throw new InventoryAuditValidationError("Pick wave not found.");
    if (!wave.scans.length) throw new InventoryAuditValidationError("This pick wave has no scans to export.");
    let newScanCount = 0;
    for (let offset = 0; offset < wave.scans.length; offset += CHUNK_SIZE) {
      const chunk = wave.scans.slice(offset, offset + CHUNK_SIZE);
      const existing = await tx.inventoryAuditScan.findMany({ where: { sourceScanId: { in: chunk.map((scan) => scan.id) } }, select: { sourceScanId: true } });
      const saved = new Set(existing.map((scan) => scan.sourceScanId));
      const fresh = chunk.filter((scan) => !saved.has(scan.id)).map((scan) => ({
        id: randomUUID(), sourceScanId: scan.id, pickWaveId: id, pickWaveName: wave.name,
        scannedValue: scan.scannedValue,
        // Matched serial/order/part scans use only the LPN of the item that was actually picked.
        // Unmatched values can confirm an exact LPN; a matched item without an LPN stays unresolved.
        lpn: scan.item?.lpn ? normalizeLpn(scan.item.lpn) : !scan.matched ? normalizeLpn(scan.scannedValue) : null,
        scannedByName: scan.scannedByUser?.displayName ?? null, matchedPickWave: scan.matched,
        duplicateInWave: scan.alreadyScanned, scannedAt: scan.createdAt,
      }));
      if (!fresh.length) continue;
      newScanCount += fresh.length;
      await tx.inventoryAuditScan.createMany({ data: fresh });
      await tx.$executeRaw`
        WITH latest AS (
          SELECT DISTINCT ON (lpn) lpn, "scannedAt"::timestamp AS "scannedAt", "pickWaveName"
          FROM jsonb_to_recordset(${JSON.stringify(fresh)}::jsonb) AS r(lpn text, "scannedAt" text, "pickWaveName" text)
          WHERE lpn IS NOT NULL ORDER BY lpn, "scannedAt" DESC
        )
        UPDATE "InventoryAuditItem" i SET
          "lastScannedAt" = GREATEST(i."lastScannedAt", s."scannedAt"),
          "lastScanWaveName" = CASE WHEN i."lastScannedAt" IS NULL OR s."scannedAt" >= i."lastScannedAt" THEN s."pickWaveName" ELSE i."lastScanWaveName" END,
          "verifiedAt" = CASE WHEN i.revision = 1 OR s."scannedAt" >= i."sourceChangedAt" THEN GREATEST(i."verifiedAt", s."scannedAt") ELSE i."verifiedAt" END
        FROM latest s WHERE i.lpn = s.lpn
      `;
    }
    const [summary] = await tx.$queryRaw<{ matchedLpnCount: number; unmatchedScanCount: number }[]>`
      SELECT COUNT(DISTINCT i.lpn)::integer AS "matchedLpnCount",
        COUNT(*) FILTER (WHERE i.id IS NULL)::integer AS "unmatchedScanCount"
      FROM "InventoryAuditScan" s LEFT JOIN "InventoryAuditItem" i ON i.lpn = s.lpn WHERE s."pickWaveId" = ${id}
    `;
    return { totalScanCount: wave.scans.length, newScanCount, ...summary };
  }, { timeout: 120_000, maxWait: 120_000 });
}

export async function archiveAuditItems(ids: string[], archived: boolean) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WRITE_LOCK})`;
    return tx.inventoryAuditItem.updateMany({ where: { id: { in: ids } }, data: { archivedAt: archived ? new Date() : null } });
  }, { timeout: 30_000, maxWait: 120_000 });
}

export async function getInventoryAudit(filters: AuditFilters) {
  const where = auditItemWhere(filters);
  // Literal substring search, including percent/underscore, agrees with the inventory search.
  const needle = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
  const unmatchedSearch = Prisma.sql`(s."scannedValue" ILIKE ${needle} OR s."pickWaveName" ILIKE ${needle} OR s.lpn ILIKE ${needle})`;
  const [active, archived, pending, filteredCount, unknownCount, latestImport] = await Promise.all([
    prisma.inventoryAuditItem.count({ where: { archivedAt: null } }),
    prisma.inventoryAuditItem.count({ where: { archivedAt: { not: null } } }),
    prisma.inventoryAuditItem.count({ where: { archivedAt: null, verifiedAt: null } }),
    prisma.inventoryAuditItem.count({ where }),
    prisma.$queryRaw<{ count: number }[]>`SELECT COUNT(*)::integer AS count FROM "InventoryAuditScan" s LEFT JOIN "InventoryAuditItem" i ON i.lpn = s.lpn WHERE i.id IS NULL AND ${unmatchedSearch}`,
    prisma.inventoryAuditImport.findFirst({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
  ]);
  const total = filters.view === "unmatched" ? unknownCount[0].count : filteredCount;
  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const offset = (page - 1) * AUDIT_PAGE_SIZE;
  const items = filters.view === "inventory" ? await prisma.inventoryAuditItem.findMany({ where, orderBy: [{ sourceChangedAt: "desc" }, { lpn: "asc" }], skip: offset, take: AUDIT_PAGE_SIZE }) : [];
  const scans = filters.view === "unmatched" ? await prisma.$queryRaw<{
    id: string; lpn: string | null; scannedValue: string; pickWaveName: string; scannedByName: string | null; scannedAt: Date; duplicateInWave: boolean;
  }[]>`SELECT s.id, s.lpn, s."scannedValue", s."pickWaveName", s."scannedByName", s."scannedAt", s."duplicateInWave"
    FROM "InventoryAuditScan" s LEFT JOIN "InventoryAuditItem" i ON i.lpn = s.lpn
    WHERE i.id IS NULL AND ${unmatchedSearch} ORDER BY s."scannedAt" DESC, s.id DESC LIMIT ${AUDIT_PAGE_SIZE} OFFSET ${offset}` : [];
  return { items, scans, total, page, pageCount, summary: { active, archived, pending, scanned: active - pending }, latestImport };
}

export function escapeAuditCsv(value: string) {
  // Prevent spreadsheet formula evaluation when users open warehouse data in Excel.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
