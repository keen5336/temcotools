import { NextResponse } from "next/server";
import { z } from "zod";
import { revokeOAuthGrant } from "@/lib/oauth/service";
import { identityFailure } from "@/lib/auth/http";
import { getCurrentPrincipal } from "@/lib/auth";
import { createAccessGrant, listAccessGrants, revokeAccessGrant, GrantError } from "@/lib/application/grants";

export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET() {
  try { const principal = await getCurrentPrincipal(); return principal ? reply({ grants: await listAccessGrants(principal) }) : reply({ error: "Sign in required." }, 401); }
  catch (error) { return identityFailure(error); }
}
export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return reply({ error: "Sign in required." }, 401);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: "Request too large." }, 413);
    return reply(await createAccessGrant(principal, JSON.parse(raw)), 201);
  } catch (error) {
    if (error instanceof GrantError) return reply({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return reply({ error: "Invalid client grant request." }, 400);
    return identityFailure(error);
  }
}
export async function DELETE(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return reply({ error: "Sign in required." }, 401);
  try {
    const params = new URL(request.url).searchParams;
    const input = z.object({ id: z.string().min(1).max(100), kind: z.enum(["stdio", "oauth"]).default("stdio") }).parse({ id: params.get("id"), kind: params.get("kind") ?? undefined });
    return reply(await (input.kind === "oauth" ? revokeOAuthGrant(principal, input.id) : revokeAccessGrant(principal, input.id)));
  } catch (error) { return identityFailure(error); }
}
