import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getPrincipal } from "@/lib/auth";
import { advanceOfficeRefresh, getOfficeRefreshStatus } from "@/lib/office/refresh";
import { warehouseBody } from "@/lib/warehouse/http";

export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof ZodError) return reply({ ok: false, error: "Provide a valid bounded Office refresh command." }, 400);
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 401, 403, 404, 409, 413].includes(error.status)) return reply({ ok: false, error: error instanceof Error ? error.message : "Refresh is not allowed." }, error.status);
  return reply({ ok: false, error: "Refresh result is uncertain. Resume with the same page request or reload its saved progress." }, 503);
}
export async function GET() {
  try { const principal = await getPrincipal(); if (!principal) return reply({ ok: false, error: "Sign in to view Office evaluation coverage." }, 401); return reply({ ok: true, result: await getOfficeRefreshStatus(principal) }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { const principal = await getPrincipal(); if (!principal) return reply({ ok: false, error: "Sign in to evaluate Office work." }, 401); return reply({ ok: true, result: await advanceOfficeRefresh(principal, await warehouseBody(request, 8192)) }); }
  catch (error) { return failure(error); }
}
