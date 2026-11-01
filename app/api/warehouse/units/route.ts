import { NextRequest } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { createWarehouseUnit, getWarehouseUnit, resolveWarehouseIdentifier, type WarehouseIdentifierInput } from "@/lib/warehouse/units";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) return warehouseReply({ ok: false, error: "Sign in to view physical-unit history." }, 401);
    const params = request.nextUrl.searchParams;
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
