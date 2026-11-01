import { getPrincipal } from "@/lib/auth";
import { listUnresolvedWarehouseObservations, recordWarehouseObservation, type ObservationInput } from "@/lib/warehouse/units";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in as the original captured event's operator." }, 401);
    const body = await warehouseBody(request);
    return warehouseReply({ ok: true, receipt: await recordWarehouseObservation(principal, body as unknown as ObservationInput) });
  } catch (error) { return warehouseFailure(error); }
}
export async function GET() {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to review unresolved observations." }, 401);
    return warehouseReply({ ok: true, observations: await listUnresolvedWarehouseObservations(principal) });
  } catch (error) { return warehouseFailure(error); }
}
