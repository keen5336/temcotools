import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { exportPickWaveToAudit, InventoryAuditValidationError } from "@/lib/inventory-audit";

export const runtime = "nodejs";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId || !session.isActive) return NextResponse.json({ ok: false, error: "An active login is required." }, { status: 401 });
  try { return NextResponse.json({ ok: true, result: await exportPickWaveToAudit((await params).id) }); }
  catch (error) {
    if (error instanceof InventoryAuditValidationError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error("Pick Wave Inventory Audit export failed", error);
    return NextResponse.json({ ok: false, error: "Unable to export scans to Inventory Audit." }, { status: 500 });
  }
}
