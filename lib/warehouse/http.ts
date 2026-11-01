import { NextResponse } from "next/server";
import { WarehouseCommandError } from "@/lib/warehouse/units";
import { InventoryAuditValidationError } from "@/lib/lpn-report";

export function warehouseReply(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
export function warehouseFailure(error: unknown) {
  if (error instanceof WarehouseCommandError || error instanceof InventoryAuditValidationError) return warehouseReply({ ok: false, error: error.message }, error instanceof WarehouseCommandError ? error.status : 400);
  if (error && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403)) return warehouseReply({ ok: false, error: error.status === 401 ? "Sign in again to perform this action." : "You do not have permission for this action." }, error.status);
  return warehouseReply({ ok: false, error: "Warehouse data is unavailable. No automatic external action was performed." }, 503);
}
export async function warehouseBody(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new WarehouseCommandError("Request is too large.", 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new WarehouseCommandError("Request is too large.", 413);
  let body;
  try { body = JSON.parse(raw); } catch { throw new WarehouseCommandError("Provide a valid JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WarehouseCommandError("Provide a JSON object.");
  return body;
}
