import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { archiveAuditItems, getInventoryAudit, InventoryAuditValidationError, parseAuditFilters } from "@/lib/inventory-audit";
import { z } from "zod";

export const runtime = "nodejs";
export async function GET(req: Request) {
  const session = await getSession();
  if (!session.userId || !session.isActive) return NextResponse.json({ ok: false, error: "An active login is required." }, { status: 401 });
  try { return NextResponse.json({ ok: true, board: await getInventoryAudit(parseAuditFilters(new URL(req.url).searchParams)) }); }
  catch (error) { console.error("Inventory Audit read failed", error); return NextResponse.json({ ok: false, error: "Unable to load Inventory Audit." }, { status: 500 }); }
}
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session.userId || !session.isActive) return NextResponse.json({ ok: false, error: "An active login is required." }, { status: 401 });
  try {
    const body = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100), archived: z.boolean() }).safeParse(await req.json());
    if (!body.success) throw new InventoryAuditValidationError("Select up to 100 inventory rows and choose archive or restore.");
    return NextResponse.json({ ok: true, ...await archiveAuditItems(body.data.ids, body.data.archived) });
  } catch (error) {
    if (error instanceof InventoryAuditValidationError || error instanceof SyntaxError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error("Inventory Audit archive failed", error);
    return NextResponse.json({ ok: false, error: "Unable to update the selected rows." }, { status: 500 });
  }
}
