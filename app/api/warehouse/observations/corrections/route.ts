import { getPrincipal } from "@/lib/auth";
import { correctWarehouseObservation } from "@/lib/warehouse/units";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to amend observation identity." }, 401);
    const body = await warehouseBody(request);
    return warehouseReply({ ok: true, result: await correctWarehouseObservation(principal, body as unknown as Parameters<typeof correctWarehouseObservation>[1]) });
  } catch (error) { return warehouseFailure(error); }
}
