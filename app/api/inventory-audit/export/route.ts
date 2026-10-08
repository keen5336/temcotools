import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { auditItemWhere, escapeAuditCsv, parseAuditFilters } from "@/lib/inventory-audit";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const session = await getSession();
  if (!session.userId || !session.isActive) return NextResponse.json({ ok: false, error: "An active login is required." }, { status: 401 });
  const filters = parseAuditFilters(new URL(req.url).searchParams);
  const where = auditItemWhere(filters);
  async function* csv() {
    yield "\uFEFF" + ["LPN", "Report Status", "Vendor", "Order Number", "Received Date", "Description", "Deliver to", "Audit Status", "Last Scanned", "Last Pick Wave", "Report Changed", "First Seen", "Archived", "Report Row"].map(escapeAuditCsv).join(",") + "\r\n";
    let cursor: string | undefined;
    while (true) {
      const rows = await prisma.inventoryAuditItem.findMany({ where, orderBy: { id: "asc" }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) return;
      yield rows.map((row) => [row.lpn, row.status, row.vendor, row.orderNumber, row.receivedDate, row.description, row.customerName,
        row.verifiedAt ? "Scanned" : "Needs scan", row.lastScannedAt?.toISOString() ?? "", row.lastScanWaveName ?? "",
        row.sourceChangedAt.toISOString(), row.firstSeenAt.toISOString(), row.archivedAt?.toISOString() ?? "", JSON.stringify(row.sourceData),
      ].map(escapeAuditCsv).join(",")).join("\r\n") + "\r\n";
      cursor = rows[rows.length - 1].id;
    }
  }
  const iterator = csv();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="inventory-audit.csv"', "Cache-Control": "no-store" } });
}
