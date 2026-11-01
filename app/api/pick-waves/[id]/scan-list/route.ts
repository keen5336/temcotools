import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { PickWaveValidationError } from "@/lib/pick-waves";
import { savePickScanList } from "@/lib/application/pick-actions";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, scanList: await savePickScanList(principal, { id }) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof PickWaveValidationError ? error.message : "Failed to save scan list." },
      { status: error && typeof error === "object" && "status" in error ? Number(error.status) : error instanceof PickWaveValidationError ? 400 : 500 },
    );
  }
}
