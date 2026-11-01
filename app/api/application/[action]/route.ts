import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { executeApplicationAction } from "@/lib/application/actions";
import { z } from "zod";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    if (Number(request.headers.get("content-length")) > 52_428_800) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 52_428_800) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    const { action } = await context.params;
    return NextResponse.json({ result: await executeApplicationAction(principal, action, JSON.parse(raw)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : error && typeof error === "object" && "status" in error ? Number(error.status) : 503;
    return NextResponse.json({ error: status < 500 && error instanceof Error ? error.message : "The action could not be completed." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
