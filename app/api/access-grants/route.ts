import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/auth";
import { createAccessGrant, listAccessGrants, revokeAccessGrant, GrantError } from "@/lib/application/grants";

export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
export async function GET() {
  const principal = await getCurrentPrincipal();
  return principal ? reply({ grants: await listAccessGrants(principal) }) : reply({ error: "Sign in required." }, 401);
}
export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return reply({ error: "Sign in required." }, 401);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: "Request too large." }, 413);
    return reply(await createAccessGrant(principal, JSON.parse(raw)), 201);
  } catch (error) { return reply({ error: error instanceof GrantError ? error.message : "Invalid client grant request." }, error instanceof GrantError ? error.status : 400); }
}
export async function DELETE(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return reply({ error: "Sign in required." }, 401);
  const input = z.string().min(1).max(100).safeParse(new URL(request.url).searchParams.get("id"));
  return input.success ? reply(await revokeAccessGrant(principal, input.data)) : reply({ error: "Invalid grant." }, 400);
}
