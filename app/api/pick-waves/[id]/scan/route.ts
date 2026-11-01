import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCurrentPrincipal } from "@/lib/auth";
import { executeApplicationAction } from "@/lib/application/actions";
import { PickWaveValidationError } from "@/lib/pick-waves";
import { ingestWarehouseScan } from "@/lib/application/scan-ingestion";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.scannedValue !== "string") return NextResponse.json({ ok: false, error: "A scanned value is required." }, { status: 400 });
  try {
    const { id } = await params;
    const receipt = await executeApplicationAction(principal, "warehouse.scan", {
      eventId: body.eventId || randomUUID(), capturedByUserId: principal.userId,
      capturedAt: body.capturedAt || new Date().toISOString(), rawIdentifier: body.scannedValue,
      type: "presence", captureMethod: "scanner", pickWaveId: id,
    }) as Awaited<ReturnType<typeof ingestWarehouseScan>>;
    return NextResponse.json({ ok: true, result: "task" in receipt ? receipt.task : null, observation: receipt.observation, office: receipt.office });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to scan pick wave." }, { status: error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
