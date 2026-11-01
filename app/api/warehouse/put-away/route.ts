import { NextRequest } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { exportWarehousePutAway, getWarehousePutAway } from "@/lib/warehouse/reports";
import { warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to view put-away work." }, 401);
    const params = request.nextUrl.searchParams;
    const input = { date: params.get("date") ?? "", scope: params.get("scope") || undefined, importId: params.get("importId") || undefined };
    if (params.get("format") === "lpns") {
      const result = await exportWarehousePutAway(principal, input);
      return new Response(result.lpns.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (params.get("format") === "csv") {
      const result = await exportWarehousePutAway(principal, input);
      return new Response(result.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${result.filename}"` } });
    }
    return warehouseReply({ ok: true, result: await getWarehousePutAway(principal, { ...input, afterLpn: params.get("afterLpn") || undefined }) });
  } catch (error) { return warehouseFailure(error); }
}
