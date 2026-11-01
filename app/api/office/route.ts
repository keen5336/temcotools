import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getPrincipal } from "@/lib/auth";
import * as office from "@/lib/office/service";
import { warehouseBody } from "@/lib/warehouse/http";

export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof ZodError) return reply({ ok: false, error: error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, 400);
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 401, 403, 404, 409, 413].includes(error.status)) return reply({ ok: false, error: error instanceof Error ? error.message : "This office action is not allowed." }, error.status);
  return reply({ ok: false, error: "Office work could not be loaded or saved. Review current state before retrying." }, 503);
}
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) return reply({ ok: false, error: "Sign in to view office work." }, 401);
    const params = request.nextUrl.searchParams;
    const unitId = params.get("unitId") || undefined;
    const view = params.get("view") || "cases";
    const result = view === "case" ? await office.getOfficeCase(principal, { caseId: params.get("caseId") })
      : view === "context" ? await office.getOfficeUnitContext(principal, { unitId })
      : view === "people" ? await office.getOfficePeople(principal)
      : view === "returns" ? await office.getExpectedReturnWorklist(principal, { ...(unitId ? { unitIds: [unitId] } : {}), ...(params.get("afterUnitId") ? { afterUnitId: params.get("afterUnitId") } : {}) })
      : view === "cases" ? await office.listOfficeCases(principal, { unitId, status: params.get("status") || "active", ...(params.get("afterId") ? { afterId: params.get("afterId") } : {}) })
      : (() => { throw new office.OfficeError("Unknown office view.", 404); })();
    return reply({ ok: true, result });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getPrincipal();
    if (!principal) return reply({ ok: false, error: "Sign in to perform office actions." }, 401);
    const body = await warehouseBody(request, 32_768);
    const input = body.input;
    let result;
    switch (body.action) {
      case "schedule": result = await office.recordOfficeSchedule(principal, input); break;
      case "exchange": result = await office.createOfficeExchange(principal, input); break;
      case "attempt": result = await office.recordOfficeExchangeAttempt(principal, input); break;
      case "expectation": result = await office.createOfficeReturnExpectation(principal, input); break;
      case "case": result = await office.manageOfficeCase(principal, input); break;
      case "disposition": result = await office.createOfficeDisposition(principal, input); break;
      case "revoke_disposition": result = await office.revokeOfficeDisposition(principal, input); break;
      case "execution": result = await office.recordOfficeDispositionExecution(principal, input); break;
      case "evaluate": result = await office.evaluateOfficeWork(principal, input); break;
      case "review_observation": result = await office.reviewOfficeObservation(principal, input); break;
      default: throw new office.OfficeError("Unknown office action.", 404);
    }
    return reply({ ok: true, result });
  } catch (error) { return failure(error); }
}
