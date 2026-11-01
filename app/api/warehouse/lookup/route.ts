import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { lookupWarehouseInventory, WarehouseLookupError } from "@/lib/warehouse-lookup";

export const runtime = "nodejs";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) return reply({ ok: false, error: "Sign in to look up warehouse inventory." }, 401);
    const params = request.nextUrl.searchParams;
    const result = await lookupWarehouseInventory(principal, {
      kind: params.get("kind") ?? "lpn",
      value: params.get("value"),
      ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
    });
    return reply({ ok: true, result });
  } catch (error) {
    if (error instanceof WarehouseLookupError) return reply({ ok: false, error: error.message }, 400);
    if (error && typeof error === "object" && "status" in error && error.status === 403) return reply({ ok: false, error: "You do not have permission to view warehouse inventory." }, 403);
    return reply({ ok: false, error: "Inventory lookup is unavailable. Try again when your connection is restored." }, 503);
  }
}
