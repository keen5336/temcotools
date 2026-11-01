import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { InventoryAuditValidationError } from "@/lib/inventory-audit";

import { exportPickAudit } from "@/lib/application/inventory-actions";

export const runtime = "nodejs";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ok:false,error:"An active login is required."},{status:401});
  try { return NextResponse.json({ ok: true, result: await exportPickAudit(principal, {id:(await params).id}) }); }
  catch (error) {
    if (error instanceof InventoryAuditValidationError) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    console.error("Pick Wave Inventory Audit export failed", error);
    return NextResponse.json({ ok: false, error: "Unable to export scans to Inventory Audit." }, { status: 500 });
  }
}
