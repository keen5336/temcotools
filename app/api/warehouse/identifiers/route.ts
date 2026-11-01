import { getPrincipal } from "@/lib/auth";
import { linkWarehouseIdentifier, unlinkWarehouseIdentifier } from "@/lib/warehouse/units";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to manage unit identifiers." }, 401);
    const body = await warehouseBody(request);
    return warehouseReply({ ok: true, result: await linkWarehouseIdentifier(principal, body as unknown as Parameters<typeof linkWarehouseIdentifier>[1]) });
  } catch (error) { return warehouseFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to correct a unit identifier." }, 401);
    const body = await warehouseBody(request);
    return warehouseReply({ ok: true, result: await unlinkWarehouseIdentifier(principal, body as unknown as Parameters<typeof unlinkWarehouseIdentifier>[1]) });
  } catch (error) { return warehouseFailure(error); }
}
