import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { getPrincipal } from "@/lib/auth";
import { listWarehouseUnitNotes, getWarehouseUnitNote, appendWarehouseUnitNote, correctWarehouseUnitNote } from "@/lib/warehouse/notes";
import { warehouseBody, warehouseFailure, warehouseReply } from "@/lib/warehouse/http";

export const runtime = "nodejs";
function failure(error: unknown) {
  if (error instanceof ZodError) return warehouseReply({ ok: false, error: error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, 400);
  if (error instanceof Error && "status" in error && typeof error.status === "number" && [400, 401, 403, 404, 409, 413, 429].includes(error.status)) return warehouseReply({ ok: false, error: error.message }, error.status);
  return warehouseFailure(error);
}
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal(); if (!principal) return warehouseReply({ ok: false, error: "Sign in to view appliance notes." }, 401);
    const params = request.nextUrl.searchParams;
    const result = params.has("noteId") ? await getWarehouseUnitNote(principal, { noteId: params.get("noteId"), ...(params.has("beforeRevision") ? { beforeRevision: Number(params.get("beforeRevision")) } : {}) })
      : await listWarehouseUnitNotes(principal, { unitId: params.get("unitId"), ...(params.get("afterId") ? { afterId: params.get("afterId") } : {}), includeTombstoned: params.get("includeTombstoned") !== "false" });
    return warehouseReply({ ok: true, result });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal(); if (!principal) return warehouseReply({ ok: false, error: "Sign in to add an appliance note." }, 401);
    return warehouseReply({ ok: true, result: await appendWarehouseUnitNote(principal, await warehouseBody(request, 32_768)) });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const principal = await getPrincipal(); if (!principal) return warehouseReply({ ok: false, error: "Sign in to correct an appliance note." }, 401);
    return warehouseReply({ ok: true, result: await correctWarehouseUnitNote(principal, await warehouseBody(request, 32_768)) });
  } catch (error) { return failure(error); }
}
