import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getPrincipal } from "@/lib/auth";
import * as dispatch from "@/lib/dispatch/service";
import { warehouseBody } from "@/lib/warehouse/http";
export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof ZodError) return reply({ ok: false, error: error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, 400);
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 401, 403, 404, 409, 413].includes(error.status)) return reply({ ok: false, error: error instanceof Error ? error.message : "Dispatch action unavailable." }, error.status);
  return reply({ ok: false, error: "Dispatch could not be loaded or saved. Refresh current state before retrying." }, 503);
}
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal(); if (!principal) return reply({ ok: false, error: "Sign in to view dispatch." }, 401);
    const params = request.nextUrl.searchParams;
    const view = params.get("view") || "boards";
    const result = view === "boards" ? await dispatch.listDispatchBoards(principal, { ...(params.get("day") ? { day: params.get("day") } : {}), ...(params.get("afterId") ? { afterId: params.get("afterId") } : {}) })
      : view === "board" ? await dispatch.getDispatchBoard(principal, { boardId: params.get("boardId") })
      : view === "requirements" ? await dispatch.reconcileDispatchRequirements(principal, { snapshotId: params.get("snapshotId") })
      : view === "finals" ? await dispatch.getFinalsSession(principal, { sessionId: params.get("sessionId") })
      : view === "scans" ? await dispatch.getFinalsScanHistory(principal, { sessionId: params.get("sessionId"), ...(params.get("afterId") ? { afterId: params.get("afterId") } : {}) })
      : view === "adapter" ? await dispatch.getDispatchAdapterStatus(principal)
      : (() => { throw new dispatch.DispatchError("Unknown dispatch view.", 404); })();
    return reply({ ok: true, result });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal(); if (!principal) return reply({ ok: false, error: "Sign in to change dispatch." }, 401);
    const body = await warehouseBody(request, 6_000_000); let result;
    switch (body.action) {
      case "snapshot": result = await dispatch.createDispatchSnapshot(principal, body.input); break;
      case "workbook": result = await dispatch.createDispatchWorkbookSnapshot(principal, body.input); break;
      case "approve": result = await dispatch.approveDispatchSnapshot(principal, body.input); break;
      case "allocate": result = await dispatch.allocateDispatchUnit(principal, body.input); break;
      case "release": result = await dispatch.releaseDispatchAllocation(principal, body.input); break;
      case "pick_wave": result = await dispatch.generateDispatchPickWave(principal, body.input); break;
      case "finals": result = await dispatch.createFinalsSession(principal, body.input); break;
      case "scan": result = await dispatch.recordFinalsScan(principal, body.input); break;
      case "review_exception": result = await dispatch.reviewFinalsException(principal, body.input); break;
      case "empty_lane": result = await dispatch.confirmDispatchLaneEmpty(principal, body.input); break;
      case "signoff": result = await dispatch.signOffDispatchLane(principal, body.input); break;
      default: throw new dispatch.DispatchError("Unknown dispatch action.", 404);
    }
    return reply({ ok: true, result });
  } catch (error) { return failure(error); }
}
