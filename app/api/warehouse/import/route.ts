import { getPrincipal } from "@/lib/auth";
import { importSharedWarehouseReport } from "@/lib/warehouse/reports";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to import warehouse source data." }, 401);
    return warehouseReply({ ok: true, batch: await importSharedWarehouseReport(principal, await warehouseBody(request, 50 * 1024 * 1024)) });
  } catch (error) { return warehouseFailure(error); }
}
