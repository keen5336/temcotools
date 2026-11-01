import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { executeApplicationAction } from "@/lib/application/actions";
export const runtime = "nodejs";
export const maxDuration = 150;
const actions: Record<string, string> = { status: "dmp.status", pair: "dmp.pair", lease: "dmp.lease", request: "dmp.request", disconnect: "dmp.disconnect", receipts: "dmp.receipts", receipt: "dmp.receipt", share: "dmp.share.approve", unshare: "dmp.share.revoke" };
export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in to use DMP relay." }, { status: 401 });
  try {
    const name = actions[(await params).action];
    if (!name) return NextResponse.json({ error: "Unknown action." }, { status: 404 });
    const raw = await request.text(); if (Buffer.byteLength(raw) > 160_000) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    return NextResponse.json(await executeApplicationAction(principal, name, raw ? JSON.parse(raw) : {}), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 503;
    return NextResponse.json({ error: status < 500 && error instanceof Error ? error.message : "DMP relay unavailable. Inspect durable receipts before repeating an operation." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
