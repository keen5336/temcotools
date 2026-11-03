import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { ingestWarehouseScan } from "@/lib/application/scan-ingestion";
import { z } from "zod";
import { recordFinalsScan } from "@/lib/dispatch/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in as the original operator." }, { status: 401 });
  try {
    const raw = await request.text();
    if (raw.length > 8192) return NextResponse.json({ error: "Scan event too large." }, { status: 413 });
    const input = JSON.parse(raw);
    if ((input.siteId ?? "warehouse-initial") !== principal.siteId) return NextResponse.json({ error: "This observation belongs to another warehouse. Open its originating warehouse to save it." }, { status: 409 });
    let result;
    if (input.finalsSessionId) {
      const finals = await recordFinalsScan(principal, { sessionId: input.finalsSessionId, eventId: input.eventId, lane: input.lane, rawIdentifier: input.rawIdentifier, confirmPlacement: input.confirmPlacement ?? false, capturedAt: input.capturedAt, capturedByUserId: input.capturedByUserId, captureMethod: input.captureMethod, deviceId: input.deviceId });
      result = { finals, observation: finals.observation };
    } else result = await ingestWarehouseScan(principal, input);
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : error && typeof error === "object" && "status" in error ? Number(error.status) : 503;
    return NextResponse.json({ error: status < 500 && error instanceof Error ? error.message : "Observations could not be saved. Retain the device queue and try again." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
