import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthorizationError } from "./principal";
import { IdentityError } from "./passwords";

export async function readIdentityJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 16_384) throw new IdentityError("Request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 16_384) throw new IdentityError("Request is too large.", 413);
  try { return JSON.parse(text); } catch { throw new IdentityError("Invalid request."); }
}

export function identityContext(request: Request) {
  // A source hint is a rate-limit bucket, never authentication or identity.
  // The account budget applies even without a qualified proxy source header.
  return { source: (request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown-source").split(",")[0].trim().slice(0, 200) };
}

export function identityReply(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function identityFailure(error: unknown) {
  if (error instanceof IdentityError || error instanceof AuthorizationError) return identityReply({ error: error.message }, error.status);
  if (error instanceof ZodError) return identityReply({ error: "Check the requested account fields." }, 400);
  return identityReply({ error: "Identity service is unavailable. Try again." }, 503);
}
