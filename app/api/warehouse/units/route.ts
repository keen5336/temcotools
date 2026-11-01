import { NextRequest } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { createWarehouseUnit, exportWarehouseUnitHistory, getWarehouseSourceRevisions, getWarehouseUnit, getWarehouseUnitObservations, resolveWarehouseIdentifier, type WarehouseIdentifierInput } from "@/lib/warehouse/units";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to view physical-unit history." }, 401);
    const params = request.nextUrl.searchParams;
    if (params.get("format") === "json") {
      const exported = await exportWarehouseUnitHistory(principal, { unitId: params.get("unitId") ?? "" });
      return new Response(exported.json, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${exported.filename}"` } });
    }
    if (params.has("history")) {
      const input = { unitId: params.get("unitId") ?? "", cursor: params.get("cursor") || undefined };
      if (params.get("history") === "observations") return warehouseReply({ ok: true, result: await getWarehouseUnitObservations(principal, input) });
      if (params.get("history") === "source") return warehouseReply({ ok: true, result: await getWarehouseSourceRevisions(principal, input) });
      return warehouseReply({ ok: false, error: "Choose observation or source history." }, 400);
    }
    const result = params.has("unitId") ? await getWarehouseUnit(principal, { unitId: params.get("unitId")! }) : await resolveWarehouseIdentifier(principal, { value: params.get("value") ?? "", kind: (params.get("kind") || "auto") as WarehouseIdentifierInput["kind"], namespace: params.get("namespace") || undefined });
    return warehouseReply({ ok: true, result });
  } catch (error) { return warehouseFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to create a physical-unit identity." }, 401);
    const body = await warehouseBody(request);
    return warehouseReply({ ok: true, result: await createWarehouseUnit(principal, body as unknown as Parameters<typeof createWarehouseUnit>[1]) });
  } catch (error) { return warehouseFailure(error); }
}
