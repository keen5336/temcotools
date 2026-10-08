import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { importInventoryReport, InventoryAuditValidationError } from "@/lib/inventory-audit";

export const runtime = "nodejs";
const MAX_BYTES = 50 * 1024 * 1024;
const input = z.object({
  filename: z.string().min(1).max(255),
  rows: z.array(z.record(z.string().max(200), z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(100_000),
});
export async function POST(req: Request) {
  const session = await getSession();
  if (!session.userId || !session.isActive) return NextResponse.json({ ok: false, error: "An active login is required." }, { status: 401 });
  try {
    if (Number(req.headers.get("content-length")) > MAX_BYTES) return NextResponse.json({ ok: false, error: "Report data must be smaller than 50 MB." }, { status: 413 });
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BYTES) return NextResponse.json({ ok: false, error: "Report data must be smaller than 50 MB." }, { status: 413 });
    const body = input.safeParse(JSON.parse(text));
    if (!body.success) throw new InventoryAuditValidationError("The report must contain 1–100,000 rows with valid spreadsheet values (up to 10,000 characters per cell).");
    const batch = await importInventoryReport({ ...body.data, uploadedByName: session.displayName ?? "Unknown" });
    return NextResponse.json({ ok: true, batch });
  } catch (error) {
    if (error instanceof InventoryAuditValidationError || error instanceof SyntaxError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error("Inventory Audit import failed", error);
    return NextResponse.json({ ok: false, error: "Unable to import the report. No partial changes were saved." }, { status: 500 });
  }
}
