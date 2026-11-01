import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getCurrentPrincipal } from "@/lib/auth";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { OfficeError } from "@/lib/office/domain";
import { MarsImportValidationError } from "./import";
import { MarsWorkflowError } from "./service";

export async function marsBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 30 * 1024 * 1024) throw new MarsWorkflowError("Request is too large.", 413);
  const body = await request.text();
  if (Buffer.byteLength(body) > 30 * 1024 * 1024) throw new MarsWorkflowError("Request is too large.", 413);
  if (!body.trim()) return {};
  try { const value = JSON.parse(body); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new MarsWorkflowError("Use a JSON object for this MARS action."); }
}
export function marsOperationId(input: Record<string, unknown>, prefix = "mars") {
  return typeof input.operationId === "string" ? input.operationId : `${prefix}:${randomUUID()}`;
}
export async function marsApi(handler: (principal: Principal) => Promise<object>) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ ok: true, ...await handler(principal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthorizationError || error instanceof OfficeError || error instanceof MarsWorkflowError ? error.status : error instanceof ZodError || error instanceof MarsImportValidationError ? 400 : 503;
    const message = error instanceof ZodError ? "Check the MARS action fields." : error instanceof AuthorizationError || error instanceof OfficeError || error instanceof MarsWorkflowError || error instanceof MarsImportValidationError ? error.message : "MARS service is unavailable. Retain the operation ID and check its receipt before retrying.";
    return NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
